/**
 * Kiro 风格的 AI 摘要模块
 * 参考官方 Kiro extension.js:711693-711902
 *
 * 提供智能的对话摘要功能，替代简单的 100 字符截断
 */

// 摘要指令模板（复刻 Kiro getSummarizationInstructions）
export const SUMMARIZATION_INSTRUCTIONS = `You are preparing a summary for a new agent instance who will pick up this conversation.

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

// 摘要系统提示词
export const SUMMARIZATION_SYSTEM_PROMPT = `[SYSTEM NOTE: This is an automated summarization request due to context limit]

IMPORTANT: Context limit reached. You MUST create a structured summary.

Format your response using markdown syntax for better readability:
- Use ## for task headers (e.g., "## TASK 1: Description")
- Use **bold** for field labels (e.g., "**STATUS**:", "**DETAILS**:")
- Use \`code\` formatting for file paths
- Use bullet lists with - for items

${SUMMARIZATION_INSTRUCTIONS}

Review the conversation history and create a comprehensive summary.`;

// 系统内容模式（需要过滤掉的）
export const SYSTEM_CONTENT_PATTERNS = [
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

// 需要截断输出的工具名
export const TRUNCATE_TOOL_NAMES = [
    'Read', 'ReadFile', 'ReadMultipleFiles',
    'Bash', 'executeBash', 'executePwsh',
    'Grep', 'GrepSearch',
    'Glob', 'LSP'
];

/**
 * 检查是否是需要截断的工具
 */
export function shouldTruncateToolResult(toolName) {
    if (!toolName) return false;
    if (toolName.startsWith('mcp_')) return true;
    return TRUNCATE_TOOL_NAMES.some(t => toolName.toLowerCase().includes(t.toLowerCase()));
}

/**
 * 检查内容是否包含系统注入的模式
 */
export function containsSystemContent(text) {
    if (!text) return false;
    return SYSTEM_CONTENT_PATTERNS.some(pattern => text.includes(pattern));
}

/**
 * 提取用户查询（复刻 Kiro extractUserQueries）
 */
export function extractUserQueries(messages) {
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

/**
 * 提取有用信息（复刻 Kiro extractUsefulInformation）
 */
export function extractUsefulInformation(messages) {
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

/**
 * 生成对话摘要（复刻 Kiro _summarizationNode）
 *
 * @param {Array} messages - 需要摘要的消息
 * @param {Object} kiroApiInstance - Kiro API 实例（用于发送摘要请求）
 * @returns {Promise<string|null>} - 摘要文本，失败返回 null
 */
export async function generateConversationSummary(messages, kiroApiInstance) {
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

    // 降级：如果 AI 摘要失败，返回 null
    console.log('[Kiro Summarize] Falling back to simple truncation');
    return null;
}

/**
 * 构建带摘要的新消息历史（复刻 Kiro CONTEXT TRANSFER 格式）
 *
 * @param {string} summary - 摘要内容
 * @param {Array} recentMessages - 最近的消息（不参与摘要）
 * @param {number} originalMessageCount - 原始消息数量
 * @returns {Array} - 新的消息数组
 */
export function buildMessagesWithSummary(summary, recentMessages, originalMessageCount = 0) {
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
        // 需要一个 assistant ack 来保持对话格式
        const ackMessage = {
            role: 'assistant',
            content: 'I understand the context. Continuing with the work.'
        };
        return [summaryMessage, ackMessage, ...recentMessages];
    }
}

/**
 * 简单的消息摘要（降级方案，100字符截断）
 *
 * @param {Object} message - 消息对象
 * @returns {string|Array} - 截断后的内容
 */
export function simpleMessageSummary(message) {
    const content = message.content;

    if (Array.isArray(content)) {
        const textContent = content
            .filter(part => part.type === 'text' && part.text)
            .map(part => part.text)
            .join('');
        const truncated = `${textContent.substring(0, 100)}...`;
        return [{ type: 'text', text: truncated }];
    }

    return `${content.substring(0, 100)}...`;
}

/**
 * 摘要配置常量
 */
export const SUMMARIZATION_CONFIG = {
    MIN_MESSAGES_TO_KEEP: 5,           // 摘要时保留最近的消息数量
    SUMMARIZATION_MODEL: 'claude-sonnet-4-5-20250929',  // 用于生成摘要的模型
    SUMMARIZE_THRESHOLD_PERCENT: 70,   // 达到 70% 时触发摘要
    MIN_MESSAGES_FOR_SUMMARY: 8,       // 至少 8 条消息才触发 AI 摘要
    SUMMARIZATION_COOLDOWN_MS: 3 * 60 * 1000,  // 摘要冷却时间 3 分钟
    MAX_EXTRACTED_INFO_LENGTH: 50000,  // 提取信息的最大长度
};
