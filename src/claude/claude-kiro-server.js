import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { promises as fs } from 'fs';
import { writeFileSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as http from 'http';
import * as https from 'https';
import { getProviderModels } from '../provider-models.js';
import { countTokens } from '@anthropic-ai/tokenizer';
import { json } from 'stream/consumers';
import { getRedisManager } from '../redis-manager.js';

const KIRO_CONSTANTS = {
    REFRESH_URL: 'https://prod.{{region}}.auth.desktop.kiro.dev/refreshToken',
    REFRESH_IDC_URL: 'https://oidc.{{region}}.amazonaws.com/token',
    DEVICE_AUTH_URL: 'https://oidc.{{region}}.amazonaws.com/device_authorization',
    REGISTER_CLIENT_URL: 'https://oidc.{{region}}.amazonaws.com/client/register',
    BASE_URL: 'https://codewhisperer.{{region}}.amazonaws.com/generateAssistantResponse',
    AMAZON_Q_URL: 'https://codewhisperer.{{region}}.amazonaws.com/SendMessageStreaming',
    USAGE_LIMITS_URL: 'https://q.{{region}}.amazonaws.com/getUsageLimits',
    DEFAULT_MODEL_NAME: 'claude-sonnet-4-20250514',
    AXIOS_TIMEOUT: 120000, // 2 minutes timeout
    USER_AGENT: 'KiroIDE',
    KIRO_VERSION: '0.7.45',  // 仿制Kiro官方客户端最新版本
    CONTENT_TYPE_JSON: 'application/json',
    ACCEPT_JSON: 'application/json',
    AUTH_METHOD_SOCIAL: 'social',
    AUTH_METHOD_IDC: 'IdC',
    CHAT_TRIGGER_TYPE_MANUAL: 'MANUAL',
    ORIGIN_AI_EDITOR: 'AI_EDITOR',
    EXPIRE_WINDOW_MS: 5 * 60 * 1000,  // 官方AWS SDK: 5分钟过期窗口
    REFRESH_DEBOUNCE_MS: 30 * 1000,   // 官方AWS SDK: 30秒防抖
    DEVICE_GRANT_TYPE: 'urn:ietf:params:oauth:grant-type:device_code',

    // Kiro 风格的上下文窗口管理配置（完美复刻官方 extension.js）
    MAX_CONTEXT_TOKENS: 200000,      // Claude 模型最大上下文（200K tokens）
    MAX_CONTEXT_TOKENS_SAFE: 180000, // 安全阈值 90% (200K * 0.9)

    // 文件和内容限制（复刻 Kiro extension.js:649074, 660246）
    MAX_FILE_SERIALIZABLE_CHARACTERS: 30000,  // 单文件最大 30K 字符
    MAX_FILE_COUNT: 30,                       // 最多 30 个文件
    MAX_FILE_LENGTH_CHARS: 300000,            // 所有文件总共 300K 字符
    MAX_OUTPUT_LENGTH: 64000,                 // ReadCode 输出限制 64K
    GREP_MAX_TOTAL_OUTPUT_SIZE: 10000,        // Grep 输出限制 10K
    DIFF_OUTPUT_LIMIT: 8000,                  // Diff 输出限制 8K
    STEERING_REMINDER_BUDGET: 10000,          // Steering 预算 10K

    // Token 估算配置（复刻 Kiro extension.js:672428, 672443）
    CHARS_PER_TOKEN: 4,                       // Claude: 4 字符 = 1 token
    MESSAGE_BASE_TOKENS: 10,                  // 每条消息基础开销 10 tokens
    NEWLINE_TOKENS_FACTOR: 0.5,               // 每个换行符 0.5 tokens
    CODE_BLOCK_TOKENS: 2,                     // 每个代码块标记 2 tokens

    // 上下文管理阈值（复刻 Kiro extension.js:711506-711517）
    CONTEXT_SUMMARIZE_THRESHOLD: 80,          // 80% 时触发摘要
    CONTEXT_TRUNCATE_THRESHOLD: 95,           // 95% 时立即截断
    COMPACTION_THRESHOLD: 0.6,                // 60% 触发压缩（extension.js:672086）

    // 消息历史管理（复刻 Kiro extension.js:161306, 672088）
    MIN_MESSAGES_TO_KEEP: 5,                  // 修剪时保留最后 5 条
    PRESERVE_RECENT_ROUNDS: 2,                // 压缩时保留最近 2 轮
    DEFAULT_TARGET_TOKENS: 8000,              // 压缩目标 8000 tokens
    DEFAULT_COMPRESSION_RATIO: 0.5,           // 压缩比 50%
    MAX_COMPACTION_TIME_MS: 60000,            // 最大压缩时间 60 秒

    MAX_TOOL_DESC_LENGTH: 500,                // 每个工具描述最大 500 字符
    SUMMARIZATION_MODEL: 'claude-sonnet-4-5-20250929',  // 用于生成摘要的模型
};

// Thinking 功能的提示词模板（通过 prompt injection 实现，参考 cifang）
// 优化版本：在简洁和效果之间平衡（~80 tokens）
const THINKING_PROMPT_TEMPLATE = `Before responding, analyze the problem thoroughly inside <thinking>...</thinking> tags:
- Break down complex tasks into clear steps
- Consider edge cases and potential issues
- Verify tool parameters match requirements exactly
Then provide your well-reasoned response.`;


// ============== Kiro 风格的辅助函数（完美复刻官方）==============

// stripImages - 移除图片内容用于 Token 计算（复刻 Kiro extension.js:159671-159676）
function stripImages(content) {
    if (Array.isArray(content)) {
        return content
            .filter(part => part.type === 'text')
            .map(part => part.text || '')
            .join('\n');
    }
    return content;
}

// estimateTokens - Token 估算（复刻 Kiro extension.js:672424-672447）
function estimateTokens(text) {
    if (!text || typeof text !== 'string' || text.length === 0) {
        return 0;
    }

    // 基础 tokens: 4 字符 = 1 token
    const baseTokens = Math.ceil(text.length / KIRO_CONSTANTS.CHARS_PER_TOKEN);

    // 格式 tokens: 每个换行符 0.5 tokens
    const formatTokens = text.length > 0
        ? Math.ceil(text.split('\n').length * KIRO_CONSTANTS.NEWLINE_TOKENS_FACTOR)
        : 0;

    // 代码块 tokens: 每个 ``` 标记 2 tokens
    const codeTokens = (text.match(/```/g) || []).length * KIRO_CONSTANTS.CODE_BLOCK_TOKENS;

    return baseTokens + formatTokens + codeTokens;
}

// estimateMessageTokens - 估算单条消息的 tokens（复刻 Kiro extension.js:672456-672490）
function estimateMessageTokens(message) {
    let totalTokens = KIRO_CONSTANTS.MESSAGE_BASE_TOKENS; // 基础开销

    if (typeof message.content === 'string') {
        totalTokens += estimateTokens(message.content);
    } else if (Array.isArray(message.content)) {
        for (const entry of message.content) {
            if (entry.type === 'text' && entry.text) {
                totalTokens += estimateTokens(entry.text);
            } else if (entry.type === 'tool_use' && entry.input) {
                const toolText = JSON.stringify(entry.input);
                totalTokens += estimateTokens(toolText);
            } else if (entry.type === 'tool_result') {
                if (entry.content) {
                    const resultText = typeof entry.content === 'string'
                        ? entry.content
                        : JSON.stringify(entry.content);
                    totalTokens += estimateTokens(resultText.substring(0, 1000)); // 限制长度
                }
            }
        }
    }

    return totalTokens;
}

// summarizeMessage - 摘要单条消息为前 100 字符（复刻 Kiro extension.js:161275-161280）
function summarizeMessage(content) {
    const text = stripImages(content);
    return `${text.substring(0, 100)}...`;
}


// ============== Kiro 风格的 AI 摘要功能（参考官方 extension.js:711693-711902）==============

// 摘要指令模板（复刻 Kiro getSummarizationInstructions）
const SUMMARIZATION_INSTRUCTIONS = `You are preparing a summary for a new agent instance who will pick up this conversation.

Organize the summary by TASKS/REQUESTS. For each distinct task or request the user made:

For each task:
- **SHORT DESCRIPTION**: Brief description of the task/request
- **STATUS**: done | in-progress | not-started | abandoned
  * Use "in-progress" if ANY work remains, even if partially implemented
  * The most recent task should almost always be "in-progress"
  * Only use "done" if the conversation moved to a completely different task
  * Use "abandoned" when an approach was tried and explicitly discarded (note why in DETAILS)
- **USER QUERIES**: Which user queries relate to this task (reference by content)
- **DETAILS**: Additional context, decisions made, current state
  * Distinguish between what was discussed vs what was actually implemented
  * If only a partial fix or workaround was implemented, state explicitly what's missing
  * Pay extra close attention to the last file that was edited - the agent may have been cut off in the middle of edits
- **NEXT STEPS**: If status is "in-progress", list specific remaining work:
  * Exact files that need changes
  * Specific methods/functions that need to be added or modified
  * Any validation, error handling, or edge cases not yet addressed
- **FILEPATHS**: Files related to this specific task (use \`code\` formatting)

After all tasks, include:
- **USER CORRECTIONS AND INSTRUCTIONS**: Specific instructions or corrections the user gave that apply across tasks

## Example format:

## TASK 1: Implement user authentication
- **STATUS**: done
- **USER QUERIES**: "Add login endpoint", "Hash passwords"
- **DETAILS**: Completed login endpoint with bcrypt hashing. Tested with 'npm test auth'.
- **FILEPATHS**: \`src/auth/login.ts\`, \`src/models/user.ts\`

## TASK 2: Add error handling
- **STATUS**: in-progress
- **USER QUERIES**: "Add validation middleware"
- **DETAILS**: Created basic structure but still need error response formatting.
- **NEXT STEPS**:
  * Add error response formatting in \`src/middleware/validation.ts\`
  * Integrate middleware with routes in \`src/routes/index.ts\`
- **FILEPATHS**: \`src/middleware/validation.ts\`, \`src/routes/index.ts\`

## USER CORRECTIONS AND INSTRUCTIONS:
- Use bcrypt for password hashing
- Run 'npm test auth' to test, not full suite

## Files to read:
- \`src/middleware/validation.ts\`
- \`src/routes/index.ts\`
`;

// 摘要系统提示词（复刻 Kiro getSummarizationPrompt extension.js:711748-711761）
const SUMMARIZATION_SYSTEM_PROMPT = `[SYSTEM NOTE: This is an automated summarization request due to context limit]

IMPORTANT: Context limit reached. You MUST create a structured summary.

Format your response using markdown syntax for better readability:
- Use ## for task headers (e.g., "## TASK 1: Description")
- Use **bold** for field labels (e.g., "**STATUS**:", "**DETAILS**:")
- Use \`code\` formatting for file paths
- Use bullet lists with - for items

${SUMMARIZATION_INSTRUCTIONS}

Review the conversation history and create a comprehensive summary.`;

// 系统内容模式（需要过滤掉的，复刻 Kiro extractUserQueries）
const SYSTEM_CONTENT_PATTERNS = [
    '<EnvironmentContext>',
    '<steering-reminder>',
    '## Included Rules',
    '<ADDITIONAL_INSTRUCTIONS>',
    'Previous conversation summary:',
    '## CONVERSATION SUMMARY',
    'CONTEXT TRANSFER:',
    '[SYSTEM NOTE: This is an automated summarization request',
    'METADATA:\nThe previous conversation had',
    'INSTRUCTIONS:\nContinue working until the user query'
];

// 需要截断输出的工具名（复刻 Kiro extractUsefulInformation）
const TRUNCATE_TOOL_NAMES = [
    'Read', 'ReadFile', 'ReadMultipleFiles',
    'Bash', 'executeBash', 'executePwsh',
    'Grep', 'GrepSearch',
    'Glob', 'LSP'
];

// 检查是否是需要截断的工具
function shouldTruncateToolResult(toolName) {
    if (!toolName) return false;
    // MCP 工具也截断
    if (toolName.startsWith('mcp_')) return true;
    return TRUNCATE_TOOL_NAMES.some(t => toolName.toLowerCase().includes(t.toLowerCase()));
}

// 检查内容是否包含系统注入的模式
function containsSystemContent(text) {
    if (!text) return false;
    return SYSTEM_CONTENT_PATTERNS.some(pattern => text.includes(pattern));
}

// 提取用户查询（复刻 Kiro extractUserQueries）
function extractUserQueries(messages) {
    const userQueries = [];
    let totalLength = 0;
    const maxLength = 10000;

    for (const msg of messages) {
        if (msg.role !== 'user') continue;

        let text = '';
        if (typeof msg.content === 'string') {
            text = msg.content.trim();
        } else if (Array.isArray(msg.content)) {
            text = msg.content
                .filter(c => c.type === 'text')
                .map(c => c.text || '')
                .join('\n')
                .trim();
        }

        // 过滤系统内容
        if (containsSystemContent(text)) continue;

        if (text && totalLength + text.length + 2 <= maxLength) {
            userQueries.push(text);
            totalLength += text.length + 2;
        } else if (totalLength >= maxLength) {
            break;
        }
    }

    if (userQueries.length === 0) return '';
    return '\n\nUSER QUERIES (chronological order):\n' +
        userQueries.map((q, i) => `${i + 1}. ${q}`).join('\n');
}

// 提取有用信息（复刻 Kiro extractUsefulInformation）
function extractUsefulInformation(messages) {
    const sections = [];

    for (const msg of messages) {
        if (typeof msg.content === 'string') {
            const role = msg.role === 'user' ? 'User message' : 'Assistant message';
            sections.push(`${role}: ${msg.content}\n`);
            continue;
        }

        if (!Array.isArray(msg.content)) continue;

        for (const entry of msg.content) {
            if (entry.type === 'text' && entry.text) {
                const role = msg.role === 'user' ? 'User message' : 'Assistant message';
                // 过滤系统内容
                if (msg.role === 'user' && containsSystemContent(entry.text)) continue;
                sections.push(`${role}: ${entry.text}\n`);
            }

            if (entry.type === 'tool_use') {
                const args = entry.input ? JSON.stringify(entry.input).substring(0, 500) : 'no args';
                sections.push(`Tool: ${entry.name || 'unknown'} - ${args}\n`);
            }

            if (entry.type === 'tool_result') {
                const toolName = entry.tool_use_id || '';
                let responseMessage = '';

                // 检查是否需要截断（大型工具输出）
                if (shouldTruncateToolResult(entry.name || toolName)) {
                    responseMessage = ' - Tool response contents truncated for brevity';
                } else if (entry.content) {
                    // 限制工具结果长度
                    const content = typeof entry.content === 'string'
                        ? entry.content
                        : JSON.stringify(entry.content);
                    responseMessage = ` - ${content.substring(0, 300)}`;
                }

                const status = entry.is_error ? 'FAILED' : 'SUCCESS';
                sections.push(`ToolResult: ${status}${responseMessage}\n`);
            }
        }
    }

    return sections.join('\n');
}

// 生成对话摘要的函数（复刻 Kiro _summarizationNode）
async function generateConversationSummary(messages, kiroApiInstance) {
    console.log('[Kiro Summarize] Starting AI summarization...');
    console.log('[Kiro Summarize] Input messages count:', messages.length);

    // 使用 Kiro 风格的提取函数
    const extractedInfo = extractUsefulInformation(messages);
    const userQueries = extractUserQueries(messages);

    console.log('[Kiro Summarize] Extracted info length:', extractedInfo.length, 'chars');

    // 限制总长度避免摘要请求本身超限
    let conversationData = extractedInfo;
    if (conversationData.length > 50000) {
        conversationData = conversationData.substring(0, 50000) + '\n[...truncated for summarization...]';
    }

    const summaryPrompt = `${SUMMARIZATION_SYSTEM_PROMPT}

CONVERSATION DATA TO SUMMARIZE:
${conversationData}
${userQueries}`;

    try {
        // 使用较小的模型生成摘要（更快更便宜）
        const summaryResponse = await kiroApiInstance.sendMessageInternal(
            [{ role: 'user', content: summaryPrompt }],
            null,  // system prompt already in summaryPrompt
            null,  // no tools for summarization
            false, // no streaming
            null,  // no abort signal
            true   // isSummarization flag
        );

        if (summaryResponse && summaryResponse.content) {
            // 添加 user queries 到摘要末尾（和 Kiro 一样）
            const fullSummary = summaryResponse.content + (userQueries || '');
            console.log('[Kiro Summarize] Summary generated successfully');
            console.log('[Kiro Summarize] Summary length:', fullSummary.length, 'chars');
            return fullSummary;
        }
    } catch (error) {
        console.error('[Kiro Summarize] Failed to generate summary:', error.message);
    }
    
    // 降级：如果 AI 摘要失败，使用简单的消息截取
    console.log('[Kiro Summarize] Falling back to simple truncation');
    return null;
}

// 构建带摘要的新消息历史（复刻 Kiro CONTEXT TRANSFER 格式）
function buildMessagesWithSummary(summary, recentMessages, originalMessageCount = 0) {
    // 使用 Kiro 官方的 CONTEXT TRANSFER 格式
    const summaryMessage = {
        role: 'user',
        content: `CONTEXT TRANSFER: We are continuing a conversation that had gotten too long. Here is a summary:

---
${summary}
---

METADATA:
The previous conversation had ${originalMessageCount} messages.

INSTRUCTIONS:
Continue working until the user query has been fully addressed. Do not ask for clarification - proceed with the work based on the context provided.
IMPORTANT: If the summary mentions files to read, you should read those files first to restore context.`
    };

    // 检查 recentMessages 的第一条消息
    // 如果是 assistant 消息，不需要添加 ack，避免重复
    const firstRecentRole = recentMessages.length > 0 ? recentMessages[0].role : null;

    if (firstRecentRole === 'assistant') {
        // recent 以 assistant 开头，直接拼接
        return [summaryMessage, ...recentMessages];
    } else {
        // recent 以 user 开头，需要添加 ack 消息保持交替
        const ackMessage = {
            role: 'assistant',
            content: 'Understood. I have the context from our previous conversation and am ready to continue helping you.'
        };
        return [summaryMessage, ackMessage, ...recentMessages];
    }
}

// pruneChatHistory - 多层消息修剪策略（完美复刻 Kiro extension.js:161281-161340）
function pruneChatHistory(messages, maxTokens = KIRO_CONSTANTS.MAX_CONTEXT_TOKENS_SAFE) {
    // 计算总 tokens
    let totalTokens = messages.reduce((acc, msg) => acc + estimateMessageTokens(msg), 0);

    if (totalTokens <= maxTokens) {
        return messages; // 不需要修剪
    }

    console.log(`[pruneChatHistory] Total tokens: ${totalTokens}, max: ${maxTokens}, pruning...`);

    // 第一步：修剪超长消息（>1/3 上下文）
    // 创建索引映射，避免直接修改 const 引用
    const messageIndices = messages.map((msg, idx) => ({
        message: msg,
        index: idx,
        tokens: estimateTokens(stripImages(msg.content))
    }));
    messageIndices.sort((a, b) => b.tokens - a.tokens);

    const oneThirdContext = maxTokens / 3;
    for (let j = 0; j < messageIndices.length; j++) {
        const item = messageIndices[j];
        const messageTokens = item.tokens;
        if (messageTokens > oneThirdContext && totalTokens > maxTokens) {
            const deltaNeeded = totalTokens - maxTokens;
            const delta = Math.min(deltaNeeded, messageTokens - oneThirdContext);

            // 从顶部修剪
            const content = stripImages(item.message.content);
            const targetTokens = messageTokens - delta;
            const targetChars = targetTokens * KIRO_CONSTANTS.CHARS_PER_TOKEN;
            item.message.content = content.substring(0, targetChars);
            totalTokens -= delta;
        }
    }

    // 第二步：摘要旧消息（保留最后 5 条）
    let i = 0;
    while (totalTokens > maxTokens && i < messages.length - KIRO_CONSTANTS.MIN_MESSAGES_TO_KEEP) {
        const message = messages[i];
        const oldTokens = estimateMessageTokens(message);
        message.content = summarizeMessage(message.content);
        const newTokens = estimateMessageTokens(message);
        totalTokens -= (oldTokens - newTokens);
        i++;
    }

    // 第三步：删除旧消息（保留最后 5 条）
    while (messages.length > KIRO_CONSTANTS.MIN_MESSAGES_TO_KEEP && totalTokens > maxTokens) {
        const removed = messages.shift();
        totalTokens -= estimateMessageTokens(removed);
    }

    // 第四步：继续摘要剩余消息（除了最后一条）
    i = 0;
    while (totalTokens > maxTokens && i < messages.length - 1) {
        const message = messages[i];
        const oldTokens = estimateMessageTokens(message);
        message.content = summarizeMessage(message.content);
        const newTokens = estimateMessageTokens(message);
        totalTokens -= (oldTokens - newTokens);
        i++;
    }

    // 第五步：继续删除（保留最后一条）
    while (messages.length > 1 && totalTokens > maxTokens) {
        const removed = messages.shift();
        totalTokens -= estimateMessageTokens(removed);
    }

    // 最终：修剪最后一条消息
    if (totalTokens > maxTokens && messages.length > 0) {
        const lastMessage = messages[0];
        const content = stripImages(lastMessage.content);
        const targetChars = maxTokens * KIRO_CONSTANTS.CHARS_PER_TOKEN;
        lastMessage.content = content.substring(0, targetChars);
    }

    console.log(`[pruneChatHistory] After pruning: ${messages.length} messages, ~${totalTokens} tokens`);
    return messages;
}

// removeEmptyUserMessages - 移除空的用户消息（复刻 Kiro extension.js:706661-706678）
function removeEmptyUserMessages(messages) {
    if (messages.length <= 1) {
        return messages;
    }

    // 保留第一条用户消息（即使为空）
    const firstUserMessageIndex = messages.findIndex(msg => msg.role === 'user');

    return messages.filter((message, index) => {
        // 保留所有 assistant 消息
        if (message.role === 'assistant') {
            return true;
        }

        // 保留第一条用户消息
        if (message.role === 'user' && index === firstUserMessageIndex) {
            return true;
        }

        // 其他用户消息：必须有内容或工具结果
        if (message.role === 'user') {
            const hasContent = message.content &&
                (typeof message.content === 'string' ? message.content.trim() !== '' : message.content.length > 0);
            const hasToolResults = Array.isArray(message.content) &&
                message.content.some(part => part.type === 'tool_result');
            return hasContent || hasToolResults;
        }

        return true;
    });
}

// ensureValidToolUsesAndResults - 确保工具调用有对应结果（复刻 Kiro extension.js:706586-706617）
function ensureValidToolUsesAndResults(messages) {
    const result = [];

    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        result.push(message);

        // 检查 assistant 消息是否有工具调用
        if (message.role === 'assistant' && Array.isArray(message.content)) {
            const toolUses = message.content.filter(part => part.type === 'tool_use');

            if (toolUses.length > 0) {
                const nextMessage = i + 1 < messages.length ? messages[i + 1] : null;

                // 检查下一条消息是否有对应的工具结果
                const hasToolResults = nextMessage &&
                    nextMessage.role === 'user' &&
                    Array.isArray(nextMessage.content) &&
                    nextMessage.content.some(part => part.type === 'tool_result');

                if (!hasToolResults) {
                    // 没有工具结果，添加失败的工具结果消息
                    const failedToolResults = toolUses.map(toolUse => ({
                        type: 'tool_result',
                        tool_use_id: toolUse.id,
                        content: 'Tool execution failed',
                        is_error: true
                    }));

                    result.push({
                        role: 'user',
                        content: failedToolResults
                    });

                    console.log(`[ensureValidToolUsesAndResults] Added ${failedToolResults.length} failed tool results`);
                }
            }
        }
    }

    return result;
}

// handleDanglingToolCall - 处理悬挂的工具调用（复刻 Kiro extension.js:715504-715532）
function handleDanglingToolCall(messages) {
    if (!messages || messages.length === 0) {
        return messages;
    }

    const lastMessage = messages[messages.length - 1];

    // 检查最后一条消息是否是 assistant 且有工具调用
    if (lastMessage.role === 'assistant' && Array.isArray(lastMessage.content)) {
        const toolUses = lastMessage.content.filter(part => part.type === 'tool_use');

        if (toolUses.length > 0) {
            // 添加中止的工具响应
            const abortedToolResults = toolUses.map(toolUse => ({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: 'The tool invoke was aborted by the user.',
                is_error: true
            }));

            messages.push({
                role: 'user',
                content: abortedToolResults
            });

            console.log(`[handleDanglingToolCall] Added ${abortedToolResults.length} aborted tool results`);
        }
    }

    return messages;
}

// sanitizeConversationAdvanced - 高级消息验证和修复（复刻 Kiro extension.js:706680-706688）
function sanitizeConversationAdvanced(messages) {
    let sanitized = [...messages];

    // 步骤1: 确保以用户消息开始
    if (sanitized.length === 0 || sanitized[0].role !== 'user') {
        sanitized.unshift({
            role: 'user',
            content: 'Hello'
        });
    }

    // 步骤2: 移除空的用户消息
    sanitized = removeEmptyUserMessages(sanitized);

    // 步骤3: 确保工具调用有对应结果
    sanitized = ensureValidToolUsesAndResults(sanitized);

    // 步骤4: 确保消息交替
    const alternating = [sanitized[0]];
    for (let i = 1; i < sanitized.length; i++) {
        const prev = alternating[alternating.length - 1];
        const curr = sanitized[i];

        if (prev.role === curr.role) {
            // 插入对应的填充消息
            if (prev.role === 'user') {
                alternating.push({
                    role: 'assistant',
                    content: 'understood'
                });
            } else {
                alternating.push({
                    role: 'user',
                    content: 'Continue'
                });
            }
        }
        alternating.push(curr);
    }

    // 步骤5: 确保以用户消息结束
    if (alternating.length > 0 && alternating[alternating.length - 1].role !== 'user') {
        alternating.push({
            role: 'user',
            content: 'Continue'
        });
    }

    return alternating;
}

// ============== End Kiro 风格 AI 摘要功能 ==============

// Kiro 优化：HTML 转义字符处理（完美复刻官方 Kiro extension.js:578020-578035）
function unescapeHTML(str) {
    if (!str || typeof str !== 'string') return str;

    // 官方 Kiro 的转义映射表（支持十进制和十六进制）
    const escapeMap = {
        // 官方支持的十进制格式
        '&amp;': '&',
        '&#38;': '&',
        '&lt;': '<',
        '&#60;': '<',
        '&gt;': '>',
        '&#62;': '>',
        '&apos;': "'",
        '&#39;': "'",
        '&quot;': '"',
        '&#34;': '"',
        // 额外支持的十六进制格式（更全面）
        '&#x27;': "'",
        '&#x60;': '`',
        '&#x2F;': '/',
        '&#x5C;': '\\'
    };

    // 匹配所有支持的转义格式
    return str.replace(/&(?:amp|#38|#x26|lt|#60|#x3C|gt|#62|#x3E|apos|#39|#x27|quot|#34|#x22|#x60|#x2F|#x5C);/gi, match => escapeMap[match.toLowerCase()] || match);
}

// Kiro 优化：Zod Schema 检测（从官方 Kiro extension.js:644913 提取）
function isZodSchema(schema) {
    if (typeof schema !== "object" || schema === null) {
        return false;
    }

    // 检查 Zod v3 格式
    if ("_def" in schema && !("_zod" in schema)) {
        const def = schema._def;
        return typeof def === "object" && def != null && "typeName" in def;
    }

    // 检查 Zod v4 格式（向前兼容）
    if ("_zod" in schema) {
        const zod = schema._zod;
        return typeof zod === "object" && zod !== null && "def" in zod;
    }

    return false;
}

// Kiro 优化：图片格式自动检测（从官方 Kiro extension.js:707760 提取）
function detectImageFormat(imageUrl) {
    if (!imageUrl || typeof imageUrl !== 'string') {
        return 'jpeg';  // 默认 JPEG
    }

    // 从 base64 data URL 的 header 中检测格式
    const base64Header = imageUrl.split(',')[0];

    if (base64Header.includes('png')) {
        return 'png';
    } else if (base64Header.includes('gif')) {
        return 'gif';
    } else if (base64Header.includes('webp')) {
        return 'webp';
    } else {
        return 'jpeg';  // 默认 JPEG
    }
}

// 从 provider-models.js 获取支持的模型列表
const KIRO_MODELS = getProviderModels('claude-kiro-oauth');

// 完整的模型映射表 - Anthropic官方模型ID到AWS CodeWhisperer模型ID
// 注意：AWS CodeWhisperer模型ID使用点号分隔版本号（如claude-opus-4.5）
const FULL_MODEL_MAPPING = {
    // Opus 4.5 映射（AWS使用点号格式）
    "claude-opus-4-5": "claude-opus-4.5",
    "claude-opus-4-5-20251101": "claude-opus-4.5",
    "claude-opus-4-20250514": "claude-opus-4.5",
    "claude-opus-4-0": "claude-opus-4.5",
    // Haiku 4.5 映射（AWS使用点号格式）
    "claude-haiku-4-5": "claude-haiku-4.5",
    "claude-haiku-4-5-20251001": "claude-haiku-4.5",
    // Sonnet 4.5 映射（AWS使用大写V1_0格式）
    "claude-sonnet-4-5": "CLAUDE_SONNET_4_5_20250929_V1_0",
    "claude-sonnet-4-5-20250929": "CLAUDE_SONNET_4_5_20250929_V1_0",
    // Sonnet 4.0 映射（AWS使用大写V1_0格式）
    "claude-sonnet-4-20250514": "CLAUDE_SONNET_4_20250514_V1_0",
    "CLAUDE_SONNET_4_20250514_V1_0": "CLAUDE_SONNET_4_20250514_V1_0"
};

// 只保留 KIRO_MODELS 中存在的模型映射
const MODEL_MAPPING = Object.fromEntries(
    Object.entries(FULL_MODEL_MAPPING).filter(([key]) => KIRO_MODELS.includes(key))
);

const KIRO_AUTH_TOKEN_FILE = "kiro-auth-token.json";

// 官方AWS SDK：模块级别的防抖变量，按refreshToken分组（不同账号可以并发刷新）
// 使用Map存储每个refreshToken的防抖状态
const refreshTokenDebounceMap = new Map(); // key: refreshToken, value: { lastAttemptTime, promise }

/**
 * Kiro API Service - Node.js implementation based on the Python ki2api
 * Provides OpenAI-compatible API for Claude Sonnet 4 via Kiro/CodeWhisperer
 */

/**
 * 生成随机的 MAC 地址哈希（用于设备指纹随机化）
 * 每次调用生成不同的虚拟设备指纹，降低批量注册检测风险
 */
async function getMacAddressSha256() {
    // 生成随机的虚拟 MAC 地址（格式: xx:xx:xx:xx:xx:xx）
    const randomMac = Array.from({ length: 6 }, () =>
        Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
    ).join(':');

    const sha256Hash = crypto.createHash('sha256').update(randomMac).digest('hex');
    return sha256Hash;
}

/**
 * 生成随机化的 User-Agent 组件
 */
function generateRandomUserAgentComponents() {
    // 随机 Windows 版本
    const winVersions = ['10.0.19041', '10.0.19042', '10.0.19043', '10.0.19044', '10.0.19045',
                         '10.0.22000', '10.0.22621', '10.0.22631', '10.0.26100'];
    const randomWinVersion = winVersions[Math.floor(Math.random() * winVersions.length)];

    // 随机 Node.js 版本
    const nodeVersions = ['18.17.0', '18.18.0', '18.19.0', '20.10.0', '20.11.0', '20.12.0',
                          '22.0.0', '22.1.0', '22.2.0', '22.11.0', '22.12.0', '22.21.1'];
    const randomNodeVersion = nodeVersions[Math.floor(Math.random() * nodeVersions.length)];

    // 随机 SDK 版本
    const sdkVersions = ['1.0.24', '1.0.25', '1.0.26', '1.0.27', '1.0.28'];
    const randomSdkVersion = sdkVersions[Math.floor(Math.random() * sdkVersions.length)];

    // 随机 Kiro 版本
    const kiroVersions = ['0.7.40', '0.7.41', '0.7.42', '0.7.43', '0.7.44', '0.7.45', '0.7.46'];
    const randomKiroVersion = kiroVersions[Math.floor(Math.random() * kiroVersions.length)];

    // 随机 OS 类型
    const osTypes = ['win32', 'darwin', 'linux'];
    const randomOs = osTypes[Math.floor(Math.random() * osTypes.length)];

    return {
        winVersion: randomWinVersion,
        nodeVersion: randomNodeVersion,
        sdkVersion: randomSdkVersion,
        kiroVersion: randomKiroVersion,
        osType: randomOs
    };
}

// Helper functions for tool calls and JSON parsing

/**
 * 通用的括号匹配函数 - 支持多种括号类型
 * @param {string} text - 要搜索的文本
 * @param {number} startPos - 起始位置
 * @param {string} openChar - 开括号字符 (默认 '[')
 * @param {string} closeChar - 闭括号字符 (默认 ']')
 * @returns {number} 匹配的闭括号位置，未找到返回 -1
 */
function findMatchingBracket(text, startPos, openChar = '[', closeChar = ']') {
    if (!text || startPos >= text.length || text[startPos] !== openChar) {
        return -1;
    }

    let bracketCount = 1;
    let inString = false;
    let escapeNext = false;

    for (let i = startPos + 1; i < text.length; i++) {
        const char = text[i];

        if (escapeNext) {
            escapeNext = false;
            continue;
        }

        if (char === '\\' && inString) {
            escapeNext = true;
            continue;
        }

        if (char === '"' && !escapeNext) {
            inString = !inString;
            continue;
        }

        if (!inString) {
            if (char === openChar) {
                bracketCount++;
            } else if (char === closeChar) {
                bracketCount--;
                if (bracketCount === 0) {
                    return i;
                }
            }
        }
    }
    return -1;
}


/**
 * 尝试修复常见的 JSON 格式问题
 * @param {string} jsonStr - 可能有问题的 JSON 字符串
 * @returns {string} 修复后的 JSON 字符串
 */
function repairJson(jsonStr) {
    let repaired = jsonStr;
    // 移除尾部逗号
    repaired = repaired.replace(/,\s*([}\]])/g, '$1');
    // 为未引用的键添加引号
    repaired = repaired.replace(/([{,]\s*)([a-zA-Z0-9_]+?)\s*:/g, '$1"$2":');
    // 确保字符串值被正确引用
    repaired = repaired.replace(/:\s*([a-zA-Z0-9_]+)(?=[,\}\]])/g, ':"$1"');
    return repaired;
}

/**
 * 解析单个工具调用文本
 * @param {string} toolCallText - 工具调用文本
 * @returns {Object|null} 解析后的工具调用对象或 null
 */
function parseSingleToolCall(toolCallText) {
    const namePattern = /\[Called\s+(\w+)\s+with\s+args:/i;
    const nameMatch = toolCallText.match(namePattern);

    if (!nameMatch) {
        return null;
    }

    const functionName = nameMatch[1].trim();
    const argsStartMarker = "with args:";
    const argsStartPos = toolCallText.toLowerCase().indexOf(argsStartMarker.toLowerCase());

    if (argsStartPos === -1) {
        return null;
    }

    const argsStart = argsStartPos + argsStartMarker.length;
    const argsEnd = toolCallText.lastIndexOf(']');

    if (argsEnd <= argsStart) {
        return null;
    }

    const jsonCandidate = toolCallText.substring(argsStart, argsEnd).trim();

    try {
        const repairedJson = repairJson(jsonCandidate);
        const argumentsObj = JSON.parse(repairedJson);

        if (typeof argumentsObj !== 'object' || argumentsObj === null) {
            return null;
        }

        const toolCallId = `call_${uuidv4().replace(/-/g, '').substring(0, 8)}`;
        return {
            id: toolCallId,
            type: "function",
            function: {
                name: functionName,
                arguments: JSON.stringify(argumentsObj)
            }
        };
    } catch (e) {
        console.error(`Failed to parse tool call arguments: ${e.message}`, jsonCandidate);
        return null;
    }
}

function parseBracketToolCalls(responseText) {
    if (!responseText || !responseText.includes("[Called")) {
        return null;
    }

    const toolCalls = [];
    const callPositions = [];
    let start = 0;
    while (true) {
        const pos = responseText.indexOf("[Called", start);
        if (pos === -1) {
            break;
        }
        callPositions.push(pos);
        start = pos + 1;
    }

    for (let i = 0; i < callPositions.length; i++) {
        const startPos = callPositions[i];
        let endSearchLimit;
        if (i + 1 < callPositions.length) {
            endSearchLimit = callPositions[i + 1];
        } else {
            endSearchLimit = responseText.length;
        }

        const segment = responseText.substring(startPos, endSearchLimit);
        const bracketEnd = findMatchingBracket(segment, 0);

        let toolCallText;
        if (bracketEnd !== -1) {
            toolCallText = segment.substring(0, bracketEnd + 1);
        } else {
            // Fallback: if no matching bracket, try to find the last ']' in the segment
            const lastBracket = segment.lastIndexOf(']');
            if (lastBracket !== -1) {
                toolCallText = segment.substring(0, lastBracket + 1);
            } else {
                continue; // Skip this one if no closing bracket found
            }
        }
        
        const parsedCall = parseSingleToolCall(toolCallText);
        if (parsedCall) {
            toolCalls.push(parsedCall);
        }
    }
    return toolCalls.length > 0 ? toolCalls : null;
}

function deduplicateToolCalls(toolCalls) {
    const seen = new Set();
    const uniqueToolCalls = [];

    for (const tc of toolCalls) {
        const key = `${tc.function.name}-${tc.function.arguments}`;
        if (!seen.has(key)) {
            seen.add(key);
            uniqueToolCalls.push(tc);
        } else {
            console.log(`Skipping duplicate tool call: ${tc.function.name}`);
        }
    }
    return uniqueToolCalls;
}

export class KiroApiService {
    constructor(config = {}) {
        this.isInitialized = false;
        this.config = config;
        this.credPath = config.KIRO_OAUTH_CREDS_DIR_PATH || path.join(os.homedir(), ".aws", "sso", "cache");
        this.credsBase64 = config.KIRO_OAUTH_CREDS_BASE64;
        this.useSystemProxy = config?.USE_SYSTEM_PROXY_KIRO ?? false;
        console.log(`[Kiro] System proxy ${this.useSystemProxy ? 'enabled' : 'disabled'}`);

        // Add kiro-oauth-creds-base64 and kiro-oauth-creds-file to config
        if (config.KIRO_OAUTH_CREDS_BASE64) {
            try {
                const decodedCreds = Buffer.from(config.KIRO_OAUTH_CREDS_BASE64, 'base64').toString('utf8');
                const parsedCreds = JSON.parse(decodedCreds);
                // Store parsedCreds to be merged in initializeAuth
                this.base64Creds = parsedCreds;
                console.info('[Kiro] Successfully decoded Base64 credentials in constructor.');
            } catch (error) {
                console.error(`[Kiro] Failed to parse Base64 credentials in constructor: ${error.message}`);
            }
        } else if (config.KIRO_OAUTH_CREDS_FILE_PATH) {
            this.credsFilePath = config.KIRO_OAUTH_CREDS_FILE_PATH;
        }

        this.modelName = KIRO_CONSTANTS.DEFAULT_MODEL_NAME;
        this.axiosInstance = null; // Initialize later in async method

        // Redis 缓存管理器
        this.redis = getRedisManager({
            enabled: config.REDIS_ENABLED !== false,
            host: config.REDIS_HOST,
            port: config.REDIS_PORT,
            password: config.REDIS_PASSWORD,
            db: config.REDIS_DB
        });

        // Kiro 风格 AI 摘要功能的状态变量
        this.lastContextUsagePercentage = 0;  // 上次 AWS 返回的上下文使用率
        this.summarizationInProgress = false;  // 防止并发摘要
        this.lastSummarizationTime = 0;  // 上次摘要时间戳（避免频繁摘要）
    }

    async initialize(skipAuthCheck = false) {
        if (this.isInitialized) return;
        console.log('[Kiro] Initializing Kiro API Service...');

        // 初始化 Redis
        await this.redis.initialize();

        if (!skipAuthCheck) {
            await this.initializeAuth();
        }

        // 生成随机化的设备指纹
        const macSha256 = await getMacAddressSha256();
        const uaComponents = generateRandomUserAgentComponents();

        // 配置 HTTP/HTTPS agent 限制连接池大小，避免资源泄漏
        const httpAgent = new http.Agent({
            keepAlive: true,
            maxSockets: 100,        // 每个主机最多 10 个连接
            maxFreeSockets: 5,     // 最多保留 5 个空闲连接
            timeout: 120000,        // 空闲连接 60 秒后关闭
        });
        const httpsAgent = new https.Agent({
            keepAlive: true,
            maxSockets: 100,
            maxFreeSockets: 5,
            timeout: 120000,
        });

        // 构建随机化的 User-Agent
        const randomizedUserAgent = `aws-sdk-js/${uaComponents.sdkVersion} ua/2.1 os/${uaComponents.osType}#${uaComponents.winVersion} lang/js md/nodejs#${uaComponents.nodeVersion} api/codewhispererstreaming#${uaComponents.sdkVersion} m/N,E KiroIDE-${uaComponents.kiroVersion}-${macSha256}`;
        const randomizedAmzUserAgent = `aws-sdk-js/${uaComponents.sdkVersion} KiroIDE-${uaComponents.kiroVersion}-${macSha256}`;

        // 随机化请求重试次数
        const maxRetries = 2 + Math.floor(Math.random() * 3); // 2-4

        const axiosConfig = {
            timeout: KIRO_CONSTANTS.AXIOS_TIMEOUT,
            httpAgent,
            httpsAgent,
            headers: {
                'Content-Type': KIRO_CONSTANTS.CONTENT_TYPE_JSON,
                'Accept': KIRO_CONSTANTS.ACCEPT_JSON,
                'amz-sdk-request': `attempt=1; max=${maxRetries}`,
                'x-amzn-kiro-agent-mode': 'vibe',
                'x-amz-user-agent': randomizedAmzUserAgent,
                'user-agent': randomizedUserAgent
            },
        };
        
        // 根据 useSystemProxy 配置代理设置
        if (!this.useSystemProxy) {
            axiosConfig.proxy = false;
        }
        
        this.axiosInstance = axios.create(axiosConfig);
        this.isInitialized = true;
    }

// Helper to save credentials to a file (class method)
    async _saveCredentialsToFile(filePath, newData) {
        try {
            let existingData = {};
            try {
                const fileContent = await fs.readFile(filePath, 'utf8');
                existingData = JSON.parse(fileContent);
            } catch (readError) {
                if (readError.code === 'ENOENT') {
                    console.debug(`[Kiro Auth] Token file not found, creating new one: ${filePath}`);
                } else {
                    console.warn(`[Kiro Auth] Could not read existing token file ${filePath}: ${readError.message}`);
                }
            }
            const mergedData = { ...existingData, ...newData };
            await fs.writeFile(filePath, JSON.stringify(mergedData, null, 2), 'utf8');
            console.info(`[Kiro Auth] Updated token file: ${filePath}`);

            // 同时缓存到 Redis
            const providerId = path.basename(filePath, path.extname(filePath));
            await this.redis.cacheToken(providerId, mergedData);
        } catch (error) {
            console.error(`[Kiro Auth] Failed to write token to file ${filePath}: ${error.message}`);
        }
    }

async initializeAuth(forceRefresh = false) {
    if (this.accessToken && !forceRefresh) {
        console.debug('[Kiro Auth] Access token already available and not forced refresh.');
        return;
    }

    // Helper to load credentials from a file (with Redis cache)
    const loadCredentialsFromFile = async (filePath) => {
        // 先尝试从 Redis 读取
        const providerId = path.basename(filePath, path.extname(filePath));
        const cachedToken = await this.redis.getToken(providerId);
        if (cachedToken) {
            console.log(`[Kiro Auth] Loaded token from Redis cache: ${providerId}`);
            return cachedToken;
        }

        // Redis 未命中，从文件读取
        try {
            const fileContent = await fs.readFile(filePath, 'utf8');
            const data = JSON.parse(fileContent);

            // 缓存到 Redis
            await this.redis.cacheToken(providerId, data);

            return data;
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.debug(`[Kiro Auth] Credential file not found: ${filePath}`);
            } else if (error instanceof SyntaxError) {
                console.warn(`[Kiro Auth] Failed to parse JSON from ${filePath}: ${error.message}`);
            } else {
                console.warn(`[Kiro Auth] Failed to read credential file ${filePath}: ${error.message}`);
            }
            return null;
        }
    };

    try {
        let mergedCredentials = {};

        // Priority 1: Load from Base64 credentials if available
        if (this.base64Creds) {
            Object.assign(mergedCredentials, this.base64Creds);
            console.info('[Kiro Auth] Successfully loaded credentials from Base64 (constructor).');
            // Clear base64Creds after use to prevent re-processing
            this.base64Creds = null;
        }

        // Priority 2 & 3 合并: 从指定文件路径或目录加载凭证
        // 读取指定的 credPath 文件以及目录下的其他 JSON 文件(排除当前文件)
        const targetFilePath = this.credsFilePath || path.join(this.credPath, KIRO_AUTH_TOKEN_FILE);
        const dirPath = path.dirname(targetFilePath);
        const targetFileName = path.basename(targetFilePath);
        
        console.debug(`[Kiro Auth] Attempting to load credentials from directory: ${dirPath}`);
        
        try {
            // 首先尝试读取目标文件
            const targetCredentials = await loadCredentialsFromFile(targetFilePath);
            if (targetCredentials) {
                Object.assign(mergedCredentials, targetCredentials);
                console.info(`[Kiro Auth] Successfully loaded OAuth credentials from ${targetFilePath}`);
            }

            // 注意：不再从同目录其他文件合并凭据
            // 之前的逻辑会导致多账号凭据互相覆盖的问题
        } catch (error) {
            console.warn(`[Kiro Auth] Error loading credentials from directory ${dirPath}: ${error.message}`);
        }

        // console.log('[Kiro Auth] Merged credentials:', mergedCredentials);
        // Apply loaded credentials, prioritizing existing values if they are not null/undefined
        this.accessToken = this.accessToken || mergedCredentials.accessToken;
        this.refreshToken = this.refreshToken || mergedCredentials.refreshToken;
        this.clientId = this.clientId || mergedCredentials.clientId;
        this.clientSecret = this.clientSecret || mergedCredentials.clientSecret;
        this.authMethod = this.authMethod || mergedCredentials.authMethod;
        this.expiresAt = this.expiresAt || mergedCredentials.expiresAt;
        this.profileArn = this.profileArn || mergedCredentials.profileArn;
        this.region = this.region || mergedCredentials.region;

        // Ensure region is set before using it in URLs
        if (!this.region) {
            console.log('[Kiro Auth] Region not found in credentials. Using default region us-east-1 for URLs.');
            this.region = 'us-east-1'; // Set default region
        }

        this.refreshUrl = KIRO_CONSTANTS.REFRESH_URL.replace("{{region}}", this.region);
        this.refreshIDCUrl = KIRO_CONSTANTS.REFRESH_IDC_URL.replace("{{region}}", this.region);
        this.baseUrl = KIRO_CONSTANTS.BASE_URL.replace("{{region}}", this.region);
        this.amazonQUrl = KIRO_CONSTANTS.AMAZON_Q_URL.replace("{{region}}", this.region);
    } catch (error) {
        console.warn(`[Kiro Auth] Error during credential loading: ${error.message}`);
    }

    // 官方AWS SDK刷新逻辑：只在必要时刷新
    if (forceRefresh || (!this.accessToken && this.refreshToken)) {
        await this.refreshAccessTokenIfNeeded();
    }

    if (!this.accessToken) {
        throw new Error('No access token available after initialization and refresh attempts.');
    }
}

    /**
     * 官方AWS SDK token刷新逻辑（完全仿制）
     * 参考：@aws-sdk/token-providers/dist-cjs/fromSso.js
     */
    async refreshAccessTokenIfNeeded() {
        if (!this.refreshToken) {
            throw new Error('No refresh token available');
        }

        // 获取或创建此refreshToken的防抖状态
        let debounceState = refreshTokenDebounceMap.get(this.refreshToken);
        if (!debounceState) {
            debounceState = { lastAttemptTime: new Date(0), promise: null };
            refreshTokenDebounceMap.set(this.refreshToken, debounceState);
        }

        // 官方AWS SDK：如果该refreshToken的刷新正在进行，等待完成
        if (debounceState.promise) {
            console.log('[Kiro Auth] Token refresh already in progress for this account, waiting...');
            return await debounceState.promise;
        }

        // 检查token是否在过期窗口内（5分钟）
        const expiresAt = new Date(this.expiresAt).getTime();
        const currentTime = Date.now();
        const timeUntilExpiry = expiresAt - currentTime;

        // 官方逻辑：如果还有超过5分钟才过期，不刷新
        if (timeUntilExpiry > KIRO_CONSTANTS.EXPIRE_WINDOW_MS) {
            // 减少日志输出以提升性能（仅在调试时启用）
            // console.log(`[Kiro Auth] Token still valid for ${Math.floor(timeUntilExpiry / 1000 / 60)} minutes, no refresh needed`);
            return;
        }

        // 官方逻辑：30秒防抖，避免同一账号频繁刷新
        const timeSinceLastRefresh = currentTime - debounceState.lastAttemptTime.getTime();
        if (timeSinceLastRefresh < KIRO_CONSTANTS.REFRESH_DEBOUNCE_MS) {
            console.log(`[Kiro Auth] Refresh attempted ${Math.floor(timeSinceLastRefresh / 1000)}s ago for this account, skipping (debounce)`);
            // 如果token已过期但在防抖期内，抛出错误提示重新登录
            if (timeUntilExpiry <= 0) {
                throw new Error('Token is expired. Please refresh SSO session.');
            }
            return;
        }

        // 记录本次刷新尝试时间（仅此账号）
        debounceState.lastAttemptTime = new Date();

        // 创建刷新Promise，防止该账号并发刷新
        debounceState.promise = this._doRefreshToken();

        try {
            await debounceState.promise;
        } finally {
            debounceState.promise = null;
        }
    }

    /**
     * 实际执行token刷新的内部方法
     */
    async _doRefreshToken() {
        if (!this.refreshToken) {
            throw new Error('No refresh token available to refresh access token.');
        }

        try {
            const requestBody = {
                refreshToken: this.refreshToken,
            };

            let refreshUrl = this.refreshUrl;
            if (this.authMethod !== KIRO_CONSTANTS.AUTH_METHOD_SOCIAL) {
                refreshUrl = this.refreshIDCUrl;
                requestBody.clientId = this.clientId;
                requestBody.clientSecret = this.clientSecret;
                requestBody.grantType = 'refresh_token';
            }

            console.log('[Kiro Auth] Refreshing access token...');
            console.log('[Kiro Auth] Refresh URL:', refreshUrl);
            console.log('[Kiro Auth] Auth method:', this.authMethod);
            console.log('[Kiro Auth] Request body keys:', Object.keys(requestBody));

            const response = await this.axiosInstance.post(refreshUrl, requestBody);
            console.log('[Kiro Auth] Token refresh response status:', response.status);
            console.log('[Kiro Auth] Token refresh response data keys:', Object.keys(response.data || {}));
            console.log('[Kiro Auth] Token refresh response data:', JSON.stringify(response.data, null, 2));

            if (response.data && response.data.accessToken) {
                this.accessToken = response.data.accessToken;
                this.refreshToken = response.data.refreshToken || this.refreshToken;
                this.profileArn = response.data.profileArn || this.profileArn;

                // 处理 expiresIn 可能为 undefined 的情况
                const expiresIn = response.data.expiresIn;
                let expiresAt;
                if (expiresIn !== undefined && expiresIn !== null) {
                    expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
                } else if (response.data.expiresAt) {
                    // 如果返回的是 expiresAt 而不是 expiresIn
                    expiresAt = response.data.expiresAt;
                } else {
                    // 默认1小时过期
                    console.warn('[Kiro Auth] No expiresIn or expiresAt in response, using default 1 hour');
                    expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
                }
                this.expiresAt = expiresAt;
                console.info('[Kiro Auth] Access token refreshed successfully');
                console.info('[Kiro Auth] New expiresAt:', expiresAt);

                // Update the token file
                const tokenFilePath = this.credsFilePath || path.join(this.credPath, KIRO_AUTH_TOKEN_FILE);
                const updatedTokenData = {
                    accessToken: this.accessToken,
                    refreshToken: this.refreshToken,
                    expiresAt: expiresAt,
                };
                if (this.profileArn) {
                    updatedTokenData.profileArn = this.profileArn;
                }
                await this._saveCredentialsToFile(tokenFilePath, updatedTokenData);

                // 如果是主账号refresh成功，同步到pool账号（因为它们是同一个AWS账号）
                // 这样pool账号也能使用最新的token
                if (tokenFilePath.includes('.aws\\sso\\cache')) {
                    const poolFiles = [
                        path.join(this.credPath, 'kiro-auth-token-1.json'),
                        path.join(this.credPath, 'kiro-auth-token-2.json'),
                        path.join(this.credPath, 'kiro-auth-token-3.json')
                    ];

                    for (const poolFile of poolFiles) {
                        try {
                            // 读取pool文件，保留provider信息
                            let poolData = {};
                            try {
                                const existingContent = await fs.readFile(poolFile, 'utf8');
                                poolData = JSON.parse(existingContent);
                            } catch (e) {
                                // 文件不存在或无法读取，使用空对象
                            }

                            // 合并新token和原有的provider信息
                            const syncedData = {
                                ...poolData,
                                ...updatedTokenData,
                                authMethod: poolData.authMethod || updatedTokenData.authMethod,
                                provider: poolData.provider || updatedTokenData.provider
                            };

                            await this._saveCredentialsToFile(poolFile, syncedData);
                            console.log(`[Kiro Auth] Synced token to pool file: ${path.basename(poolFile)}`);
                        } catch (syncError) {
                            console.warn(`[Kiro Auth] Failed to sync to ${path.basename(poolFile)}: ${syncError.message}`);
                        }
                    }
                }
            } else {
                throw new Error('Invalid refresh response: Missing accessToken');
            }
        } catch (error) {
            console.error('[Kiro Auth] Token refresh failed:', error.message);
            throw new Error(`Token refresh failed: ${error.message}`);
        }
    }

    /**
     * AWS SSO OIDC设备授权流程 - 启动设备授权
     * 参考: https://docs.aws.amazon.com/singlesignon/latest/OIDCAPIReference/API_StartDeviceAuthorization.html
     *
     * @param {string} startUrl - AWS SSO起始URL (例如: https://d-xxxxxxxxxx.awsapps.com/start)
     * @returns {Promise<Object>} 返回设备授权信息 { deviceCode, userCode, verificationUri, verificationUriComplete, expiresIn, interval }
     */
    async startDeviceAuthorization(startUrl) {
        if (!this.clientId || !this.clientSecret) {
            throw new Error('Missing clientId or clientSecret. Cannot start device authorization.');
        }

        const deviceAuthUrl = KIRO_CONSTANTS.DEVICE_AUTH_URL.replace('{{region}}', this.region);
        const requestBody = {
            clientId: this.clientId,
            clientSecret: this.clientSecret,
            startUrl: startUrl
        };

        console.log('[Kiro Device Auth] Starting device authorization...');
        console.log('[Kiro Device Auth] Device auth URL:', deviceAuthUrl);
        console.log('[Kiro Device Auth] Start URL:', startUrl);

        try {
            const response = await this.axiosInstance.post(deviceAuthUrl, requestBody);
            console.log('[Kiro Device Auth] Device authorization started successfully');
            console.log('[Kiro Device Auth] Response:', JSON.stringify(response.data, null, 2));

            const {
                deviceCode,
                userCode,
                verificationUri,
                verificationUriComplete,
                expiresIn,
                interval
            } = response.data;

            if (!deviceCode || !userCode || !verificationUri) {
                throw new Error('Invalid device authorization response: Missing required fields');
            }

            return {
                deviceCode,
                userCode,
                verificationUri,
                verificationUriComplete: verificationUriComplete || `${verificationUri}?user_code=${userCode}`,
                expiresIn: expiresIn || 300, // 默认5分钟
                interval: interval || 5 // 默认5秒轮询一次
            };
        } catch (error) {
            console.error('[Kiro Device Auth] Failed to start device authorization:', error.message);
            throw new Error(`Device authorization failed: ${error.message}`);
        }
    }

    /**
     * AWS SSO OIDC设备授权流程 - 轮询获取token
     * 参考: https://docs.aws.amazon.com/singlesignon/latest/OIDCAPIReference/API_CreateToken.html
     *
     * @param {string} deviceCode - 设备代码
     * @param {number} interval - 轮询间隔(秒)
     * @param {number} expiresIn - 过期时间(秒)
     * @returns {Promise<Object>} 返回token信息 { accessToken, refreshToken, expiresIn, tokenType }
     */
    async pollDeviceToken(deviceCode, interval = 5, expiresIn = 300) {
        if (!this.clientId || !this.clientSecret) {
            throw new Error('Missing clientId or clientSecret. Cannot poll for token.');
        }

        const tokenUrl = KIRO_CONSTANTS.REFRESH_IDC_URL.replace('{{region}}', this.region);
        const maxAttempts = Math.floor(expiresIn / interval);
        let attempts = 0;

        console.log(`[Kiro Device Auth] Starting token polling, interval ${interval}s, max attempts ${maxAttempts}`);

        const poll = async () => {
            if (attempts >= maxAttempts) {
                throw new Error('Device authorization timeout. Please restart the authorization flow.');
            }

            attempts++;

            const requestBody = {
                clientId: this.clientId,
                clientSecret: this.clientSecret,
                deviceCode: deviceCode,
                grantType: KIRO_CONSTANTS.DEVICE_GRANT_TYPE
            };

            try {
                const response = await this.axiosInstance.post(tokenUrl, requestBody);

                if (response.data && response.data.accessToken) {
                    // 成功获取token
                    console.log('[Kiro Device Auth] Successfully obtained token');

                    const {
                        accessToken,
                        refreshToken,
                        expiresIn: tokenExpiresIn,
                        tokenType
                    } = response.data;

                    // 更新实例属性
                    this.accessToken = accessToken;
                    this.refreshToken = refreshToken;
                    const expiresAt = tokenExpiresIn
                        ? new Date(Date.now() + tokenExpiresIn * 1000).toISOString()
                        : new Date(Date.now() + 3600 * 1000).toISOString(); // 默认1小时
                    this.expiresAt = expiresAt;

                    // 保存到文件
                    const tokenFilePath = this.credsFilePath || path.join(this.credPath, KIRO_AUTH_TOKEN_FILE);
                    const tokenData = {
                        accessToken,
                        refreshToken,
                        expiresAt,
                        clientId: this.clientId,
                        clientSecret: this.clientSecret,
                        authMethod: KIRO_CONSTANTS.AUTH_METHOD_IDC,
                        provider: 'BuilderId',
                        region: this.region
                    };
                    await this._saveCredentialsToFile(tokenFilePath, tokenData);
                    console.info('[Kiro Device Auth] Token saved to file');

                    return {
                        accessToken,
                        refreshToken,
                        expiresIn: tokenExpiresIn,
                        tokenType,
                        expiresAt
                    };
                }
            } catch (error) {
                // 检查错误类型
                if (error.response?.data?.error) {
                    const errorType = error.response.data.error;

                    if (errorType === 'authorization_pending') {
                        // 用户尚未完成授权,继续轮询
                        console.log(`[Kiro Device Auth] Waiting for user authorization... (attempt ${attempts}/${maxAttempts})`);
                        await new Promise(resolve => setTimeout(resolve, interval * 1000));
                        return poll();
                    } else if (errorType === 'slow_down') {
                        // 降低轮询频率
                        console.log('[Kiro Device Auth] Slowing down polling frequency');
                        await new Promise(resolve => setTimeout(resolve, (interval + 5) * 1000));
                        return poll();
                    } else if (errorType === 'expired_token') {
                        throw new Error('Device code expired. Please restart the authorization flow.');
                    } else if (errorType === 'access_denied') {
                        throw new Error('User denied the authorization request.');
                    }
                }

                // 其他网络错误,继续重试
                console.warn(`[Kiro Device Auth] Polling error (attempt ${attempts}/${maxAttempts}):`, error.message);
                await new Promise(resolve => setTimeout(resolve, interval * 1000));
                return poll();
            }
        };

        return poll();
    }

    /**
     * AWS SSO OIDC设备授权流程 - 完整流程(用于OAuth handler调用)
     *
     * @param {string} startUrl - AWS SSO起始URL
     * @returns {Promise<Object>} 返回授权URL和设备信息
     */
    async initiateDeviceAuthorization(startUrl) {
        const deviceAuthInfo = await this.startDeviceAuthorization(startUrl);

        // 启动后台轮询(不等待完成)
        this.pollDeviceToken(
            deviceAuthInfo.deviceCode,
            deviceAuthInfo.interval,
            deviceAuthInfo.expiresIn
        ).catch(error => {
            console.error('[Kiro Device Auth] Background polling failed:', error.message);
        });

        return {
            authUrl: deviceAuthInfo.verificationUriComplete,
            authInfo: {
                provider: 'claude-kiro-oauth',
                authMethod: KIRO_CONSTANTS.AUTH_METHOD_IDC,
                deviceCode: deviceAuthInfo.deviceCode,
                userCode: deviceAuthInfo.userCode,
                verificationUri: deviceAuthInfo.verificationUri,
                verificationUriComplete: deviceAuthInfo.verificationUriComplete,
                expiresIn: deviceAuthInfo.expiresIn,
                interval: deviceAuthInfo.interval,
                instructions: '请在浏览器中打开此链接进行AWS SSO授权。授权完成后,系统会自动获取访问令牌。'
            }
        };
    }

    /**
     * Kiro 优化：工具格式转换（支持 6 种格式）
     * 参考 Kiro 源码 extension.js:707778, extension.js:683316
     * 支持 OpenAI、Anthropic、LangChain、Kiro 原生、内置工具等多种工具格式
     */
    convertToQTool(tool, compressInputSchema, maxDescLength) {
        // 格式 0：Kiro 内置工具（Builtin Tools）- 直接传递，不转换
        // 参考 Kiro 源码 extension.js:683316-683326
        // 格式：{ type: "web_search_20250305", name: "web_search", max_uses: 8, ... }
        // ⚠️ 严格按照Kiro官方支持的6个工具，不添加额外工具
        const builtinTools = [
            'web_search',
            'bash',
            'code_execution',
            'computer',
            'str_replace_editor',
            'str_replace_based_edit_tool'
        ];

        // 完全按照Kiro官方逻辑：extension.js:683325
        if (typeof tool === 'object' && tool !== null &&
            'type' in tool && 'name' in tool &&
            typeof tool.type === 'string' && typeof tool.name === 'string' &&
            builtinTools.includes(tool.name)) {
            console.log(`[Kiro] Detected builtin tool: ${tool.name}, passing through without conversion`);
            return tool;  // 内置工具原样传递
        }

        // 格式 1：OpenAI 风格 { function: { name, description, parameters } }
        if (tool.function && typeof tool.function === 'object') {
            const schema = compressInputSchema(tool.function.parameters || {});
            let desc = tool.function.description || "";
            if (desc.length > maxDescLength) {
                desc = desc.substring(0, maxDescLength).trim() + '...';
            }

            return {
                toolSpecification: {
                    name: tool.function.name,
                    description: desc,
                    inputSchema: { json: schema }
                }
            };
        }

        // 格式 2：Kiro 原生格式（已经是 toolSpecification）
        if (tool.toolSpecification) {
            return tool;
        }

        // 格式 3：Anthropic/Claude 格式 { name, description, input_schema }
        if (tool.name && 'description' in tool && (tool.input_schema || tool.schema)) {
            let schema = tool.input_schema || tool.schema || {};

            // 支持 Zod Schema（自动转换）
            if (isZodSchema(schema)) {
                console.log('[Kiro] Converting Zod schema to JSON schema for tool:', tool.name);
                // 注意：需要安装 zod-to-json-schema 库才能完整支持
                // 这里暂时保持原样，避免引入额外依赖
            }

            schema = compressInputSchema(schema);
            let desc = tool.description || "";
            if (desc.length > maxDescLength) {
                desc = desc.substring(0, maxDescLength).trim() + '...';
            }

            return {
                toolSpecification: {
                    name: tool.name,
                    description: desc,
                    inputSchema: { json: schema }
                }
            };
        }

        // 格式 4：带 id 和 parameters { id, description, parameters }
        if (tool.id && 'description' in tool && tool.parameters) {
            let schema = tool.parameters;
            if (isZodSchema(schema)) {
                console.log('[Kiro] Zod schema detected for tool:', tool.id);
            }

            schema = compressInputSchema(schema);
            let desc = tool.description || "";
            if (desc.length > maxDescLength) {
                desc = desc.substring(0, maxDescLength).trim() + '...';
            }

            return {
                toolSpecification: {
                    name: tool.id,
                    description: desc,
                    inputSchema: { json: schema }
                }
            };
        }

        // 格式 5：带 id 和 schema { id, description, schema }
        if (tool.id && 'description' in tool && tool.schema) {
            let schema = tool.schema;
            if (isZodSchema(schema)) {
                console.log('[Kiro] Zod schema detected for tool:', tool.id);
            }

            schema = compressInputSchema(schema);
            let desc = tool.description || "";
            if (desc.length > maxDescLength) {
                desc = desc.substring(0, maxDescLength).trim() + '...';
            }

            return {
                toolSpecification: {
                    name: tool.id,
                    description: desc,
                    inputSchema: { json: schema }
                }
            };
        }

        // 无法识别的格式
        console.error('[Kiro] Invalid tool format:', tool);
        throw new Error('Invalid tool format. Supported: OpenAI, Anthropic, LangChain, Kiro native, or id+parameters/schema formats.');
    }

    /**
     * Kiro 优化：提取消息元数据
     * 参考 Kiro 源码 extension.js:707749
     * 从消息的 additional_kwargs 中提取元数据（conversationId, continuationId, taskType）
     */
    extractMetadata(messages, key) {
        if (!messages || messages.length === 0) return null;

        // 从后往前查找（最新消息优先）
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (msg.additional_kwargs && msg.additional_kwargs[key]) {
                console.log(`[Kiro] Extracted ${key}:`, msg.additional_kwargs[key]);
                return msg.additional_kwargs[key];
            }
        }
        return null;
    }

    /**
     * Kiro 优化：提取补充上下文
     * 参考 Kiro 源码 extension.js:578750-578780
     * 从消息的 additional_kwargs 中提取工作区上下文信息
     *
     * @param {Object} message - 消息对象
     * @returns {Array} 补充上下文数组
     */
    extractSupplementalContext(message) {
        const supplementalContexts = [];

        if (!message || !message.additional_kwargs) {
            return supplementalContexts;
        }

        const kwargs = message.additional_kwargs;

        // 1. 提取最近编辑的文件（recentlyEditedFiles）
        if (kwargs.recentlyEditedFiles && Array.isArray(kwargs.recentlyEditedFiles)) {
            kwargs.recentlyEditedFiles.forEach(file => {
                if (file.filepath && file.contents) {
                    supplementalContexts.push({
                        filePath: file.filepath,
                        content: file.contents
                    });
                }
            });
        }

        // 2. 提取最近编辑的范围（recentlyEditedRanges）
        if (kwargs.recentlyEditedRanges && Array.isArray(kwargs.recentlyEditedRanges)) {
            kwargs.recentlyEditedRanges.forEach(range => {
                if (range.filepath && range.lines) {
                    supplementalContexts.push({
                        filePath: range.filepath,
                        content: Array.isArray(range.lines) ? range.lines.join('\n') : range.lines
                    });
                }
            });
        }

        // 3. 提取光标上下文（cursorContext）
        if (kwargs.cursorContext) {
            const ctx = kwargs.cursorContext;
            if (ctx.filepath && ctx.content) {
                supplementalContexts.push({
                    filePath: ctx.filepath,
                    content: ctx.content
                });
            }
        }

        return supplementalContexts;
    }

    /**
     * Kiro 优化：消息验证和自动修复
     * 参考 Kiro 源码的 message-history-sanitizer
     * 规则：
     * 1. 必须以 user 消息开始
     * 2. 必须以 user 消息结束
     * 3. user 和 assistant 消息必须交替出现
     * 4. 工具调用和结果必须匹配
     */
    sanitizeMessages(messages) {
        if (!messages || messages.length === 0) {
            return [{
                role: 'user',
                content: 'Hello'
            }];
        }

        let result = [...messages];
        let sanitizeActions = [];  // 收集所有的格式化操作,最后统一输出

        // 规则 1：确保以 user 消息开始
        if (result[0].role !== 'user') {
            sanitizeActions.push('prepend_hello');
            result.unshift({
                role: 'user',
                content: 'Hello'
            });
        }

        // 规则 2：确保以 user 消息结束
        if (result[result.length - 1].role !== 'user') {
            sanitizeActions.push('append_continue');
            result.push({
                role: 'user',
                content: 'Continue'
            });
        }

        // 规则 3：确保消息交替
        const alternating = [result[0]];
        let insertedCount = 0;
        for (let i = 1; i < result.length; i++) {
            const prev = alternating[alternating.length - 1];
            const curr = result[i];

            if (prev.role === curr.role) {
                insertedCount++;
                // 相同 role 连续出现，插入对应消息
                if (prev.role === 'user') {
                    alternating.push({
                        role: 'assistant',
                        content: 'understood'
                    });
                } else {
                    alternating.push({
                        role: 'user',
                        content: 'Continue'
                    });
                }
            }
            alternating.push(curr);
        }

        // 只在有实际修改时输出一次汇总信息(减少日志噪音)
        if (sanitizeActions.length > 0 || insertedCount > 0) {
            const summary = [];
            if (sanitizeActions.includes('prepend_hello')) summary.push('prepended Hello');
            if (sanitizeActions.includes('append_continue')) summary.push('appended Continue');
            if (insertedCount > 0) summary.push(`inserted ${insertedCount} alternating messages`);
            console.log(`[Kiro] Message sanitization: ${summary.join(', ')}`);
        }

        // 规则 4：过滤掉不完整的 thinking 块（避免 signature 缺失错误）
        for (const message of alternating) {
            if (Array.isArray(message.content)) {
                message.content = message.content.filter(part => {
                    // 保留非 thinking 类型的内容
                    if (part.type !== 'thinking') {
                        return true;
                    }
                    // thinking 块转换为文本（已在 buildCodewhispererRequest 中处理，这里直接过滤）
                    console.log('[Kiro] Filtered thinking block from message to avoid signature error');
                    return false;
                });
            }
        }

        return alternating;
    }

    /**
     * Kiro 风格的消息摘要（简单截断到 100 字符）
     * 参考: Kiro extension.js:161275-1280
     * 注意：不是 AI 摘要，只是简单截断，节省成本和时间
     *
     * ⚠️ 关键：保持原始 content 的格式（数组就保持数组，字符串就保持字符串）
     */
    summarizeMessage(message) {
        const content = message.content;

        if (Array.isArray(content)) {
            // 如果是数组格式，提取文本部分并截断，返回数组格式
            const textContent = content
                .filter(part => part.type === 'text' && part.text)
                .map(part => part.text)
                .join('');
            const truncated = `${textContent.substring(0, 100)}...`;

            // 返回数组格式，保持与原始格式一致
            return [{ type: 'text', text: truncated }];
        }

        // 字符串格式，直接截断
        return `${content.substring(0, 100)}...`;
    }

    /**
     * Kiro 风格的消息历史修剪策略
     * 参考: Kiro extension.js:161281-1340
     *
     * 多阶段策略：
     * 1. 修剪超长消息（> contextLength/3）
     * 2. 保留最后 5 条消息，摘要前面的消息
     * 3. 删除最旧的消息（保留至少 5 条）
     * 4. 继续摘要剩余消息
     * 5. 继续删除旧消息（保留至少 1 条）
     * 6. 最终修剪第一条消息
     */
    pruneChatHistory(messages, contextLength, tokensForCompletion) {
        // 深拷贝消息副本，避免修改原数组（特别是 content 数组）
        const chatHistory = messages.map(msg => ({
            ...msg,
            content: Array.isArray(msg.content)
                ? msg.content.map(part => ({ ...part }))  // 深拷贝 content 数组
                : msg.content  // 字符串直接复制
        }));

        // 计算当前总 token 数
        let totalTokens = tokensForCompletion + chatHistory.reduce((acc, message) => {
            const content = this.getContentText(message);
            return acc + this.countTextTokens(content, true);  // 使用快速估算
        }, 0);

        console.log(`[Kiro Pruning] Initial state: ${chatHistory.length} messages, ${totalTokens} tokens (limit: ${contextLength})`);

        // 如果不超限，直接返回
        if (totalTokens <= contextLength) {
            return chatHistory;
        }

        // 阶段 1: 处理超长消息（> contextLength/3 的消息）
        const longestMessages = [...chatHistory];
        longestMessages.sort((a, b) => {
            const aContent = this.getContentText(a);
            const bContent = this.getContentText(b);
            return bContent.length - aContent.length;
        });

        const longerThanOneThird = longestMessages.filter(message => {
            const content = this.getContentText(message);
            return this.countTextTokens(content, true) > contextLength / 3;
        });

        for (let j = 0; j < longerThanOneThird.length; j++) {
            const message = longerThanOneThird[j];
            const content = this.getContentText(message);
            const messageTokens = this.countTextTokens(content, true);
            const deltaNeeded = totalTokens - contextLength;
            const distanceFromThird = messageTokens - contextLength / 3;
            const delta = Math.min(deltaNeeded, distanceFromThird);

            // 从顶部修剪消息
            const targetTokens = messageTokens - delta;
            const estimatedChars = Math.floor(targetTokens * 3.5);  // 粗略估算字符数
            const prunedText = content.substring(content.length - estimatedChars);

            // ⚠️ 保持原始格式：数组就保持数组，字符串就保持字符串
            if (Array.isArray(message.content)) {
                message.content = [{ type: 'text', text: prunedText }];
            } else {
                message.content = prunedText;
            }
            totalTokens -= delta;

            if (totalTokens <= contextLength) {
                console.log(`[Kiro Pruning] After pruning long messages: ${chatHistory.length} messages, ${totalTokens} tokens`);
                return chatHistory;
            }
        }

        // 阶段 2: 保留最后 5 条消息，摘要前面的消息
        let i = 0;
        while (totalTokens > contextLength && i < chatHistory.length - 5) {
            const message = chatHistory[i];
            const content = this.getContentText(message);
            const oldTokens = this.countTextTokens(content, true);
            const summarized = this.summarizeMessage(message);  // 传入整个 message
            const newTokens = this.countTextTokens(this.getContentText({ content: summarized }), true);

            message.content = summarized;  // summarized 已经是正确格式（数组或字符串）
            totalTokens = totalTokens - oldTokens + newTokens;
            i++;
        }

        if (totalTokens <= contextLength) {
            console.log(`[Kiro Pruning] After summarizing old messages: ${chatHistory.length} messages, ${totalTokens} tokens`);
            return chatHistory;
        }

        // 阶段 3: 删除最旧的消息（保留至少 5 条）
        while (chatHistory.length > 5 && totalTokens > contextLength) {
            const message = chatHistory.shift();
            const content = this.getContentText(message);
            totalTokens -= this.countTextTokens(content, true);
        }

        if (totalTokens <= contextLength) {
            console.log(`[Kiro Pruning] After deleting old messages: ${chatHistory.length} messages, ${totalTokens} tokens`);
            return chatHistory;
        }

        // 阶段 4: 继续摘要剩余消息（除了最后一条）
        i = 0;
        while (totalTokens > contextLength && chatHistory.length > 0 && i < chatHistory.length - 1) {
            const message = chatHistory[i];
            const content = this.getContentText(message);

            // 如果已经是摘要，跳过
            if (content.endsWith('...') && content.length <= 103) {
                i++;
                continue;
            }

            const oldTokens = this.countTextTokens(content, true);
            const summarized = this.summarizeMessage(message);  // 传入整个 message
            const newTokens = this.countTextTokens(this.getContentText({ content: summarized }), true);

            message.content = summarized;  // summarized 已经是正确格式
            totalTokens = totalTokens - oldTokens + newTokens;
            i++;
        }

        if (totalTokens <= contextLength) {
            console.log(`[Kiro Pruning] After summarizing remaining: ${chatHistory.length} messages, ${totalTokens} tokens`);
            return chatHistory;
        }

        // 阶段 5: 继续删除旧消息（保留至少 1 条）
        while (totalTokens > contextLength && chatHistory.length > 1) {
            const message = chatHistory.shift();
            const content = this.getContentText(message);
            totalTokens -= this.countTextTokens(content, true);
        }

        if (totalTokens <= contextLength) {
            console.log(`[Kiro Pruning] After final deletion: ${chatHistory.length} messages, ${totalTokens} tokens`);
            return chatHistory;
        }

        // 阶段 6: 最终修剪第一条消息
        if (totalTokens > contextLength && chatHistory.length > 0) {
            const message = chatHistory[0];
            const content = this.getContentText(message);
            const currentMessageTokens = this.countTextTokens(content, true);

            // ⚠️ FIX: 正确计算需要删除多少 tokens
            const tokensToRemove = totalTokens - contextLength;
            const targetMessageTokens = Math.max(100, currentMessageTokens - tokensToRemove); // 至少保留100 tokens
            const estimatedChars = Math.floor(targetMessageTokens * 3.5);
            const prunedText = content.substring(content.length - estimatedChars);

            // ⚠️ 保持原始格式：数组就保持数组，字符串就保持字符串
            if (Array.isArray(message.content)) {
                message.content = [{ type: 'text', text: prunedText }];
            } else {
                message.content = prunedText;
            }

            // 正确更新 totalTokens
            const actualRemovedTokens = currentMessageTokens - this.countTextTokens(prunedText, true);
            totalTokens -= actualRemovedTokens;
            console.log(`[Kiro Pruning] Final pruning applied: ${chatHistory.length} messages, ${totalTokens} tokens (removed ${actualRemovedTokens} tokens)`);
        }

        return chatHistory;
    }

    /**
     * Extract text content from OpenAI message format
     */
    getContentText(message) {
        if(message==null){
            return "";
        }
        if (Array.isArray(message) ) {
            return message
                .filter(part => part.type === 'text' && part.text)
                .map(part => part.text)
                .join('');
        } else if (typeof message.content === 'string') {
            return message.content;
        } else if (Array.isArray(message.content) ) {
            return message.content
                .filter(part => part.type === 'text' && part.text)
                .map(part => part.text)
                .join('');
        } 
        return String(message.content || message);
    }

    /**
     * Build CodeWhisperer request from OpenAI messages
     * @param {Array} messages - 消息数组
     * @param {string} model - 模型名称
     * @param {Array} tools - 工具定义数组
     * @param {string} inSystemPrompt - 系统提示词
     * @param {boolean} enableThinking - 是否启用思考模式（通过prompt injection实现）
     */
    async buildCodewhispererRequest(messages, model, tools = null, inSystemPrompt = null, enableThinking = false) {
        let systemPrompt = this.getContentText(inSystemPrompt);

        // 如果启用 thinking，在系统提示词中注入 thinking 指令
        if (enableThinking) {
            if (systemPrompt) {
                systemPrompt = `${THINKING_PROMPT_TEMPLATE}\n\n${systemPrompt}`;
            } else {
                systemPrompt = THINKING_PROMPT_TEMPLATE;
            }
        }

        // Kiro 优化 1：消息验证和自动修复（确保消息交替）
        messages = this.sanitizeMessages(messages);

        // Kiro 优化 1.5：消息历史修剪（防止 CONTENT_LENGTH_EXCEEDS_THRESHOLD 错误）
        // 参考 Kiro 官方客户端的实现
        const contextLength = KIRO_CONSTANTS.MAX_CONTEXT_TOKENS;
        const autoSummarizeThreshold = Math.floor(contextLength * KIRO_CONSTANTS.AUTO_SUMMARIZE_THRESHOLD);

        // 计算当前消息的 token 数
        let currentTokens = messages.reduce((acc, message) => {
            const content = this.getContentText(message);
            return acc + this.countTextTokens(content, true);
        }, 0);

        // 添加系统提示词的 token 数
        if (systemPrompt) {
            currentTokens += this.countTextTokens(systemPrompt, true);
        }

        // 添加工具定义的 token 数（如果有）
        // 注意：工具定义使用精确模式计算，因为快速模式会严重低估
        if (tools && Array.isArray(tools)) {
            const toolsTokens = tools.reduce((acc, tool) => {
                // 使用 JSON 字符串长度 / 3 作为更保守的估算（通常 JSON token 比字符少）
                const jsonStr = JSON.stringify(tool);
                return acc + Math.ceil(jsonStr.length / 3);
            }, 0);
            currentTokens += toolsTokens;
        }

        // 如果超过 80% 阈值，触发消息修剪或 AI 摘要
        if (currentTokens > autoSummarizeThreshold) {
            const usagePercent = Math.round(currentTokens/contextLength*100);
            console.log(`[Kiro Auto-Pruning] Token usage: ${currentTokens}/${contextLength} (${usagePercent}%) - Triggering pruning`);

            // 检查是否应该使用 AI 摘要（Kiro 风格 - 参考 decideContextAction extension.js:711505-711520）
            // 条件：1) 上下文使用率 > 80%（官方阈值）或 token 使用率 > 60%
            //       2) 没有正在进行的摘要
            //       3) 距离上次摘要至少 3 分钟（避免频繁摘要）
            //       4) 有足够的消息需要摘要（至少 8 条）
            const shouldUseSummarization =
                !this.summarizationInProgress &&
                (this.lastContextUsagePercentage > 80 || usagePercent > 60) &&
                (Date.now() - this.lastSummarizationTime > 3 * 60 * 1000) &&
                messages.length >= 8;

            if (shouldUseSummarization) {
                console.log(`[Kiro AI-Summary] Attempting AI summarization (contextUsage: ${this.lastContextUsagePercentage}%, tokenUsage: ${usagePercent}%)`);
                this.summarizationInProgress = true;

                try {
                    // 保留最近的消息（不参与摘要）
                    const minKeep = KIRO_CONSTANTS.MIN_MESSAGES_TO_KEEP || 5;
                    const messagesToSummarize = messages.slice(0, -minKeep);
                    const recentMessages = messages.slice(-minKeep);

                    if (messagesToSummarize.length > 5) {
                        // 调用 AI 生成摘要
                        const originalCount = messagesToSummarize.length + minKeep;
                        const summary = await generateConversationSummary(messagesToSummarize, this);

                        if (summary) {
                            // 用摘要 + 最近消息替换原消息（传入原始消息数量）
                            messages = buildMessagesWithSummary(summary, recentMessages, originalCount);
                            this.lastSummarizationTime = Date.now();
                            console.log(`[Kiro AI-Summary] Success! Reduced from ${originalCount} to ${messages.length} messages`);

                            // 重置上下文使用率（摘要后会降低）
                            this.lastContextUsagePercentage = 0;
                        } else {
                            console.log('[Kiro AI-Summary] AI summary returned null, falling back to simple pruning');
                        }
                    }
                } catch (error) {
                    console.error('[Kiro AI-Summary] Failed:', error.message);
                } finally {
                    this.summarizationInProgress = false;
                }
            }

            // 如果还是超限（AI 摘要失败或跳过），使用传统的剪枝方法
            const currentTokensAfterSummary = messages.reduce((acc, message) => {
                const content = this.getContentText(message);
                return acc + this.countTextTokens(content, true);
            }, 0);

            if (currentTokensAfterSummary > autoSummarizeThreshold) {
                console.log(`[Kiro Fallback-Pruning] Still over threshold (${currentTokensAfterSummary}), using traditional pruning`);

                // 预留给工具和系统提示词的 token
                const tokensForCompletion = 4096;
                let reservedTokens = tokensForCompletion + (systemPrompt ? this.countTextTokens(systemPrompt, true) : 0);

                if (tools && Array.isArray(tools)) {
                    const toolsTokens = tools.reduce((acc, tool) => {
                        const jsonStr = JSON.stringify(tool);
                        return acc + Math.ceil(jsonStr.length / 3);
                    }, 0);
                    reservedTokens += toolsTokens;
                }

                // 执行传统修剪
                messages = this.pruneChatHistory(messages, contextLength, reservedTokens);
            }

            // 修剪后重新计算 token 数
            const prunedTokens = messages.reduce((acc, message) => {
                const content = this.getContentText(message);
                return acc + this.countTextTokens(content, true);
            }, 0);
            console.log(`[Kiro Auto-Pruning] Completed: ${prunedTokens}/${contextLength} (${Math.round(prunedTokens/contextLength*100)}%)`);
        }

        // 检查请求体大小（基于字节数，比 token 估算更准确）
        const estimateRequestSize = () => {
            // 计算实际请求大小（更准确的方法）
            const fullRequest = {
                conversationState: {
                    history: messages,
                    currentMessage: messages.length > 0 ? messages[messages.length - 1] : {}
                }
            };
            if (tools) fullRequest.tools = tools;
            if (systemPrompt) fullRequest.system = systemPrompt;
            return JSON.stringify(fullRequest).length;
        };

        let requestSize = estimateRequestSize();
        const maxSize = KIRO_CONSTANTS.MAX_REQUEST_SIZE_BYTES;

        // 如果请求体过大，继续修剪消息
        while (requestSize > maxSize && messages.length > 2) {
            console.log(`[Kiro Size-Pruning] Request size ${requestSize}/${maxSize} bytes (${Math.round(requestSize/maxSize*100)}%) - Removing oldest message`);
            messages.shift(); // 删除最旧的消息
            requestSize = estimateRequestSize();
        }

        if (requestSize > maxSize) {
            console.log(`[Kiro Size-Pruning] Warning: Request still large (${requestSize} bytes) after pruning to ${messages.length} messages`);
        }

        // Kiro 优化 2：提取 conversationId 和 continuationId（多轮对话优化）
        // 从消息历史中提取（如果客户端提供），否则生成新的
        const conversationId = this.extractMetadata(messages, 'conversationId') || uuidv4();
        const continuationId = this.extractMetadata(messages, 'continuationId');  // 可选
        const taskType = this.extractMetadata(messages, 'taskType');  // 可选
        let processedMessages = messages;

        if (processedMessages.length === 0) {
            throw new Error('No user messages found');
        }

        // 判断最后一条消息是否为 assistant,如果是则移除
        const lastMessage = processedMessages[processedMessages.length - 1];
        if (processedMessages.length > 0 && lastMessage.role === 'assistant') {
            if (lastMessage.content[0].type === "text" && lastMessage.content[0].text === "{") {
                console.log('[Kiro] Removing last assistant with "{" message from processedMessages');
                processedMessages.pop();
            }
        }

        // 合并相邻相同 role 的消息
        const mergedMessages = [];
        for (let i = 0; i < processedMessages.length; i++) {
            const currentMsg = processedMessages[i];
            
            if (mergedMessages.length === 0) {
                mergedMessages.push(currentMsg);
            } else {
                const lastMsg = mergedMessages[mergedMessages.length - 1];
                
                // 判断当前消息和上一条消息是否为相同 role
                if (currentMsg.role === lastMsg.role) {
                    // 合并消息内容
                    if (Array.isArray(lastMsg.content) && Array.isArray(currentMsg.content)) {
                        // 如果都是数组,合并数组内容
                        lastMsg.content.push(...currentMsg.content);
                    } else if (typeof lastMsg.content === 'string' && typeof currentMsg.content === 'string') {
                        // 如果都是字符串,用换行符连接
                        lastMsg.content += '\n' + currentMsg.content;
                    } else if (Array.isArray(lastMsg.content) && typeof currentMsg.content === 'string') {
                        // 上一条是数组,当前是字符串,添加为 text 类型
                        lastMsg.content.push({ type: 'text', text: currentMsg.content });
                    } else if (typeof lastMsg.content === 'string' && Array.isArray(currentMsg.content)) {
                        // 上一条是字符串,当前是数组,转换为数组格式
                        lastMsg.content = [{ type: 'text', text: lastMsg.content }, ...currentMsg.content];
                    }
                    console.log(`[Kiro] Merged adjacent ${currentMsg.role} messages`);
                } else {
                    mergedMessages.push(currentMsg);
                }
            }
        }
        
        // 用合并后的消息替换原消息数组
        processedMessages.length = 0;
        processedMessages.push(...mergedMessages);

        // Kiro 风格：应用多层消息修剪策略（复刻 extension.js:161281-161340）
        // 在构建请求前修剪消息历史，避免超过上下文限制
        try {
            processedMessages = pruneChatHistory(processedMessages, KIRO_CONSTANTS.MAX_CONTEXT_TOKENS_SAFE);
        } catch (error) {
            console.error('[Kiro] pruneChatHistory error:', error.message, error.stack);
            // 如果修剪失败，继续使用原消息
        }

        // Kiro 风格：高级消息验证和修复（复刻 extension.js:706680-706688）
        // 确保消息格式符合 AWS API 要求
        try {
            processedMessages = sanitizeConversationAdvanced(processedMessages);
        } catch (error) {
            console.error('[Kiro] sanitizeConversationAdvanced error:', error.message, error.stack);
            // 如果验证失败，继续使用原消息
        }

        // Kiro 官方逻辑：使用MODEL_MAPPING映射到AWS支持的模型ID
        const codewhispererModel = MODEL_MAPPING[model] || MODEL_MAPPING[this.modelName];
        
        // AWS CodeWhisperer不支持的JSON Schema关键字（保守策略：只移除纯文档字段）
        // 参考官方Kiro的做法：保留所有可能有功能性的validation，只删除元数据和文档
        // 优化：保留更多关键字段以提升模型理解
        const UNSUPPORTED_SCHEMA_KEYS = new Set([
            // JSON Schema 元信息（纯元数据，无功能）
            '$schema', '$id', '$defs', 'definitions',
            // 文档字段（保留 title 和 default，它们对理解有帮助）
            'examples',  // 只移除 examples，保留 title 和 default
            // 组合逻辑（AWS不支持复杂schema组合）
            'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else',
            // 评估相关（AWS不支持）
            'additionalItems', 'unevaluatedItems', 'unevaluatedProperties',
            // 依赖相关（AWS不支持）
            'dependentSchemas', 'dependentRequired'
        ]);

        // 清理inputSchema - 只移除AWS CodeWhisperer明确不支持的元数据和文档字段
        // 保守策略：保留所有validation字段（minLength, maxLength, pattern, minimum, maximum等）
        // 仿照官方Kiro：不压缩description，保持schema的功能完整性
        const compressInputSchema = (schema) => {
            if (!schema || typeof schema !== 'object') return schema;

            // 处理数组
            if (Array.isArray(schema)) {
                return schema.map(item => compressInputSchema(item));
            }

            // 深拷贝并移除不支持的字段
            const compressed = {};

            for (const [key, value] of Object.entries(schema)) {
                // 跳过黑名单中的字段
                if (UNSUPPORTED_SCHEMA_KEYS.has(key)) {
                    continue;
                }

                // 处理需要递归的字段
                if (key === 'properties' && typeof value === 'object' && !Array.isArray(value)) {
                    compressed.properties = {};
                    for (const [propKey, propValue] of Object.entries(value)) {
                        compressed.properties[propKey] = compressInputSchema(propValue);
                    }
                } else if (key === 'items') {
                    compressed.items = compressInputSchema(value);
                } else if (key === 'additionalProperties' && typeof value === 'object') {
                    compressed.additionalProperties = compressInputSchema(value);
                } else {
                    // 保留所有其他字段（包括description、type、required、enum、validation字段等）
                    compressed[key] = value;
                }
            }

            return compressed;
        };

        // 官方Kiro客户端模式：发送tools到API，但必须压缩description以符合AWS限制
        // Claude Code的tool description太长（6000+字符），必须压缩到Kiro水平（300-700字符）
        // 优化：提升到 1000 字符以保留更多关键信息（实测 AWS 支持到 1200）
        const DESCRIPTION_MAX_LENGTH = 1000;  // 从 500 提升到 1000，提高工具理解准确率
        let toolsContext = {};

        // ⚠️ 内置工具（builtin tools）定义 - 用于过滤
        const builtinToolNames = ['web_search', 'bash', 'code_execution', 'computer', 'str_replace_editor', 'str_replace_based_edit_tool'];
        const isBuiltinTool = (tool) => {
            return tool && typeof tool === 'object' &&
                   'name' in tool && builtinToolNames.includes(tool.name);
        };

        if (tools && Array.isArray(tools) && tools.length > 0) {
            // 过滤掉内置工具，AWS CodeWhisperer不支持这些
            // 内置工具应该由Anthropic官方API或客户端本地处理
            const nonBuiltinTools = tools.filter(tool => {
                const isBuiltin = isBuiltinTool(tool);
                if (isBuiltin) {
                    console.log(`[Kiro] Filtering out builtin tool: ${tool.name} (not supported by AWS CodeWhisperer)`);
                }
                return !isBuiltin;
            });

            if (nonBuiltinTools.length > 0) {
                toolsContext = {
                    tools: nonBuiltinTools.map(tool => this.convertToQTool(tool, compressInputSchema, DESCRIPTION_MAX_LENGTH))
                };
            }
        }

        const history = [];
        let startIndex = 0;

        // Handle system prompt
        if (systemPrompt) {
            // If the first message is a user message, prepend system prompt to it
            if (processedMessages[0].role === 'user') {
                let firstUserContent = this.getContentText(processedMessages[0]);
                history.push({
                    userInputMessage: {
                        content: `${systemPrompt}\n\n${firstUserContent}`,
                        modelId: codewhispererModel,
                        origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
                    }
                });
                startIndex = 1; // Start processing from the second message
            } else {
                // If the first message is not a user message, or if there's no initial user message,
                // add system prompt as a standalone user message.
                history.push({
                    userInputMessage: {
                        content: systemPrompt,
                        modelId: codewhispererModel,
                        origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
                    }
                });
            }
        }

        // 官方Kiro策略：不裁剪history，直接发送所有消息（除最后一条作为currentMessage）
        // history: serializedMessages.slice(0, -1)
        // Add remaining user/assistant messages to history
        for (let i = startIndex; i < processedMessages.length - 1; i++) {
            const message = processedMessages[i];
            if (message.role === 'user') {
                let userInputMessage = {
                    content: '',
                    modelId: codewhispererModel,
                    origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
                };
                let images = [];
                let toolResults = [];
                
                if (Array.isArray(message.content)) {
                    for (const part of message.content) {
                        if (part.type === 'text') {
                            userInputMessage.content += part.text;
                        } else if (part.type === 'tool_result') {
                            toolResults.push({
                                content: [{ text: this.getContentText(part.content) }],
                                status: 'success',
                                toolUseId: part.tool_use_id
                            });
                        } else if (part.type === 'image') {
                            // Kiro 优化：智能图片格式检测
                            let format = 'jpeg';  // 默认
                            if (part.source?.media_type) {
                                // 优先使用 media_type
                                format = part.source.media_type.split('/')[1];
                            } else if (part.source?.data || part.image_url?.url) {
                                // 降级到自动检测
                                format = detectImageFormat(part.source?.data || part.image_url?.url);
                            }

                            images.push({
                                format: format,
                                source: {
                                    bytes: part.source.data
                                }
                            });
                        }
                    }
                } else {
                    userInputMessage.content = this.getContentText(message);
                }
                
                // 只添加非空字段，API 不接受空数组或空对象
                if (images.length > 0) {
                    userInputMessage.images = images;
                }
                if (toolResults.length > 0) {
                    // 去重 toolResults - Kiro API 不接受重复的 toolUseId
                    const uniqueToolResults = [];
                    const seenIds = new Set();
                    for (const tr of toolResults) {
                        if (!seenIds.has(tr.toolUseId)) {
                            seenIds.add(tr.toolUseId);
                            uniqueToolResults.push(tr);
                        }
                    }
                    userInputMessage.userInputMessageContext = { toolResults: uniqueToolResults };
                }
                
                history.push({ userInputMessage });
            } else if (message.role === 'assistant') {
                let assistantResponseMessage = {
                    content: ''
                };
                let toolUses = [];
                
                if (Array.isArray(message.content)) {
                    for (const part of message.content) {
                        if (part.type === 'text') {
                            assistantResponseMessage.content += part.text;
                        } else if (part.type === 'tool_use') {
                            toolUses.push({
                                input: part.input,
                                name: part.name,
                                toolUseId: part.id
                            });
                        } else if (part.type === 'thinking') {
                            // 将thinking内容添加到文本中，避免signature缺失导致的400错误
                            const thinkingText = part.thinking || '';
                            if (thinkingText) {
                                assistantResponseMessage.content += `<thinking>\n${thinkingText}\n</thinking>\n`;
                            }
                        }
                    }
                } else {
                    assistantResponseMessage.content = this.getContentText(message);
                }
                
                // 只添加非空字段
                if (toolUses.length > 0) {
                    assistantResponseMessage.toolUses = toolUses;
                }
                
                history.push({ assistantResponseMessage });
            }
        }

        // Build current message
        let currentMessage = processedMessages[processedMessages.length - 1];
        let currentContent = '';
        let currentToolResults = [];
        let currentToolUses = [];
        let currentImages = [];

        // 如果最后一条消息是 assistant，需要将其加入 history，然后创建一个 user 类型的 currentMessage
        // 因为 CodeWhisperer API 的 currentMessage 必须是 userInputMessage 类型
        if (currentMessage.role === 'assistant') {
            console.log('[Kiro] Last message is assistant, moving it to history and creating user currentMessage');
            
            // 构建 assistant 消息并加入 history
            let assistantResponseMessage = {
                content: '',
                toolUses: []
            };
            if (Array.isArray(currentMessage.content)) {
                for (const part of currentMessage.content) {
                    if (part.type === 'text') {
                        assistantResponseMessage.content += part.text;
                    } else if (part.type === 'tool_use') {
                        assistantResponseMessage.toolUses.push({
                            input: part.input,
                            name: part.name,
                            toolUseId: part.id
                        });
                    } else if (part.type === 'thinking') {
                        // 将thinking内容添加到文本中，避免signature缺失导致的400错误
                        const thinkingText = part.thinking || '';
                        if (thinkingText) {
                            assistantResponseMessage.content += `<thinking>\n${thinkingText}\n</thinking>\n`;
                        }
                    }
                }
            } else {
                assistantResponseMessage.content = this.getContentText(currentMessage);
            }
            if (assistantResponseMessage.toolUses.length === 0) {
                delete assistantResponseMessage.toolUses;
            }
            history.push({ assistantResponseMessage });
            
            // 设置 currentContent 为 "Continue"，因为我们需要一个 user 消息来触发 AI 继续
            currentContent = 'Continue';
        } else {
            // 处理 user 消息
            if (Array.isArray(currentMessage.content)) {
                for (const part of currentMessage.content) {
                    if (part.type === 'text') {
                        currentContent += part.text;
                    } else if (part.type === 'tool_result') {
                        currentToolResults.push({
                            content: [{ text: this.getContentText(part.content) }],
                            status: 'success',
                            toolUseId: part.tool_use_id
                        });
                    } else if (part.type === 'tool_use') {
                        currentToolUses.push({
                            input: part.input,
                            name: part.name,
                            toolUseId: part.id
                        });
                    } else if (part.type === 'image') {
                        // Kiro 优化：智能图片格式检测
                        let format = 'jpeg';  // 默认
                        if (part.source?.media_type) {
                            // 优先使用 media_type
                            format = part.source.media_type.split('/')[1];
                        } else if (part.source?.data || part.image_url?.url) {
                            // 降级到自动检测
                            format = detectImageFormat(part.source?.data || part.image_url?.url);
                        }

                        currentImages.push({
                            format: format,
                            source: {
                                bytes: part.source.data
                            }
                        });
                    }
                }
            } else {
                currentContent = this.getContentText(currentMessage);
            }

            // Kiro API 要求 content 不能为空，即使有 toolResults
            if (!currentContent) {
                currentContent = currentToolResults.length > 0 ? 'Tool results provided.' : 'Continue';
            }
        }

        const request = {
            conversationState: {
                chatTriggerType: KIRO_CONSTANTS.CHAT_TRIGGER_TYPE_MANUAL,
                conversationId: conversationId,
                currentMessage: {} // Will be populated as userInputMessage
            }
        };

        // Kiro 优化：添加 agentContinuationId（多轮对话优化）
        if (continuationId) {
            request.conversationState.agentContinuationId = continuationId;
            console.log('[Kiro] Using continuationId for multi-turn optimization:', continuationId);
        }

        // Kiro 优化：添加 agentTaskType（任务类型优化）
        if (taskType) {
            request.conversationState.agentTaskType = taskType;
            console.log('[Kiro] Using taskType:', taskType);
        }

        // 只有当 history 非空时才添加（API 可能不接受空数组）
        if (history.length > 0) {
            request.conversationState.history = history;
        }

        // currentMessage 始终是 userInputMessage 类型
        // 注意：API 不接受 null 值，空字段应该完全不包含
        const userInputMessage = {
            content: currentContent,
            modelId: codewhispererModel,
            origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
        };

        // 只有当 images 非空时才添加
        if (currentImages && currentImages.length > 0) {
            userInputMessage.images = currentImages;
        }

        // 构建 userInputMessageContext，只包含非空字段
        const userInputMessageContext = {};
        if (currentToolResults.length > 0) {
            // 去重 toolResults - Kiro API 不接受重复的 toolUseId
            const uniqueToolResults = [];
            const seenToolUseIds = new Set();
            for (const tr of currentToolResults) {
                if (!seenToolUseIds.has(tr.toolUseId)) {
                    seenToolUseIds.add(tr.toolUseId);
                    uniqueToolResults.push(tr);
                }
            }
            userInputMessageContext.toolResults = uniqueToolResults;
        }
        // 官方Kiro客户端模式：发送压缩后的tools定义
        if (Object.keys(toolsContext).length > 0 && toolsContext.tools) {
            userInputMessageContext.tools = toolsContext.tools;
        }

        // ⭐ Kiro 优化：补充上下文（supplementalContext）
        // 从最后一条消息的 additional_kwargs 中提取工作区上下文
        const supplementalContext = this.extractSupplementalContext(currentMessage);
        if (supplementalContext && supplementalContext.length > 0) {
            userInputMessageContext.supplementalContexts = supplementalContext;
            console.log(`[Kiro] Added ${supplementalContext.length} supplemental contexts`);
        }

        // 只有当 userInputMessageContext 有内容时才添加
        if (Object.keys(userInputMessageContext).length > 0) {
            userInputMessage.userInputMessageContext = userInputMessageContext;
        }

        request.conversationState.currentMessage.userInputMessage = userInputMessage;

        if (this.authMethod === KIRO_CONSTANTS.AUTH_METHOD_SOCIAL) {
            request.profileArn = this.profileArn;
        }

        // 性能优化：移除每次请求都执行的 JSON.stringify 调试日志
        // 这些操作对大请求来说非常慢，会显著增加首字响应时间
        // 如需调试，可临时取消注释以下代码块
        /*
        const requestJson = JSON.stringify(request);
        const requestSizeKB = (requestJson.length / 1024).toFixed(2);
        console.log(`[Kiro Debug] Request size: ${requestSizeKB} KB`);
        if (request.conversationState) {
            const historySize = JSON.stringify(request.conversationState.history || []).length;
            console.log(`[Kiro Debug] - History: ${(historySize / 1024).toFixed(2)} KB`);
        }
        */

        return request;
    }

    parseEventStreamChunk(rawData) {
        const rawStr = Buffer.isBuffer(rawData) ? rawData.toString('utf8') : String(rawData);
        let fullContent = '';
        const toolCalls = [];
        let currentToolCallDict = null;
        // console.log(`rawStr=${rawStr}`);

        // 改进的 SSE 事件解析：匹配 :message-typeevent 后面的 JSON 数据
        // 使用更精确的正则来匹配 SSE 格式的事件
        const sseEventRegex = /:message-typeevent(\{[^]*?(?=:event-type|$))/g;
        const legacyEventRegex = /event(\{.*?(?=event\{|$))/gs;
        
        // 首先尝试使用 SSE 格式解析
        let matches = [...rawStr.matchAll(sseEventRegex)];
        
        // 如果 SSE 格式没有匹配到，回退到旧的格式
        if (matches.length === 0) {
            matches = [...rawStr.matchAll(legacyEventRegex)];
        }

        for (const match of matches) {
            const potentialJsonBlock = match[1];
            if (!potentialJsonBlock || potentialJsonBlock.trim().length === 0) {
                continue;
            }

            // 尝试找到完整的 JSON 对象
            let searchPos = 0;
            while ((searchPos = potentialJsonBlock.indexOf('}', searchPos + 1)) !== -1) {
                const jsonCandidate = potentialJsonBlock.substring(0, searchPos + 1).trim();
                try {
                    const eventData = JSON.parse(jsonCandidate);

                    // 优先处理结构化工具调用事件
                    if (eventData.name && eventData.toolUseId) {
                        if (!currentToolCallDict) {
                            currentToolCallDict = {
                                id: eventData.toolUseId,
                                type: "function",
                                function: {
                                    name: eventData.name,
                                    arguments: ""
                                }
                            };
                        }
                        if (eventData.input) {
                            currentToolCallDict.function.arguments += eventData.input;
                        }
                        if (eventData.stop) {
                            try {
                                const args = JSON.parse(currentToolCallDict.function.arguments);
                                currentToolCallDict.function.arguments = JSON.stringify(args);
                            } catch (e) {
                                console.warn(`[Kiro] Tool call arguments not valid JSON: ${currentToolCallDict.function.arguments}`);
                            }
                            toolCalls.push(currentToolCallDict);
                            currentToolCallDict = null;
                        }
                    } else if (!eventData.followupPrompt && eventData.content) {
                        // 处理内容，移除转义字符
                        let decodedContent = eventData.content;
                        // 处理常见的转义序列
                        decodedContent = decodedContent.replace(/(?<!\\)\\n/g, '\n');
                        // decodedContent = decodedContent.replace(/(?<!\\)\\t/g, '\t');
                        // decodedContent = decodedContent.replace(/\\"/g, '"');
                        // decodedContent = decodedContent.replace(/\\\\/g, '\\');
                        fullContent += decodedContent;
                    }
                    break;
                } catch (e) {
                    // JSON 解析失败，继续寻找下一个可能的结束位置
                    continue;
                }
            }
        }
        
        // 如果还有未完成的工具调用，添加到列表中
        if (currentToolCallDict) {
            toolCalls.push(currentToolCallDict);
        }

        // 检查解析后文本中的 bracket 格式工具调用（向后兼容）
        const bracketToolCalls = parseBracketToolCalls(fullContent);
        if (bracketToolCalls) {
            toolCalls.push(...bracketToolCalls);
            // 从响应文本中移除工具调用文本
            for (const tc of bracketToolCalls) {
                const funcName = tc.function.name;
                const escapedName = funcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const pattern = new RegExp(`\\[Called\\s+${escapedName}\\s+with\\s+args:\\s*\\{[^}]*(?:\\{[^}]*\\}[^}]*)*\\}\\]`, 'gs');
                fullContent = fullContent.replace(pattern, '');
            }
            fullContent = fullContent.replace(/\s+/g, ' ').trim();
        }

        const uniqueToolCalls = deduplicateToolCalls(toolCalls);
        return { content: fullContent || '', toolCalls: uniqueToolCalls };
    }
 

    /**
     * 调用 API 并处理错误重试
     */
    async callApi(method, model, body, isRetry = false, retryCount = 0) {
        if (!this.isInitialized) await this.initialize();
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000; // 1 second base delay

        // 检查是否启用 thinking（从 body 或配置中读取）
        const enableThinking = body.thinking?.type === 'enabled' ||
                             body.extended_thinking === true ||
                             this.config.ENABLE_THINKING_BY_DEFAULT === true;
        const requestData = await this.buildCodewhispererRequest(body.messages, model, body.tools, body.system, enableThinking);

        // 性能优化：移除 JSON.stringify 大小检查，该操作对大请求很慢

        try {
            const token = this.accessToken; // Use the already initialized token
            const headers = {
                'Authorization': `Bearer ${token}`,
                'amz-sdk-invocation-id': `${uuidv4()}`,
            };

            // 当 model 以 kiro-amazonq 开头时，使用 amazonQUrl，否则使用 baseUrl
            const requestUrl = model.startsWith('amazonq') ? this.amazonQUrl : this.baseUrl;
            const response = await this.axiosInstance.post(requestUrl, requestData, { headers });
            return response;
        } catch (error) {
            // 403 错误处理
            if (error.response?.status === 403 && !isRetry) {
                console.log('[Kiro] Received 403. Attempting token refresh and retrying...');
                try {
                    await this.initializeAuth(true); // Force refresh token
                    return this.callApi(method, model, body, true, retryCount);
                } catch (refreshError) {
                    console.error('[Kiro] Token refresh failed during 403 retry:', refreshError.message);
                    throw refreshError;
                }
            }

            // 400 错误详细日志(帮助调试请求格式问题)
            if (error.response?.status === 400) {
                console.error('[Kiro] ❌ 400 Bad Request Error - Request format issue detected');
                console.error('[Kiro] Error details:', {
                    status: error.response.status,
                    statusText: error.response.statusText,
                    data: JSON.stringify(error.response.data).substring(0, 500),
                    headers: error.response.headers
                });
                // 400 错误是请求格式问题,属于致命错误,直接抛出(会被health check捕获)
                throw error;
            }

            // 429 限流错误处理(暂时性错误,不应标记为不健康)
            if (error.response?.status === 429) {
                if (retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    console.log(`[Kiro] Received 429 (Rate Limit). Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    return this.callApi(method, model, body, isRetry, retryCount + 1);
                } else {
                    // 429 重试次数用尽,包装成特殊错误类型
                    const rateLimitError = new Error('RATE_LIMIT_EXCEEDED');
                    rateLimitError.isRateLimitError = true;  // 标记为限流错误
                    rateLimitError.retryable = true;  // 标记为可重试(不应标记账号不健康)
                    throw rateLimitError;
                }
            }

            // 5xx 服务器错误处理(可重试)
            if (error.response?.status >= 500 && error.response?.status < 600 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                console.log(`[Kiro] Received ${error.response.status} server error. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.callApi(method, model, body, isRetry, retryCount + 1);
            }

            // 其他错误
            console.error('[Kiro] API call failed:', error.message);
            if (error.response) {
                console.error('[Kiro] Response status:', error.response.status);
                console.error('[Kiro] Response data:', JSON.stringify(error.response.data).substring(0, 300));
            }
            throw error;
        }
    }

    _processApiResponse(response) {
        const rawResponseText = Buffer.isBuffer(response.data) ? response.data.toString('utf8') : String(response.data);
        //console.log(`[Kiro] Raw response length: ${rawResponseText.length}`);
        if (rawResponseText.includes("[Called")) {
            console.log("[Kiro] Raw response contains [Called marker.");
        }

        // 1. Parse structured events and bracket calls from parsed content
        const parsedFromEvents = this.parseEventStreamChunk(rawResponseText);
        let fullResponseText = parsedFromEvents.content;
        let allToolCalls = [...parsedFromEvents.toolCalls]; // clone
        //console.log(`[Kiro] Found ${allToolCalls.length} tool calls from event stream parsing.`);

        // 2. Crucial fix from Python example: Parse bracket tool calls from the original raw response
        const rawBracketToolCalls = parseBracketToolCalls(rawResponseText);
        if (rawBracketToolCalls) {
            //console.log(`[Kiro] Found ${rawBracketToolCalls.length} bracket tool calls in raw response.`);
            allToolCalls.push(...rawBracketToolCalls);
        }

        // 3. Deduplicate all collected tool calls
        const uniqueToolCalls = deduplicateToolCalls(allToolCalls);
        //console.log(`[Kiro] Total unique tool calls after deduplication: ${uniqueToolCalls.length}`);

        // 4. Clean up response text by removing all tool call syntax from the final text.
        // The text from parseEventStreamChunk is already partially cleaned.
        // We re-clean here with all unique tool calls to be certain.
        if (uniqueToolCalls.length > 0) {
            for (const tc of uniqueToolCalls) {
                const funcName = tc.function.name;
                const escapedName = funcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const pattern = new RegExp(`\\[Called\\s+${escapedName}\\s+with\\s+args:\\s*\\{[^}]*(?:\\{[^}]*\\}[^}]*)*\\}\\]`, 'gs');
                fullResponseText = fullResponseText.replace(pattern, '');
            }
            fullResponseText = fullResponseText.replace(/\s+/g, ' ').trim();
        }
        
        //console.log(`[Kiro] Final response text after tool call cleanup: ${fullResponseText}`);
        //console.log(`[Kiro] Final tool calls after deduplication: ${JSON.stringify(uniqueToolCalls)}`);
        return { responseText: fullResponseText, toolCalls: uniqueToolCalls };
    }

    async generateContent(model, requestBody) {
        if (!this.isInitialized) await this.initialize();

        // 官方AWS SDK逻辑：检查并刷新token（5分钟窗口+30秒防抖）
        await this.refreshAccessTokenIfNeeded();

        // Kiro 官方逻辑：如果model在MODEL_MAPPING中则使用，否则使用默认模型
        const finalModel = MODEL_MAPPING[model] ? model : this.modelName;
        console.log(`[Kiro] Calling generateContent with model: ${finalModel}`);

        // Estimate input tokens before making the API call
        const inputTokens = this.estimateInputTokens(requestBody);

        const response = await this.callApi('', finalModel, requestBody);

        try {
            const { responseText, toolCalls } = this._processApiResponse(response);
            return this.buildClaudeResponse(responseText, false, 'assistant', model, toolCalls, inputTokens);
        } catch (error) {
            console.error('[Kiro] Error in generateContent:', error);
            throw new Error(`Error processing response: ${error.message}`);
        }
    }

    /**
     * 内部方法：用于 AI 摘要生成，绕过正常的上下文管理
     * 参考 Kiro 官方的 _summarizationNode 实现
     */
    async sendMessageInternal(messages, systemPrompt, tools, streaming, abortSignal, isSummarization = false) {
        if (!this.isInitialized) await this.initialize();
        await this.refreshAccessTokenIfNeeded();

        console.log('[Kiro Internal] Sending internal message for summarization');

        // 检查消息是否有效
        if (!messages || messages.length === 0) {
            console.error('[Kiro Internal] No messages provided');
            throw new Error('No messages provided for summarization');
        }

        // 使用当前服务的默认模型（确保模型可用）
        // 不使用 SUMMARIZATION_MODEL 因为它可能不在 KIRO_MODELS 中
        const model = this.modelName;
        const codewhispererModel = MODEL_MAPPING[model];

        if (!codewhispererModel) {
            console.error('[Kiro Internal] No valid model mapping found for:', model);
            throw new Error(`No valid model mapping for ${model}`);
        }

        // 构建简单的请求体（不经过复杂的上下文管理）
        const conversationId = uuidv4();
        const userMessage = messages[messages.length - 1];

        // 安全地提取用户消息内容
        let userContent = '';
        if (typeof userMessage.content === 'string') {
            userContent = userMessage.content;
        } else if (Array.isArray(userMessage.content)) {
            userContent = userMessage.content
                .filter(c => c.type === 'text')
                .map(c => c.text || '')
                .join('\n');
        }

        // 构建历史消息（排除最后一条）
        const historyMessages = messages.slice(0, -1).map(msg => {
            let content = '';
            if (typeof msg.content === 'string') {
                content = msg.content;
            } else if (Array.isArray(msg.content)) {
                content = msg.content
                    .filter(c => c.type === 'text')
                    .map(c => c.text || '')
                    .join('\n');
            }
            return {
                role: msg.role === 'user' ? 'USER' : 'ASSISTANT',
                content: content.substring(0, 50000)  // 限制单条消息长度
            };
        }).filter(msg => msg.content);  // 过滤空消息

        const requestBody = {
            conversationState: {
                conversationId: conversationId,
                history: historyMessages,
                currentMessage: {
                    userInputMessage: {
                        content: userContent.substring(0, 100000),  // 限制长度
                        userIntent: 'GENERATE_SUMMARY'
                    }
                },
                chatTriggerType: 'MANUAL'
            },
            profileArn: this.profileArn || `arn:aws:codewhisperer:${this.region || 'us-east-1'}:${this.awsUserId || '000000000000'}:profile/default`
        };

        // 添加系统提示词（如果提供）
        if (systemPrompt) {
            requestBody.conversationState.systemPrompt = systemPrompt.substring(0, 50000);
        }

        try {
            console.log('[Kiro Internal] Calling API with model:', codewhispererModel);
            const response = await this.callApi('', codewhispererModel, requestBody);
            const { responseText } = this._processApiResponse(response);

            return {
                content: responseText,
                role: 'assistant'
            };
        } catch (error) {
            console.error('[Kiro Internal] Error in sendMessageInternal:', error.message);
            // 不抛出错误，让调用方可以降级处理
            throw error;
        }
    }

    /**
     * 解析 AWS Event Stream 二进制头部
     * AWS Event Stream 格式:
     * - 12 bytes: Prelude (4B total length + 4B headers length + 4B CRC)
     * - N bytes: Headers (包含 :event-type, :content-type 等)
     * - M bytes: Payload (JSON 数据)
     * - 4 bytes: Message CRC
     */
    parseAwsEventStreamMessage(buffer, offset = 0) {
        if (buffer.length - offset < 16) {
            return null; // 不够一个完整消息
        }

        // 读取 Prelude (12 bytes)
        const totalLength = buffer.readUInt32BE(offset);
        const headersLength = buffer.readUInt32BE(offset + 4);
        const preludeCrc = buffer.readUInt32BE(offset + 8);

        // 检查是否有完整消息
        if (buffer.length - offset < totalLength) {
            return null;
        }

        // 解析 Headers
        let headerOffset = offset + 12;
        const headersEnd = headerOffset + headersLength;
        const headers = {};

        while (headerOffset < headersEnd) {
            const headerNameLength = buffer.readUInt8(headerOffset);
            headerOffset += 1;
            const headerName = buffer.toString('utf8', headerOffset, headerOffset + headerNameLength);
            headerOffset += headerNameLength;

            const headerValueType = buffer.readUInt8(headerOffset);
            headerOffset += 1;

            // Type 7 = string
            if (headerValueType === 7) {
                const headerValueLength = buffer.readUInt16BE(headerOffset);
                headerOffset += 2;
                const headerValue = buffer.toString('utf8', headerOffset, headerOffset + headerValueLength);
                headerOffset += headerValueLength;
                headers[headerName] = headerValue;
            } else {
                // 其他类型暂时跳过
                const headerValueLength = buffer.readUInt16BE(headerOffset);
                headerOffset += 2;
                headerOffset += headerValueLength;
            }
        }

        // 读取 Payload
        const payloadStart = offset + 12 + headersLength;
        const payloadEnd = offset + totalLength - 4; // 减去最后的 message CRC
        const payload = buffer.toString('utf8', payloadStart, payloadEnd);

        return {
            eventType: headers[':event-type'] || 'unknown',
            contentType: headers[':content-type'] || 'application/json',
            messageType: headers[':message-type'] || 'event',
            payload: payload,
            totalLength: totalLength,
            nextOffset: offset + totalLength
        };
    }

    /**
     * 解析 AWS Event Stream 格式，提取所有完整的 JSON 事件
     * 返回 { events: 解析出的事件数组, remaining: 未处理完的缓冲区 }
     */
    parseAwsEventStreamBuffer(buffer) {
        const events = [];
        let offset = 0;

        while (offset < buffer.length) {
            const message = this.parseAwsEventStreamMessage(buffer, offset);
            if (!message) {
                // 没有完整消息了，返回剩余部分
                return {
                    events: events,
                    remaining: buffer.slice(offset)
                };
            }

            offset = message.nextOffset;

            // 根据事件类型和 payload 构造事件
            try {
                const parsed = JSON.parse(message.payload);

                // 注释掉频繁的日志以提升流式性能
                // console.log(`[Kiro Debug] 事件类型: ${message.eventType} | Payload:`, JSON.stringify(parsed).substring(0, 100));

                // 根据事件类型处理
                if (message.eventType === 'assistantResponseEvent') {
                    // 普通内容事件
                    if (parsed.content !== undefined) {
                        events.push({
                            type: 'content',
                            data: parsed.content
                        });
                    }
                } else if (message.eventType === 'toolUseEvent') {
                    // 工具调用事件
                    // ⚠️ 完美复刻官方 Kiro (extension.js:708085-708123)：
                    //   - 每次 toolUseEvent 都处理（不管是否重复）
                    //   - 每次都传递完整事件（name, toolUseId, input）
                    //   - 在 generateContentStream 层用 Set 判断是否第一次
                    //   - 只在第一次添加 id/name，但每次都处理 input
                    //
                    // 不再拆分成多个小事件，而是保持完整的 toolUseEvent 结构
                    events.push({
                        type: 'toolUse',
                        data: {
                            name: parsed.name,
                            toolUseId: parsed.toolUseId,
                            input: parsed.input || '',  // 每次都传递 input（可能为空）
                            stop: parsed.stop || false
                        }
                    });
                } else if (message.eventType === 'meteringEvent') {
                    // Token 计量事件
                    if (parsed.usage !== undefined) {
                        events.push({
                            type: 'metering',
                            data: {
                                usage: parsed.usage,
                                unit: parsed.unit
                            }
                        });
                    }
                } else if (message.eventType === 'reasoningContentEvent') {
                    // ⭐ Thinking 事件！（目前 Kiro API 不返回）
                    // console.log('[Kiro Debug] ⭐ 发现 reasoningContentEvent!', parsed);
                    const thinkingText = parsed.text || parsed.reasoningText || '';
                    if (thinkingText) {
                        events.push({
                            type: 'thinking',
                            data: { thinking: thinkingText }
                        });
                    }
                } else if (message.eventType === 'followupPromptEvent') {
                    // Followup prompt 事件
                    if (parsed.followupPrompt !== undefined) {
                        events.push({
                            type: 'followup',
                            data: parsed.followupPrompt
                        });
                    }
                } else if (message.eventType === 'codeReferenceEvent') {
                    // ⭐ 代码引用追踪事件（官方 Kiro 特性）
                    // console.log('[Kiro Debug] ⭐ 发现 codeReferenceEvent!', parsed);
                    if (parsed.references && Array.isArray(parsed.references)) {
                        // 过滤有效引用（必须包含许可证、仓库、URL）
                        const validReferences = parsed.references.filter(ref =>
                            ref.licenseName && ref.repository && ref.url
                        );
                        if (validReferences.length > 0) {
                            events.push({
                                type: 'codeReference',
                                data: {
                                    references: validReferences
                                }
                            });
                        }
                    }
                } else if (message.eventType === 'messageMetadataEvent') {
                    // Metadata 事件
                    if (parsed.conversationId) {
                        events.push({
                            type: 'metadata',
                            data: { conversationId: parsed.conversationId }
                        });
                    }
                }
            } catch (e) {
                console.warn(`[Kiro Debug] 解析 payload 失败 (${message.eventType}):`, e.message);
            }
        }

        return {
            events: events,
            remaining: Buffer.alloc(0)
        };
    }

    /**
     * 旧版解析逻辑（作为后备）
     */
    parseAwsEventStreamBuffer_OLD(buffer) {
        const events = [];
        let remaining = buffer;
        let searchStart = 0;
        
        while (true) {
            // 查找真正的 JSON payload 起始位置
            // AWS Event Stream 包含二进制头部，我们只搜索有效的 JSON 模式
            // Kiro 返回格式: {"content":"..."} 或 {"name":"xxx","toolUseId":"xxx",...} 或 {"followupPrompt":"..."}
            
            // 搜索所有可能的 JSON payload 开头模式
            // Kiro 返回的 toolUse 可能分多个事件：
            // 1. {"name":"xxx","toolUseId":"xxx"} - 开始
            // 2. {"input":"..."} - input 数据（可能多次）
            // 3. {"stop":true} - 结束
            const contentStart = remaining.indexOf('{"content":', searchStart);
            const nameStart = remaining.indexOf('{"name":', searchStart);
            const followupStart = remaining.indexOf('{"followupPrompt":', searchStart);
            const inputStart = remaining.indexOf('{"input":', searchStart);
            const stopStart = remaining.indexOf('{"stop":', searchStart);
            const thinkingStart = remaining.indexOf('{"thinking":', searchStart);
            const reasoningEventStart = remaining.indexOf('{"reasoningContentEvent":', searchStart);

            // 找到最早出现的有效 JSON 模式
            const candidates = [contentStart, nameStart, followupStart, inputStart, stopStart, thinkingStart, reasoningEventStart].filter(pos => pos >= 0);
            if (candidates.length === 0) break;
            
            const jsonStart = Math.min(...candidates);
            if (jsonStart < 0) break;
            
            // 正确处理嵌套的 {} - 使用括号计数法
            let braceCount = 0;
            let jsonEnd = -1;
            let inString = false;
            let escapeNext = false;
            
            for (let i = jsonStart; i < remaining.length; i++) {
                const char = remaining[i];
                
                if (escapeNext) {
                    escapeNext = false;
                    continue;
                }
                
                if (char === '\\') {
                    escapeNext = true;
                    continue;
                }
                
                if (char === '"') {
                    inString = !inString;
                    continue;
                }
                
                if (!inString) {
                    if (char === '{') {
                        braceCount++;
                    } else if (char === '}') {
                        braceCount--;
                        if (braceCount === 0) {
                            jsonEnd = i;
                            break;
                        }
                    }
                }
            }
            
            if (jsonEnd < 0) {
                // 不完整的 JSON，保留在缓冲区等待更多数据
                remaining = remaining.substring(jsonStart);
                break;
            }
            
            const jsonStr = remaining.substring(jsonStart, jsonEnd + 1);
            try {
                const parsed = JSON.parse(jsonStr);

                // 注释掉频繁的调试日志以提升流式性能
                // const eventKeys = Object.keys(parsed).join(',');
                // if (!eventKeys.includes('followupPrompt')) {
                //     console.log('[Kiro Debug] 事件字段:', eventKeys, '| 前50字符:', jsonStr.substring(0, 50));
                // }

                // 特别标记 reasoning 相关事件
                // if (eventKeys.includes('reasoning') || eventKeys.includes('Reasoning')) {
                //     console.log('[Kiro Debug] ⭐ 发现 Reasoning 事件! 完整内容:', JSON.stringify(parsed, null, 2));
                // }

                // 处理 content 事件
                if (parsed.content !== undefined && !parsed.followupPrompt) {
                    // 处理转义字符
                    let decodedContent = parsed.content;
                    // 无须处理转义的换行符，原来要处理是因为智能体返回的 content 需要通过换行符切割不同的json
                    // decodedContent = decodedContent.replace(/(?<!\\)\\n/g, '\n');
                    events.push({ type: 'content', data: decodedContent });
                }
                // 处理结构化工具调用事件 - 开始事件（包含 name 和 toolUseId）
                else if (parsed.name && parsed.toolUseId) {
                    events.push({ 
                        type: 'toolUse', 
                        data: {
                            name: parsed.name,
                            toolUseId: parsed.toolUseId,
                            input: parsed.input || '',
                            stop: parsed.stop || false
                        }
                    });
                }
                // 处理工具调用的 input 续传事件（只有 input 字段）
                else if (parsed.input !== undefined && !parsed.name) {
                    events.push({
                        type: 'toolUseInput',
                        data: {
                            input: parsed.input
                        }
                    });
                }
                // 处理工具调用的结束事件（只有 stop 字段）
                else if (parsed.stop !== undefined) {
                    events.push({
                        type: 'toolUseStop',
                        data: {
                            stop: parsed.stop
                        }
                    });
                }
                // 处理thinking/reasoning事件
                else if (parsed.thinking !== undefined || parsed.reasoningContent !== undefined || parsed.reasoningText !== undefined) {
                    const thinkingText = parsed.thinking || parsed.reasoningContent || parsed.reasoningText;
                    events.push({
                        type: 'thinking',
                        data: {
                            thinking: thinkingText
                        }
                    });
                }
                // 处理 reasoningContentEvent（官方 Kiro API 格式）
                else if (parsed.reasoningContentEvent !== undefined) {
                    const reasoningEvent = parsed.reasoningContentEvent;
                    const thinkingText = reasoningEvent.text || reasoningEvent.reasoningText || '';
                    if (thinkingText) {
                        events.push({
                            type: 'thinking',
                            data: {
                                thinking: thinkingText
                            }
                        });
                    }
                }
                // 处理 contextUsageEvent（AWS 返回的上下文使用百分比，Kiro 风格）
                else if (parsed.contextUsageEvent !== undefined) {
                    const contextUsage = parsed.contextUsageEvent.contextUsagePercentage;
                    if (contextUsage !== undefined) {
                        console.log();
                        // 存储到实例变量，供后续请求参考
                        this.lastContextUsagePercentage = contextUsage;
                        // 根据阈值发出警告
                        if (contextUsage > KIRO_CONSTANTS.CONTEXT_TRUNCATE_THRESHOLD) {
                            console.warn();
                        } else if (contextUsage > KIRO_CONSTANTS.CONTEXT_SUMMARIZE_THRESHOLD) {
                            console.warn();
                        }
                    }
                }
            } catch (e) {
                // JSON 解析失败，跳过这个位置继续搜索
            }
            
            searchStart = jsonEnd + 1;
            if (searchStart >= remaining.length) {
                remaining = '';
                break;
            }
        }
        
        // 如果 searchStart 有进展，截取剩余部分
        if (searchStart > 0 && remaining.length > 0) {
            remaining = remaining.substring(searchStart);
        }
        
        return { events, remaining };
    }

    /**
     * 真正的流式 API 调用 - 使用 responseType: 'stream'
     * 性能优化：避免每次循环都 Buffer.concat，改用累积后一次性合并
     */
    async * streamApiReal(method, model, body, isRetry = false, retryCount = 0) {
        if (!this.isInitialized) await this.initialize();
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;

        // 检查是否启用 thinking（从 body 或配置中读取）
        const enableThinking = body.thinking?.type === 'enabled' ||
                             body.extended_thinking === true ||
                             this.config.ENABLE_THINKING_BY_DEFAULT === true;
        const requestData = await this.buildCodewhispererRequest(body.messages, model, body.tools, body.system, enableThinking);

        const token = this.accessToken;
        const headers = {
            'Authorization': `Bearer ${token}`,
            'amz-sdk-invocation-id': `${uuidv4()}`,
        };

        const requestUrl = model.startsWith('amazonq') ? this.amazonQUrl : this.baseUrl;

        let stream = null;
        try {
            const response = await this.axiosInstance.post(requestUrl, requestData, {
                headers,
                responseType: 'stream',
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            });

            stream = response.data;
            let pendingBuffer = Buffer.alloc(0);  // 待处理的缓冲区
            let lastContentEvent = null;  // 用于检测连续重复的 content 事件

            for await (const chunk of stream) {
                // 高效合并：只合并 pending + 新 chunk，而不是所有历史 chunk
                pendingBuffer = pendingBuffer.length > 0
                    ? Buffer.concat([pendingBuffer, chunk])
                    : chunk;

                // 解析缓冲区中的事件
                const { events, remaining } = this.parseAwsEventStreamBuffer(pendingBuffer);

                // 更新 pending buffer 为未解析的部分
                pendingBuffer = remaining;

                // yield 所有事件，但过滤连续完全相同的 content 事件（Kiro API 有时会重复发送）
                for (const event of events) {
                    if (event.type === 'content' && event.data) {
                        // 检查是否与上一个 content 事件完全相同
                        if (lastContentEvent === event.data) {
                            // 跳过重复的内容
                            continue;
                        }
                        lastContentEvent = event.data;
                        yield { type: 'content', content: event.data };
                    } else if (event.type === 'thinking') {
                        // 转发thinking事件
                        yield { type: 'thinking', data: event.data };
                    } else if (event.type === 'toolUse') {
                        if (event.data) {
                            yield { type: 'toolUse', toolUse: event.data };
                        }
                    } else if (event.type === 'toolUseInput') {
                        if (event.data && event.data.input !== undefined) {
                            yield { type: 'toolUseInput', input: event.data.input, toolUseId: event.data.toolUseId };
                        }
                    } else if (event.type === 'toolUseStop') {
                        if (event.data && event.data.stop !== undefined) {
                            yield { type: 'toolUseStop', stop: event.data.stop, toolUseId: event.data.toolUseId };
                        }
                    }
                }
            }
        } catch (error) {
            // 确保出错时关闭流
            if (stream && typeof stream.destroy === 'function') {
                stream.destroy();
            }
            
            if (error.response?.status === 403 && !isRetry) {
                console.log('[Kiro] Received 403 in stream. Attempting token refresh and retrying...');
                await this.initializeAuth(true);
                yield* this.streamApiReal(method, model, body, true, retryCount);
                return;
            }
            
            if (error.response?.status === 429 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                console.log(`[Kiro] Received 429 in stream. Retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            yield* this.streamApiReal(method, model, body, isRetry, retryCount + 1);
                return;
            }

            console.error('[Kiro] Stream API call failed:', error.message);
            throw error;
        } finally {
            // 确保流被关闭，释放资源
            if (stream && typeof stream.destroy === 'function') {
                stream.destroy();
            }
        }
    }

    // 保留旧的非流式方法用于 generateContent
    async streamApi(method, model, body, isRetry = false, retryCount = 0) {
        try {
            return await this.callApi(method, model, body, isRetry, retryCount);
        } catch (error) {
            console.error('[Kiro] Error calling API:', error);
            throw error;
        }
    }

    // 真正的流式传输实现
    async * generateContentStream(model, requestBody) {
        if (!this.isInitialized) await this.initialize();

        // 官方AWS SDK逻辑：检查并刷新token（5分钟窗口+30秒防抖）
        await this.refreshAccessTokenIfNeeded();

        // Kiro 官方逻辑：如果model在MODEL_MAPPING中则使用，否则使用默认模型
        const finalModel = MODEL_MAPPING[model] ? model : this.modelName;

        // 检查是否启用 thinking（通过 prompt injection 实现，支持配置默认启用）
        const enableThinking = requestBody.thinking?.type === 'enabled' ||
                             requestBody.extended_thinking === true ||
                             this.config.ENABLE_THINKING_BY_DEFAULT === true;
        console.log(`[Kiro] Calling generateContentStream with model: ${finalModel} (real streaming, thinking: ${enableThinking})`);

        const inputTokens = this.estimateInputTokens(requestBody);
        const messageId = `${uuidv4()}`;
        
        try {
            // 1. 先发送 message_start 事件
            yield {
                type: "message_start",
                message: {
                    id: messageId,
                    type: "message",
                    role: "assistant",
                    model: model,
                    usage: { input_tokens: inputTokens, output_tokens: 0 },
                    content: []
                }
            };

            let totalContent = '';
            let outputTokens = 0;
            const toolCalls = [];
            let currentToolCall = null;  // 用于累积结构化工具调用
            const seenToolUseIds = new Set();  // ⚠️ CRITICAL: 追踪所有见过的 toolUseId（参考官方 Kiro 客户端）
            let thinkingContent = '';  // 用于累积thinking内容
            let thinkingBlockIndex = null;  // thinking块的索引
            let textBlockStarted = false;  // 标记text块是否已开始
            const codeReferences = [];  // 用于累积代码引用

            // Thinking 解析状态（用于 prompt injection 模式）
            let contentBuffer = '';  // 用于缓冲内容以解析 <thinking> 标签
            let insideThinkingTag = false;  // 是否在 <thinking> 标签内
            let thinkingTagClosed = false;  // <thinking> 标签是否已关闭
            let thinkingBlockClosed = false;  // thinking 块是否已关闭（用于避免重复关闭）

            // 2-3. 流式接收并发送每个事件
            for await (const event of this.streamApiReal('', finalModel, requestBody)) {
                // Debug: 记录所有事件类型
                console.log(`[Kiro Debug] Event received: type=${event.type}`);

                if (event.type === 'thinking') {
                    // 处理原生thinking块（API直接返回的，目前Kiro不支持）
                    if (thinkingBlockIndex === null) {
                        // 第一次收到thinking，发送content_block_start
                        thinkingBlockIndex = 0;  // thinking总是第一个块
                        yield {
                            type: "content_block_start",
                            index: thinkingBlockIndex,
                            content_block: { type: "thinking", thinking: "" }
                        };
                    }

                    thinkingContent += event.data.thinking;

                    // 发送thinking delta
                    yield {
                        type: "content_block_delta",
                        index: thinkingBlockIndex,
                        delta: { type: "thinking_delta", thinking: event.data.thinking }
                    };
                } else if (event.type === 'content' && event.content) {
                    // Kiro 优化：HTML 转义处理
                    const unescapedContent = unescapeHTML(event.content);

                    // 如果启用了 thinking prompt injection，需要解析 <thinking> 标签
                    if (enableThinking) {
                        contentBuffer += unescapedContent;

                        // 处理 content buffer，解析 <thinking> 标签
                        while (true) {
                            if (!insideThinkingTag) {
                                // 当前不在 thinking 标签内，查找 <thinking> 开始标签
                                const thinkingStartIdx = contentBuffer.indexOf('<thinking>');

                                if (thinkingStartIdx === -1) {
                                    // 没有找到开始标签，但要留一些缓冲以防标签被分割
                                    // 保留最后 15 个字符（"<thinking>" 长度为 10）
                                    if (contentBuffer.length > 15 && thinkingTagClosed) {
                                        const textToEmit = contentBuffer.slice(0, -15);
                                        contentBuffer = contentBuffer.slice(-15);

                                        if (textToEmit) {
                                            // 发送 text 内容
                                            if (!textBlockStarted) {
                                                const textBlockIndex = thinkingContent ? 1 : 0;
                                                yield {
                                                    type: "content_block_start",
                                                    index: textBlockIndex,
                                                    content_block: { type: "text", text: "" }
                                                };
                                                textBlockStarted = true;
                                            }

                                            totalContent += textToEmit;
                                            const textBlockIndex = thinkingContent ? 1 : 0;
                                            yield {
                                                type: "content_block_delta",
                                                index: textBlockIndex,
                                                delta: { type: "text_delta", text: textToEmit }
                                            };
                                        }
                                    }
                                    break; // 退出循环，等待更多数据
                                }

                                // 找到 <thinking> 开始标签
                                // 先发送标签之前的文本内容
                                if (thinkingStartIdx > 0) {
                                    const textBeforeThinking = contentBuffer.slice(0, thinkingStartIdx);

                                    if (textBeforeThinking.trim()) {
                                        // 发送 text 内容
                                        if (!textBlockStarted) {
                                            const textBlockIndex = thinkingContent ? 1 : 0;
                                            yield {
                                                type: "content_block_start",
                                                index: textBlockIndex,
                                                content_block: { type: "text", text: "" }
                                            };
                                            textBlockStarted = true;
                                        }

                                        totalContent += textBeforeThinking;
                                        const textBlockIndex = thinkingContent ? 1 : 0;
                                        yield {
                                            type: "content_block_delta",
                                            index: textBlockIndex,
                                            delta: { type: "text_delta", text: textBeforeThinking }
                                        };
                                    }
                                }

                                // 移除已处理的内容和 <thinking> 标签
                                contentBuffer = contentBuffer.slice(thinkingStartIdx + 10); // 10 = "<thinking>".length
                                insideThinkingTag = true;

                                // 开始 thinking 块
                                if (thinkingBlockIndex === null) {
                                    thinkingBlockIndex = 0;
                                    yield {
                                        type: "content_block_start",
                                        index: thinkingBlockIndex,
                                        content_block: { type: "thinking", thinking: "" }
                                    };
                                }
                            } else {
                                // 当前在 thinking 标签内，查找 </thinking> 结束标签
                                const thinkingEndIdx = contentBuffer.indexOf('</thinking>');

                                if (thinkingEndIdx === -1) {
                                    // 没有找到结束标签，发送当前缓冲的 thinking 内容
                                    // 保留最后 15 个字符以防标签被分割
                                    if (contentBuffer.length > 15) {
                                        const thinkingToEmit = contentBuffer.slice(0, -15);
                                        contentBuffer = contentBuffer.slice(-15);

                                        if (thinkingToEmit) {
                                            thinkingContent += thinkingToEmit;
                                            yield {
                                                type: "content_block_delta",
                                                index: thinkingBlockIndex,
                                                delta: { type: "thinking_delta", thinking: thinkingToEmit }
                                            };
                                        }
                                    }
                                    break; // 退出循环，等待更多数据
                                }

                                // 找到 </thinking> 结束标签
                                // 发送标签之前的 thinking 内容
                                if (thinkingEndIdx > 0) {
                                    const thinkingBeforeEnd = contentBuffer.slice(0, thinkingEndIdx);
                                    thinkingContent += thinkingBeforeEnd;
                                    yield {
                                        type: "content_block_delta",
                                        index: thinkingBlockIndex,
                                        delta: { type: "thinking_delta", thinking: thinkingBeforeEnd }
                                    };
                                }

                                // 结束 thinking 块
                                yield { type: "content_block_stop", index: thinkingBlockIndex };
                                thinkingBlockClosed = true;

                                // 移除已处理的内容和 </thinking> 标签
                                contentBuffer = contentBuffer.slice(thinkingEndIdx + 11); // 11 = "</thinking>".length
                                insideThinkingTag = false;
                                thinkingTagClosed = true;
                            }
                        }
                    } else {
                        // 不启用 thinking，直接发送内容
                        // 如果之前有thinking块但还没结束，先结束它
                        if (thinkingBlockIndex !== null && thinkingContent && !textBlockStarted) {
                            yield { type: "content_block_stop", index: thinkingBlockIndex };
                        }

                        // 第一次收到content时，发送text块的content_block_start
                        if (!textBlockStarted) {
                            const textBlockIndex = thinkingContent ? 1 : 0;
                            yield {
                                type: "content_block_start",
                                index: textBlockIndex,
                                content_block: { type: "text", text: "" }
                            };
                            textBlockStarted = true;
                        }

                        totalContent += event.content;

                        const textBlockIndex = thinkingContent ? 1 : 0;
                        yield {
                            type: "content_block_delta",
                            index: textBlockIndex,
                            delta: { type: "text_delta", text: event.content }
                        };
                    }
                } else if (event.type === 'toolUse') {
                    // 工具调用事件（完美复刻官方 Kiro extension.js:708085-708123）
                    console.log(`[Kiro Debug] ⭐ toolUse event received:`, JSON.stringify(event).substring(0, 200));
                    const tc = event.toolUse;
                    console.log(`[Kiro Debug] toolUse - tc.toolUseId: ${tc?.toolUseId}, name: ${tc?.name}, input length: ${tc?.input?.length || 0}, stop: ${tc?.stop}`);

                    if (tc && tc.toolUseId) {
                        // ⚠️ 完美复刻官方逻辑（extension.js:708090）：
                        // if (!toolCalls.has(toolUseId)) { 添加 id/name } else { 只处理 input }

                        if (!seenToolUseIds.has(tc.toolUseId)) {
                            // 第一次遇到这个 toolUseId
                            seenToolUseIds.add(tc.toolUseId);
                            console.log(`[Kiro Debug] toolUse - first time seeing toolUseId ${tc.toolUseId}, added to Set (total: ${seenToolUseIds.size})`);

                            // 如果有未完成的工具调用，先保存它
                            if (currentToolCall) {
                                console.log(`[Kiro Debug] toolUse - saving previous tool call: ${currentToolCall.name}, accumulated ${currentToolCall.input.length} chars`);
                                try {
                                    currentToolCall.input = JSON.parse(currentToolCall.input);
                                } catch (e) {}
                                toolCalls.push(currentToolCall);
                            }

                            // 创建新的 currentToolCall（设置 id/name）
                            currentToolCall = {
                                toolUseId: tc.toolUseId,
                                name: tc.name || 'unknown',
                                input: ''
                            };
                            console.log(`[Kiro Debug] toolUse - created new currentToolCall: ${currentToolCall.name}, id: ${currentToolCall.toolUseId}`);
                        } else {
                            // 重复的 toolUseId，只处理 input（不重新设置 id/name）
                            console.log(`[Kiro Debug] toolUse - duplicate toolUseId ${tc.toolUseId}, only accumulating input`);
                        }

                        // ⚠️ 关键：每次都累积 input（无论是否第一次）
                        // 官方：args: chatEvent.toolUseEvent.input（每次都传递）
                        if (currentToolCall && tc.input) {
                            const beforeLength = currentToolCall.input.length;
                            currentToolCall.input += tc.input;
                            const afterLength = currentToolCall.input.length;
                            console.log(`[Kiro Debug] toolUse - accumulated input: ${beforeLength} -> ${afterLength} (added ${afterLength - beforeLength} chars)`);
                        }

                        // 如果有 stop 标志，保存 currentToolCall
                        if (tc.stop && currentToolCall) {
                            console.log(`[Kiro Debug] toolUse - stop flag detected, finalizing tool call (input length: ${currentToolCall.input.length})`);
                            try {
                                currentToolCall.input = JSON.parse(currentToolCall.input);
                                console.log(`[Kiro Debug] toolUse - JSON parse success`);
                            } catch (e) {
                                console.log(`[Kiro] Warning: Failed to parse tool input JSON: ${e.message}`);
                            }
                            toolCalls.push(currentToolCall);
                            currentToolCall = null;
                        }
                    } else {
                        console.log(`[Kiro Debug] ⚠️ toolUse - missing toolUseId, skipping`);
                    }
                } else if (event.type === 'metering') {
                    // Token 计量事件
                    const meterData = event.data;
                    if (meterData.usage !== undefined) {
                        // Kiro 返回的是 credit usage，需要转换为 token
                        // 粗略估计：1 credit ≈ 1000 tokens（这个需要根据实际情况调整）
                        const estimatedTokens = Math.ceil(meterData.usage * 1000);
                        outputTokens = estimatedTokens;
                    }
                } else if (event.type === 'codeReference') {
                    // ⭐ 代码引用追踪事件（官方 Kiro 特性）
                    // 收集代码引用信息，用于开源许可证追踪和代码溯源
                    const references = event.data.references;
                    if (references && references.length > 0) {
                        codeReferences.push(...references);
                        console.log(`[Kiro] Code references detected: ${references.length} sources`);
                    }
                }
            }

            // 处理未完成的工具调用（如果流提前结束）
            if (currentToolCall) {
                try {
                    currentToolCall.input = JSON.parse(currentToolCall.input);
                } catch (e) {}
                toolCalls.push(currentToolCall);
                currentToolCall = null;
            }

            // 处理 thinking 模式下剩余的 content buffer
            if (enableThinking && contentBuffer.length > 0) {
                if (insideThinkingTag) {
                    // 如果还在 thinking 标签内，发送剩余内容作为 thinking
                    thinkingContent += contentBuffer;
                    yield {
                        type: "content_block_delta",
                        index: thinkingBlockIndex,
                        delta: { type: "thinking_delta", thinking: contentBuffer }
                    };
                    // 结束 thinking 块
                    yield { type: "content_block_stop", index: thinkingBlockIndex };
                    thinkingBlockClosed = true;
                } else {
                    // 不在 thinking 标签内，发送剩余内容作为 text
                    if (contentBuffer.trim()) {
                        if (!textBlockStarted) {
                            const textBlockIndex = thinkingContent ? 1 : 0;
                            yield {
                                type: "content_block_start",
                                index: textBlockIndex,
                                content_block: { type: "text", text: "" }
                            };
                            textBlockStarted = true;
                        }

                        totalContent += contentBuffer;
                        const textBlockIndex = thinkingContent ? 1 : 0;
                        yield {
                            type: "content_block_delta",
                            index: textBlockIndex,
                            delta: { type: "text_delta", text: contentBuffer }
                        };
                    }
                }
                contentBuffer = '';
            }

            // 检查文本内容中的 bracket 格式工具调用
            const bracketToolCalls = parseBracketToolCalls(totalContent);
            if (bracketToolCalls && bracketToolCalls.length > 0) {
                for (const btc of bracketToolCalls) {
                    toolCalls.push({
                        toolUseId: btc.id || `tool_${uuidv4()}`,
                        name: btc.function.name,
                        input: JSON.parse(btc.function.arguments || '{}')
                    });
                }
            }

            // 3.5. 如果thinking块还没结束，先结束它
            if (thinkingBlockIndex !== null && thinkingContent && !textBlockStarted && !thinkingBlockClosed) {
                yield { type: "content_block_stop", index: thinkingBlockIndex };
                thinkingBlockClosed = true;
            }

            // 4. 发送 content_block_stop 事件（text块，如果有的话）
            if (textBlockStarted) {
                const textBlockIndex = thinkingContent ? 1 : 0;
                yield { type: "content_block_stop", index: textBlockIndex };
            }

            // 5. 处理工具调用（如果有）
            if (toolCalls.length > 0) {
                // 计算起始索引：thinking块(0或无) + text块(0或1)
                let startIndex = 0;
                if (thinkingContent) startIndex++;  // thinking块占用index 0
                if (textBlockStarted) startIndex++;  // text块占用下一个index

                for (let i = 0; i < toolCalls.length; i++) {
                    const tc = toolCalls[i];
                    const blockIndex = startIndex + i;

                    yield {
                        type: "content_block_start",
                        index: blockIndex,
                        content_block: {
                            type: "tool_use",
                            id: tc.toolUseId || `tool_${uuidv4()}`,
                            name: tc.name,
                            input: {}
                        }
                    };

                    // 官方Kiro做法：直接stringify，不做额外验证
                    const inputJson = typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input || {});

                    yield {
                        type: "content_block_delta",
                        index: blockIndex,
                        delta: {
                            type: "input_json_delta",
                            partial_json: inputJson
                        }
                    };

                    yield { type: "content_block_stop", index: blockIndex };
                }
            }

            // 6. 发送代码引用信息（如果有）
            // ⭐ Kiro 特性：追踪 AI 生成代码的来源，符合开源许可证要求
            if (codeReferences.length > 0) {
                yield {
                    type: "code_references",
                    references: codeReferences.map(ref => ({
                        license: ref.licenseName,
                        repository: ref.repository,
                        url: ref.url,
                        recommendationContentSpan: ref.recommendationContentSpan
                    }))
                };
                console.log(`[Kiro] Yielded ${codeReferences.length} code references`);
            }

            // 7. 发送 message_delta 事件
            // 在流结束后统一计算 output tokens，避免在流式循环中阻塞事件循环
            outputTokens = this.countTextTokens(totalContent);
            if (thinkingContent) {
                outputTokens += this.countTextTokens(thinkingContent);
            }
            for (const tc of toolCalls) {
                outputTokens += this.countTextTokens(JSON.stringify(tc.input || {}));
            }

            yield {
                type: "message_delta",
                delta: { stop_reason: toolCalls.length > 0 ? "tool_use" : "end_turn" },
                usage: { output_tokens: outputTokens }
            };

            // 8. 发送 message_stop 事件
            yield { type: "message_stop" };

        } catch (error) {
            console.error('[Kiro] Error in streaming generation:', error);
            console.error('[Kiro] Error stack:', error.stack);

            // ⚠️ CRITICAL FIX: 如果stream已经开始传输,不能throw error,应该yield error event
            // 这样客户端能看到错误信息而不是静默断开
            yield {
                type: "error",
                error: {
                    type: error.response?.status === 429 ? "rate_limit_error" :
                          error.response?.status === 403 ? "permission_error" :
                          error.response?.status === 401 ? "authentication_error" : "api_error",
                    message: error.message || "An error occurred during streaming"
                }
            };

            // 然后才throw,让上层知道stream失败了
            throw new Error(`Error processing response: ${error.message}`);
        }
    }

    /**
     * Count tokens for a given text using Claude's official tokenizer
     * @param {string} text - Text to count tokens for
     * @param {boolean} fast - If true, use fast character-based estimation instead of tokenizer
     */
    countTextTokens(text, fast = false) {
        if (!text) return 0;
        // 快速模式：使用字符估算，避免tokenizer开销
        if (fast) {
            // Claude tokenizer 实测：中文约 2.5 token/字，英文约 0.35 token/字符
            const chineseCharCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
            const totalLength = text.length;
            const nonChineseLength = totalLength - chineseCharCount;
            return Math.ceil(chineseCharCount * 2.5 + nonChineseLength * 0.35);
        }
        try {
            return countTokens(text);
        } catch (error) {
            // Fallback to estimation if tokenizer fails
            return Math.ceil((text || '').length / 4);
        }
    }

    /**
     * Calculate input tokens from request body
     * @param {Object} requestBody - Request body
     * @param {boolean} fast - If true, use fast character-based estimation
     */
    estimateInputTokens(requestBody, fast = true) {
        let totalTokens = 0;

        // Count system prompt tokens
        if (requestBody.system) {
            const systemText = this.getContentText(requestBody.system);
            totalTokens += this.countTextTokens(systemText, fast);
        }

        // Count all messages tokens
        if (requestBody.messages && Array.isArray(requestBody.messages)) {
            for (const message of requestBody.messages) {
                if (message.content) {
                    const contentText = this.getContentText(message);
                    totalTokens += this.countTextTokens(contentText, fast);
                }
            }
        }

        // Count tools definitions tokens if present
        if (requestBody.tools && Array.isArray(requestBody.tools)) {
            // 工具 token 估算：根据工具数量和描述长度
            if (fast) {
                let toolTokens = 0;
                for (const tool of requestBody.tools) {
                    toolTokens += 80; // 基础元数据（name, type 等）
                    if (tool.description) {
                        toolTokens += this.countTextTokens(tool.description, true);
                    }
                    // input_schema 估算：每个属性约 50 tokens（包括 description、type 等）
                    if (tool.input_schema?.properties) {
                        toolTokens += Object.keys(tool.input_schema.properties).length * 50;
                    }
                }
                totalTokens += toolTokens;
            } else {
                totalTokens += this.countTextTokens(JSON.stringify(requestBody.tools), false);
            }
        }

        return totalTokens;
    }

    /**
     * Build Claude compatible response object
     */
    buildClaudeResponse(content, isStream = false, role = 'assistant', model, toolCalls = null, inputTokens = 0) {
        const messageId = `${uuidv4()}`;

        if (isStream) {
            // Kiro API is "pseudo-streaming", so we'll send a few events to simulate
            // a full Claude stream, but the content/tool_calls will be sent in one go.
            const events = [];

            // 1. message_start event
            events.push({
                type: "message_start",
                message: {
                    id: messageId,
                    type: "message",
                    role: role,
                    model: model,
                    usage: {
                        input_tokens: inputTokens,
                        output_tokens: 0 // Will be updated in message_delta
                    },
                    content: [] // Content will be streamed via content_block_delta
                }
            });
 
            let totalOutputTokens = 0;
            let stopReason = "end_turn";

            if (content) {
                // If there are tool calls AND content, the content block index should be after tool calls
                const contentBlockIndex = (toolCalls && toolCalls.length > 0) ? toolCalls.length : 0;

                // 2. content_block_start for text
                events.push({
                    type: "content_block_start",
                    index: contentBlockIndex,
                    content_block: {
                        type: "text",
                        text: "" // Initial empty text
                    }
                });
                // 3. content_block_delta for text
                events.push({
                    type: "content_block_delta",
                    index: contentBlockIndex,
                    delta: {
                        type: "text_delta",
                        text: content
                    }
                });
                // 4. content_block_stop
                events.push({
                    type: "content_block_stop",
                    index: contentBlockIndex
                });
                totalOutputTokens += this.countTextTokens(content);
                // If there are tool calls, the stop reason remains "tool_use".
                // If only content, it's "end_turn".
                if (!toolCalls || toolCalls.length === 0) {
                    stopReason = "end_turn";
                }
            }

            if (toolCalls && toolCalls.length > 0) {
                toolCalls.forEach((tc, index) => {
                    let inputObject;
                    try {
                        // Arguments should be a stringified JSON object.
                        inputObject = tc.function.arguments;
                    } catch (e) {
                        console.warn(`[Kiro] Invalid JSON for tool call arguments. Wrapping in raw_arguments. Error: ${e.message}`, tc.function.arguments);
                        // If parsing fails, wrap the raw string in an object as a fallback,
                        // since Claude's `input` field expects an object.
                        inputObject = { "raw_arguments": tc.function.arguments };
                    }
                    // 2. content_block_start for each tool_use
                    events.push({
                        type: "content_block_start",
                        index: index,
                        content_block: {
                            type: "tool_use",
                            id: tc.id,
                            name: tc.function.name,
                            input: {} // input is streamed via input_json_delta
                        }
                    });
                    
                    // 3. content_block_delta for each tool_use
                    // Since Kiro is not truly streaming, we send the full arguments as one delta.
                    events.push({
                        type: "content_block_delta",
                        index: index,
                        delta: {
                            type: "input_json_delta",
                            partial_json: inputObject
                        }
                    });
 
                    // 4. content_block_stop for each tool_use
                    events.push({
                        type: "content_block_stop",
                        index: index
                    });
                    totalOutputTokens += this.countTextTokens(JSON.stringify(inputObject));
                });
                stopReason = "tool_use"; // If there are tool calls, the stop reason is tool_use
            }

            // 5. message_delta with appropriate stop reason
            events.push({
                type: "message_delta",
                delta: {
                    stop_reason: stopReason,
                    stop_sequence: null,
                },
                usage: { output_tokens: totalOutputTokens }
            });

            // 6. message_stop event
            events.push({
                type: "message_stop"
            });

            return events; // Return an array of events for streaming
        } else {
            // Non-streaming response (full message object)
            const contentArray = [];
            let stopReason = "end_turn";
            let outputTokens = 0;

            if (toolCalls && toolCalls.length > 0) {
                for (const tc of toolCalls) {
                    let inputObject;
                    try {
                        // Arguments should be a stringified JSON object.
                        inputObject = tc.function.arguments;
                    } catch (e) {
                        console.warn(`[Kiro] Invalid JSON for tool call arguments. Wrapping in raw_arguments. Error: ${e.message}`, tc.function.arguments);
                        // If parsing fails, wrap the raw string in an object as a fallback,
                        // since Claude's `input` field expects an object.
                        inputObject = { "raw_arguments": tc.function.arguments };
                    }
                    contentArray.push({
                        type: "tool_use",
                        id: tc.id,
                        name: tc.function.name,
                        input: inputObject
                    });
                    outputTokens += this.countTextTokens(tc.function.arguments);
                }
                stopReason = "tool_use"; // Set stop_reason to "tool_use" when toolCalls exist
            } else if (content) {
                contentArray.push({
                    type: "text",
                    text: content
                });
                outputTokens += this.countTextTokens(content);
            }

            return {
                id: messageId,
                type: "message",
                role: role,
                model: model,
                stop_reason: stopReason,
                stop_sequence: null,
                usage: {
                    input_tokens: inputTokens,
                    output_tokens: outputTokens
                },
                content: contentArray
            };
        }
    }

    /**
     * List available models
     */
    async listModels() {
        const models = KIRO_MODELS.map(id => ({
            name: id
        }));
        
        return { models: models };
    }

    /**
     * Checks if the given expiresAt timestamp is within 10 minutes from now.
     * @returns {boolean} - True if expiresAt is less than 10 minutes from now, false otherwise.
     */
    isExpiryDateNear() {
        try {
            const expirationTime = new Date(this.expiresAt);
            const currentTime = new Date();
            const cronNearMinutesInMillis = (this.config.CRON_NEAR_MINUTES || 10) * 60 * 1000;
            const thresholdTime = new Date(currentTime.getTime() + cronNearMinutesInMillis);
            console.log(`[Kiro] Expiry date: ${expirationTime.getTime()}, Current time: ${currentTime.getTime()}, ${this.config.CRON_NEAR_MINUTES || 10} minutes from now: ${thresholdTime.getTime()}`);
            return expirationTime.getTime() <= thresholdTime.getTime();
        } catch (error) {
            console.error(`[Kiro] Error checking expiry date: ${this.expiresAt}, Error: ${error.message}`);
            return false; // Treat as expired if parsing fails
        }
    }

    /**
     * 获取用量限制信息
     * @returns {Promise<Object>} 用量限制信息
     */
    async getUsageLimits() {
        if (!this.isInitialized) await this.initialize();
        
        // 官方AWS SDK逻辑：检查并刷新token（5分钟窗口+30秒防抖）
        await this.refreshAccessTokenIfNeeded();
        
        // 内部固定的资源类型
        const resourceType = 'AGENTIC_REQUEST';
        
        // 构建请求 URL
        const usageLimitsUrl = KIRO_CONSTANTS.USAGE_LIMITS_URL.replace('{{region}}', this.region);
        const params = new URLSearchParams({
            isEmailRequired: 'true',
            origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
            resourceType: resourceType
        });
         if (this.authMethod === KIRO_CONSTANTS.AUTH_METHOD_SOCIAL) {
            params.append('profileArn', this.profileArn);
        }
        const fullUrl = `${usageLimitsUrl}?${params.toString()}`;

        // 构建请求头
        const headers = {
            'amz-sdk-invocation-id': uuidv4(),
            'Authorization': `Bearer ${this.accessToken}`,
        };

        try {
            const response = await this.axiosInstance.get(fullUrl, { headers });
            console.log('[Kiro] Usage limits fetched successfully');
            return response.data;
        } catch (error) {
            // 如果是 403 错误，尝试刷新 token 后重试
            if (error.response?.status === 403) {
                console.log('[Kiro] Received 403 on getUsageLimits. Attempting token refresh and retrying...');
                try {
                    await this.initializeAuth(true);
                    // 更新 Authorization header
                    headers['Authorization'] = `Bearer ${this.accessToken}`;
                    headers['amz-sdk-invocation-id'] = uuidv4();
                    const retryResponse = await this.axiosInstance.get(fullUrl, { headers });
                    console.log('[Kiro] Usage limits fetched successfully after token refresh');
                    return retryResponse.data;
                } catch (refreshError) {
                    console.error('[Kiro] Token refresh failed during getUsageLimits retry:', refreshError.message);
                    throw refreshError;
                }
            }
            console.error('[Kiro] Failed to fetch usage limits:', error.message);
            throw error;
        }
    }
}
