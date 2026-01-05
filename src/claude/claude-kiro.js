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
// 导入公共摘要模块
import {
    buildMessagesWithSummary,
    SUMMARIZATION_CONFIG
} from './summarization.js';

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

    // Kiro 风格的上下文窗口管理配置
    // 测试结果: AWS 实际限制约 223K tokens (720K chars 失败，710K chars 成功)
    MAX_CONTEXT_TOKENS: 200000,       // 200K（AWS 限制 ~223K，留缓冲）
    AUTO_SUMMARIZE_THRESHOLD: 0.80,   // 80% = 160K 时开始 pruning
    CONTEXT_FILE_LIMIT: 0.75,        // 上下文文件限制为 75% 窗口（和 Kiro 一致）
    MIN_MESSAGES_TO_KEEP: 5,         // 摘要时保留最近的消息数量
    SUMMARIZATION_MODEL: 'claude-sonnet-4-5-20250929',  // 用于生成摘要的模型（更快更便宜）

    // 官方 Kiro 输出限制（extension.js:766436）- 防止 tool_result 内容过长导致 400 错误
    MAX_TOOL_OUTPUT_LENGTH: 64000,   // 64K 字符，和官方 Kiro 一致

    // ============================================================================
    // 自适应超时配置（借鉴 KiroGate）
    // ============================================================================
    SLOW_MODELS: ['claude-opus-4-5', 'claude-3-opus', 'opus'],  // 慢模型列表
    SLOW_MODEL_TIMEOUT_MULTIPLIER: 3.0,  // 慢模型超时倍数
    FIRST_TOKEN_TIMEOUT: 120000,    // 首字超时 120 秒
    FIRST_TOKEN_MAX_RETRIES: 3,     // 首字超时最大重试次数
    STREAM_READ_TIMEOUT: 300000,    // 流读取超时 300 秒

    // ============================================================================
    // 长文档分段配置（借鉴 KiroGate）
    // ============================================================================
    AUTO_CHUNKING_ENABLED: true,     // 是否启用自动分段
    AUTO_CHUNK_THRESHOLD: 150000,    // 触发分段的字符数阈值（150K）
    CHUNK_MAX_CHARS: 100000,         // 每个分段最大字符数（100K）
    CHUNK_OVERLAP_CHARS: 2000,       // 分段重叠字符数
};

// ============================================================================
// 自适应超时函数（借鉴 KiroGate）
// ============================================================================

/**
 * 根据模型类型获取自适应超时时间
 * 对于 Opus 等慢模型，自动增加超时时间
 */
function getAdaptiveTimeout(model, baseTimeout) {
    if (!model) return baseTimeout;

    const modelLower = model.toLowerCase();
    for (const slowModel of KIRO_CONSTANTS.SLOW_MODELS) {
        if (modelLower.includes(slowModel.toLowerCase())) {
            const adaptiveTimeout = baseTimeout * KIRO_CONSTANTS.SLOW_MODEL_TIMEOUT_MULTIPLIER;
            console.log(`[Kiro] Slow model detected (${model}), timeout: ${baseTimeout}ms -> ${adaptiveTimeout}ms`);
            return adaptiveTimeout;
        }
    }
    return baseTimeout;
}

// ============================================================================
// 长文档分段处理（借鉴 KiroGate）
// ============================================================================

/**
 * 检查文本是否需要分段
 */
function needsChunking(text) {
    return KIRO_CONSTANTS.AUTO_CHUNKING_ENABLED &&
           text &&
           text.length > KIRO_CONSTANTS.AUTO_CHUNK_THRESHOLD;
}

/**
 * 在目标位置附近找到合适的分割点（优先在段落/句子边界）
 */
function findSplitPoint(text, targetPos) {
    if (targetPos >= text.length) return text.length;

    const searchStart = Math.max(0, targetPos - 500);
    const searchEnd = Math.min(text.length, targetPos + 500);
    const searchText = text.substring(searchStart, searchEnd);

    // 优先级 1：段落边界（双换行）
    const paragraphBreaks = [...searchText.matchAll(/\n\n+/g)];
    if (paragraphBreaks.length > 0) {
        const best = paragraphBreaks.reduce((a, b) =>
            Math.abs((searchStart + a.index + a[0].length) - targetPos) <
            Math.abs((searchStart + b.index + b[0].length) - targetPos) ? a : b
        );
        return searchStart + best.index + best[0].length;
    }

    // 优先级 2：句子边界
    const sentenceBreaks = [...searchText.matchAll(/[.!?。！？]\s+/g)];
    if (sentenceBreaks.length > 0) {
        const best = sentenceBreaks.reduce((a, b) =>
            Math.abs((searchStart + a.index + a[0].length) - targetPos) <
            Math.abs((searchStart + b.index + b[0].length) - targetPos) ? a : b
        );
        return searchStart + best.index + best[0].length;
    }

    // 优先级 3：单换行
    const lineBreaks = [...searchText.matchAll(/\n/g)];
    if (lineBreaks.length > 0) {
        const best = lineBreaks.reduce((a, b) =>
            Math.abs((searchStart + a.index + 1) - targetPos) <
            Math.abs((searchStart + b.index + 1) - targetPos) ? a : b
        );
        return searchStart + best.index + 1;
    }

    return targetPos;
}

/**
 * 将长文本分割成多个片段
 */
function splitLongText(text) {
    if (!needsChunking(text)) {
        return [text];
    }

    const chunks = [];
    let currentPos = 0;
    const maxChars = KIRO_CONSTANTS.CHUNK_MAX_CHARS;
    const overlap = KIRO_CONSTANTS.CHUNK_OVERLAP_CHARS;

    while (currentPos < text.length) {
        let chunkEnd = currentPos + maxChars;

        if (chunkEnd >= text.length) {
            chunks.push(text.substring(currentPos));
            break;
        }

        // 找到合适的分割点
        const splitPos = findSplitPoint(text, chunkEnd);
        chunks.push(text.substring(currentPos, splitPos));

        // 移动到下一个位置（考虑重叠）
        currentPos = splitPos - overlap;
        if (currentPos <= 0 || currentPos >= splitPos) {
            currentPos = splitPos;
        }
    }

    console.log(`[Kiro] Split long document into ${chunks.length} chunks (total: ${text.length} chars)`);
    return chunks;
}

/**
 * 为分段创建带上下文的提示词
 */
function createChunkPrompt(chunk, chunkIndex, totalChunks, originalPrompt) {
    if (totalChunks === 1) {
        return `${originalPrompt}\n\n${chunk}`;
    }

    const contextInfo = `[文档片段 ${chunkIndex + 1}/${totalChunks}]`;
    let instruction;

    if (chunkIndex === 0) {
        instruction = '这是一个长文档的第一部分。请处理这部分内容，后续会提供剩余部分。';
    } else if (chunkIndex === totalChunks - 1) {
        instruction = '这是文档的最后一部分。请结合之前的内容完成处理。';
    } else {
        instruction = `这是文档的第 ${chunkIndex + 1} 部分。请继续处理。`;
    }

    return `${contextInfo}\n${instruction}\n\n${originalPrompt}\n\n---\n${chunk}\n---`;
}

// Thinking 功能的提示词模板（通过 prompt injection 实现，参考 cifang）
// 优化版本：在简洁和效果之间平衡（~80 tokens）
const THINKING_PROMPT_TEMPLATE = `在回复之前，请在 <thinking>...</thinking> 标签内进行深入分析：
- 将复杂任务分解为清晰的步骤
- 考虑边界情况和潜在问题
- 确保工具参数完全符合要求
然后提供经过充分思考的回复。`;

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

// ============================================================================
// CC→Kiro 工具映射表
// Claude Code 发送 30+ 工具，Kiro 只支持 ~15 个
// 通过映射减少工具数量，避免 400 错误
// ============================================================================

const CC_TO_KIRO_TOOL_MAPPING = {
    // ===== 直接映射（参数名转换）=====
    'Read': {
        kiroTool: 'readFile',
        paramMap: { file_path: 'path', offset: 'start_line', limit: 'end_line' },
        description: 'Read file content'
    },
    'Write': {
        kiroTool: 'fsWrite',
        paramMap: { file_path: 'path', content: 'text' },
        description: 'Write file'
    },
    'Edit': {
        kiroTool: 'strReplace',
        paramMap: { file_path: 'path', old_string: 'oldStr', new_string: 'newStr' },
        description: 'Replace text in file'
    },
    'Bash': {
        kiroTool: 'executeBash',
        paramMap: { command: 'command', timeout: 'timeout' },
        description: 'Execute shell command'
    },
    'Glob': {
        kiroTool: 'fileSearch',
        paramMap: { pattern: 'query' },
        description: 'Search files by pattern'
    },
    'Grep': {
        kiroTool: 'grepSearch',
        paramMap: { pattern: 'query', path: 'includePattern' },
        description: 'Search content in files'
    },
    'LS': {
        kiroTool: 'listDirectory',
        paramMap: { path: 'path' },
        description: 'List directory'
    },
    'AskUserQuestion': {
        kiroTool: 'userInput',
        paramMap: { question: 'question' },
        description: 'Ask user for input'
    },

    // ===== 特殊处理 =====
    'Task': {
        kiroTool: 'invokeSubAgent',
        paramMap: { subagent_type: 'name', prompt: 'prompt', description: 'explanation' },
        description: 'Invoke sub-agent for complex tasks'
    },
    'LSP': { remove: true, reason: 'Kiro getDiagnostics is not equivalent to CC LSP operations' },
    'KillShell': {
        kiroTool: 'controlProcess',
        paramMap: { shell_id: 'processId' },
        fixedParams: { action: 'stop' },
        description: 'Stop background process'
    },
    'TaskOutput': {
        kiroTool: 'getProcessOutput',
        paramMap: { task_id: 'processId' },
        description: 'Get process output'
    },

    // ===== Builtin 工具（服务端模拟）=====
    'WebSearch': {
        kiroTool: 'webSearch',
        paramMap: { query: 'query' },
        description: 'Search the web for information (server-side implementation)',
        serverSideExecute: true  // 标记为服务端执行
    },
    'WebFetch': { remove: true, reason: 'AWS CodeWhisperer does not support builtin tools' },

    // ===== 不支持的工具（移除）=====
    'TodoWrite': { remove: true, reason: 'Not supported by Kiro' },
    'TodoRead': { remove: true, reason: 'Not supported by Kiro' },
    'EnterPlanMode': { remove: true, reason: 'Not supported by Kiro' },
    'ExitPlanMode': { remove: true, reason: 'Not supported by Kiro' },
    'NotebookEdit': { remove: true, reason: 'Not supported by Kiro' },
    'Skill': { remove: true, reason: 'CC internal only' },

    // ===== 降级处理 =====
    'NotebookRead': {
        kiroTool: 'readFile',
        paramMap: { notebook_path: 'path' },
        description: 'Read notebook as file'
    },
};

// Kiro 官方工具的简洁 Schema（从 extension.js 提取）
// 注意：只保留 CC 也支持的参数，避免 CC 验证失败
const KIRO_TOOL_SCHEMAS = {
    readFile: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Path to file to read' },
            start_line: { type: 'number', description: 'Starting line number (optional)' },
            end_line: { type: 'number', description: 'Ending line number (optional)' }
            // 移除 explanation - CC 不支持
        },
        required: ['path']
    },
    fsWrite: {
        type: 'object',
        properties: {
            path: { type: 'string' },
            text: { type: 'string' }
        },
        required: ['path', 'text']
    },
    strReplace: {
        type: 'object',
        properties: {
            path: { type: 'string' },
            oldStr: { type: 'string' },
            newStr: { type: 'string' }
        },
        required: ['path', 'oldStr', 'newStr']
    },
    grepSearch: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'The regex pattern to search for' },
            includePattern: { type: 'string', description: 'Glob pattern for files to include' }
            // 移除 caseSensitive, excludePattern, explanation - CC 用不同的参数名
        },
        required: ['query']
    },
    fileSearch: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'The glob pattern to search for' }
            // 移除 explanation, excludePattern, includeIgnoredFiles - CC 不支持
        },
        required: ['query']
    },
    executeBash: {
        type: 'object',
        properties: {
            command: { type: 'string', description: 'Shell command to execute' },
            timeout: { type: 'number', description: 'Command timeout in milliseconds' }
            // 移除 path, ignoreWarning - CC 不支持
        },
        required: ['command']
    },
    listDirectory: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Path to directory' }
            // 移除 explanation, depth - CC 不支持
        },
        required: ['path']
    },
    userInput: {
        type: 'object',
        properties: {
            question: { type: 'string', description: 'The question to ask the user' },
            options: { type: 'array', items: { type: 'string' }, description: 'Predefined choices for the user' }
            // 移除 reason - CC 不支持
        },
        required: ['question']
    },
    getDiagnostics: {
        type: 'object',
        properties: {
            paths: { type: 'array', items: { type: 'string' } }
        },
        required: ['paths']
    },
    controlProcess: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['start', 'stop', 'restart'] },
            command: { type: 'string' },
            processId: { type: 'string' }
        },
        required: ['action']
    },
    getProcessOutput: {
        type: 'object',
        properties: {
            processId: { type: 'string' },
            lines: { type: 'number' }
        },
        required: ['processId']
    },
    invokeSubAgent: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'name of the agent to invoke' },
            prompt: { type: 'string', description: 'The instruction or question for the agent' },
            explanation: { type: 'string', description: 'One or two sentences explaining why this tool is being used' }
        },
        required: ['name', 'prompt', 'explanation']
    },
    // ===== 服务端模拟工具 =====
    webSearch: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'The search query' }
        },
        required: ['query']
    }
};

const KIRO_AUTH_TOKEN_FILE = "kiro-auth-token.json";

// ===== 服务端 Web Search 实现 =====
// 支持的搜索方式：DuckDuckGo (免费), Bing (需要 API Key)
const WEB_SEARCH_CONFIG = {
    // 搜索引擎选择：'duckduckgo' | 'bing' | 'google'
    engine: process.env.WEB_SEARCH_ENGINE || 'duckduckgo',
    // Bing Search API Key (可选)
    bingApiKey: process.env.BING_API_KEY || '',
    // 最大结果数
    maxResults: parseInt(process.env.WEB_SEARCH_MAX_RESULTS) || 5,
    // 超时时间 (ms)
    timeout: 10000
};

/**
 * 服务端 Web Search 函数
 * @param {string} query - 搜索查询
 * @returns {Promise<{success: boolean, results: Array, error?: string}>}
 */
async function executeWebSearch(query, verboseLogging = false) {
    if (verboseLogging) {
        console.log(`[Kiro WebSearch] Executing search: "${query}"`);
    }

    try {
        // 优先使用 Bing API (如果配置了 API Key)
        if (WEB_SEARCH_CONFIG.bingApiKey) {
            return await bingSearch(query, verboseLogging);
        }

        // 否则使用 DuckDuckGo (免费，无需 API Key)
        return await duckDuckGoSearch(query, verboseLogging);
    } catch (error) {
        console.error('[Kiro WebSearch] Error:', error.message);
        return {
            success: false,
            results: [],
            error: error.message
        };
    }
}

/**
 * DuckDuckGo 搜索 (免费，无需 API Key)
 * 使用 DuckDuckGo HTML 搜索页面抓取结果
 */
async function duckDuckGoSearch(query, verboseLogging = false) {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    const response = await axios.get(url, {
        timeout: WEB_SEARCH_CONFIG.timeout,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
    });

    const html = response.data;
    const results = [];

    // 简单的 HTML 解析提取搜索结果
    // DuckDuckGo HTML 格式: <a class="result__a" href="...">Title</a>
    const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

    let match;
    while ((match = resultRegex.exec(html)) !== null && results.length < WEB_SEARCH_CONFIG.maxResults) {
        const url = match[1];
        const title = match[2].replace(/<[^>]*>/g, '').trim();
        const snippet = match[3].replace(/<[^>]*>/g, '').trim();

        if (url && title && !url.startsWith('/')) {
            results.push({ title, url, snippet });
        }
    }

    // 如果正则没匹配到，尝试另一种模式
    if (results.length === 0) {
        const altRegex = /<a[^>]*class="[^"]*result[^"]*"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi;
        while ((match = altRegex.exec(html)) !== null && results.length < WEB_SEARCH_CONFIG.maxResults) {
            const url = match[1];
            const title = match[2].trim();
            if (url && title && url.startsWith('http')) {
                results.push({ title, url, snippet: '' });
            }
        }
    }

    if (verboseLogging) {
        console.log(`[Kiro WebSearch] DuckDuckGo found ${results.length} results`);
    }

    return {
        success: true,
        results,
        source: 'DuckDuckGo'
    };
}

/**
 * Bing Search API (需要 API Key)
 */
async function bingSearch(query, verboseLogging = false) {
    const url = 'https://api.bing.microsoft.com/v7.0/search';

    const response = await axios.get(url, {
        timeout: WEB_SEARCH_CONFIG.timeout,
        params: {
            q: query,
            count: WEB_SEARCH_CONFIG.maxResults,
            responseFilter: 'Webpages'
        },
        headers: {
            'Ocp-Apim-Subscription-Key': WEB_SEARCH_CONFIG.bingApiKey
        }
    });

    const results = (response.data.webPages?.value || []).map(item => ({
        title: item.name,
        url: item.url,
        snippet: item.snippet
    }));

    if (verboseLogging) {
        console.log(`[Kiro WebSearch] Bing found ${results.length} results`);
    }

    return {
        success: true,
        results,
        source: 'Bing'
    };
}

/**
 * 将搜索结果格式化为可读文本
 */
function formatSearchResults(searchResult) {
    if (!searchResult.success) {
        return `Search failed: ${searchResult.error || 'Unknown error'}`;
    }

    if (searchResult.results.length === 0) {
        return 'No results found.';
    }

    let text = `Found ${searchResult.results.length} results (via ${searchResult.source}):\n\n`;

    searchResult.results.forEach((result, index) => {
        text += `${index + 1}. **${result.title}**\n`;
        text += `   URL: ${result.url}\n`;
        if (result.snippet) {
            text += `   ${result.snippet}\n`;
        }
        text += '\n';
    });

    return text;
}

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

async function getOriginalMacAddressSha256() {
    const networkInterfaces = os.networkInterfaces();
    let macAddress = '';

    for (const interfaceName in networkInterfaces) {
        const networkInterface = networkInterfaces[interfaceName];
        for (const iface of networkInterface) {
            if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
                macAddress = iface.mac;
                break;
            }
        }
        if (macAddress) break;
    }

    if (!macAddress) {
        console.warn("无法获取MAC地址，将使用默认值。");
        macAddress = '00:00:00:00:00:00';
    }

    const sha256Hash = crypto.createHash('sha256').update(macAddress).digest('hex');
    return sha256Hash;
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
    if (!toolCalls || toolCalls.length === 0) {
        return [];
    }

    // 第一步：按 id 去重，保留参数更完整的（借鉴 KiroGate）
    const byId = new Map();

    for (const tc of toolCalls) {
        const tcId = tc.id || tc.toolUseId;
        if (!tcId) {
            // 没有 id 的直接加入
            byId.set(`no-id-${byId.size}`, tc);
            continue;
        }

        const existing = byId.get(tcId);
        if (!existing) {
            byId.set(tcId, tc);
        } else {
            // 有重复 id，保留参数更完整的
            const existingArgs = existing.function?.arguments || existing.input || '{}';
            const currentArgs = tc.function?.arguments || tc.input || '{}';

            if (currentArgs !== '{}' && (existingArgs === '{}' || currentArgs.length > existingArgs.length)) {
                console.log(`[Kiro] Replacing tool call ${tcId} with better arguments: ${existingArgs.length} -> ${currentArgs.length} chars`);
                byId.set(tcId, tc);
            }
        }
    }

    // 第二步：按 name+arguments 去重
    const seen = new Set();
    const uniqueToolCalls = [];

    for (const tc of byId.values()) {
        const name = tc.function?.name || tc.name || '';
        const args = tc.function?.arguments || tc.input || '{}';
        const key = `${name}-${args}`;

        if (!seen.has(key)) {
            seen.add(key);
            uniqueToolCalls.push(tc);
        } else {
            console.log(`[Kiro] Skipping duplicate tool call: ${name}`);
        }
    }

    if (toolCalls.length !== uniqueToolCalls.length) {
        console.log(`[Kiro] Deduplicated tool calls: ${toolCalls.length} -> ${uniqueToolCalls.length}`);
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
        // 详细日志开关（默认关闭，只显示简洁日志）
        this.verboseLogging = config?.ENABLE_VERBOSE_LOGGING ?? false;
        console.log(`[Kiro] System proxy ${this.useSystemProxy ? 'enabled' : 'disabled'}`);
        console.log(`[Kiro] Verbose logging ${this.verboseLogging ? 'enabled' : 'disabled'}`);
        console.log(`[Kiro] ENABLE_THINKING_BY_DEFAULT in config: ${config.ENABLE_THINKING_BY_DEFAULT}`);

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
    }
 
    async initialize(skipAuthCheck = false) {
        if (this.isInitialized) return;
        console.log('[Kiro] Initializing Kiro API Service...');
        if (!skipAuthCheck) {
            await this.initializeAuth();
        }

        // 生成随机化的设备指纹
        const macSha256 = await getMacAddressSha256();
        const uaComponents = generateRandomUserAgentComponents();

        // 配置 HTTP/HTTPS agent 限制连接池大小，避免资源泄漏
        // ⚠️ 修复：减少 keepAlive 超时，避免连接失效后仍被复用
        const httpAgent = new http.Agent({
            keepAlive: true,
            keepAliveMsecs: 30000,  // keepAlive 探测间隔 30 秒
            maxSockets: 100,        // 每个主机最多 100 个连接
            maxFreeSockets: 5,      // 最多保留 5 个空闲连接
            timeout: 60000,         // 空闲连接 60 秒后关闭（减少到 1 分钟）
            scheduling: 'lifo'      // LIFO：优先使用最近的连接，减少失效连接复用
        });
        const httpsAgent = new https.Agent({
            keepAlive: true,
            keepAliveMsecs: 30000,
            maxSockets: 100,
            maxFreeSockets: 5,
            timeout: 60000,
            scheduling: 'lifo'
        });

        // 保存 agent 引用，用于后续销毁
        this.httpAgent = httpAgent;
        this.httpsAgent = httpsAgent;

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

    /**
     * 重置连接池（用于处理 socket 错误）
     * 销毁旧的 agent 并重新初始化
     */
    async resetConnectionPool() {
        console.log('[Kiro] Resetting connection pool...');

        // 销毁旧的 agent
        if (this.httpAgent) {
            this.httpAgent.destroy();
        }
        if (this.httpsAgent) {
            this.httpsAgent.destroy();
        }

        // 重新初始化
        this.isInitialized = false;
        await this.initialize();

        console.log('[Kiro] Connection pool reset completed');
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
        } catch (error) {
            console.error(`[Kiro Auth] Failed to write token to file ${filePath}: ${error.message}`);
        }
    }

async initializeAuth(forceRefresh = false) {
    if (this.accessToken && !forceRefresh) {
        console.debug('[Kiro Auth] Access token already available and not forced refresh.');
        return;
    }

    // Helper to load credentials from a file
    const loadCredentialsFromFile = async (filePath) => {
        try {
            const fileContent = await fs.readFile(filePath, 'utf8');
            return JSON.parse(fileContent);
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
            console.warn('[Kiro Auth] Region not found in credentials. Using default region us-east-1 for URLs.');
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
     * 反向映射 schema 参数名（Kiro → CC）
     * 用于将 Kiro schema 的参数名转换回 Claude Code 期望的参数名
     *
     * @param {Object} schema - Kiro schema
     * @param {Object} paramMap - 参数映射表（CC → Kiro）
     * @returns {Object} - 反向映射后的 schema
     */
    reverseMapSchema(schema, paramMap) {
        if (!schema || typeof schema !== 'object') {
            return schema;
        }

        // 创建反向映射表（Kiro → CC）
        const reverseMap = {};
        for (const [ccParam, kiroParam] of Object.entries(paramMap)) {
            reverseMap[kiroParam] = ccParam;
        }

        // 深拷贝 schema
        const newSchema = { ...schema };

        // 反向映射 properties 中的参数名
        if (newSchema.properties && typeof newSchema.properties === 'object') {
            const newProperties = {};
            for (const [key, value] of Object.entries(newSchema.properties)) {
                const newKey = reverseMap[key] || key;  // 如果有反向映射，使用 CC 参数名
                newProperties[newKey] = value;
            }
            newSchema.properties = newProperties;
        }

        // 反向映射 required 数组中的参数名
        if (Array.isArray(newSchema.required)) {
            newSchema.required = newSchema.required.map(param => reverseMap[param] || param);
        }

        return newSchema;
    }

    /**
     * 映射工具调用的参数名（Claude Code → Kiro）
     * 用于处理 tool_use 时将 CC 的参数名转换为 Kiro 的参数名
     *
     * @param {string} toolName - 工具名称
     * @param {Object} input - 原始输入参数
     * @returns {Object} - 映射后的参数
     */
    mapToolUseParams(toolName, input) {
        // 调试日志：特别追踪 Task 工具
        if (toolName === 'Task') {
            console.log(`[Kiro Task Debug] mapToolUseParams called with input:`, JSON.stringify(input));
        }

        // ⚠️ 关键修复：Kiro API 要求 toolUse 必须有 input 字段
        // 如果 input 是 undefined 或 null，返回空对象而不是 undefined
        if (input === undefined || input === null) {
            console.log(`[Kiro ParamMap] ${toolName}: input is ${input}, returning empty object`);
            return {};
        }

        if (typeof input !== 'object') {
            if (this.verboseLogging) {
                console.log(`[Kiro ParamMap] ${toolName}: input is not object (${typeof input}), wrapping in object`);
            }
            // 如果 input 是原始类型，包装成对象
            return { value: input };
        }

        const mapping = CC_TO_KIRO_TOOL_MAPPING[toolName];
        if (!mapping) {
            if (this.verboseLogging) {
                console.log(`[Kiro ParamMap] ${toolName}: no mapping found, using original input`);
            }
            return input;
        }

        // 调试日志：Task 工具的映射配置
        if (toolName === 'Task') {
            console.log(`[Kiro Task Debug] Found mapping:`, JSON.stringify(mapping));
        }

        const mappedInput = {};

        // 应用参数映射
        if (mapping.paramMap) {
            for (const [ccParam, kiroParam] of Object.entries(mapping.paramMap)) {
                if (input[ccParam] !== undefined) {
                    mappedInput[kiroParam] = input[ccParam];
                    if (this.verboseLogging || toolName === 'Task') {
                        console.log(`[Kiro ParamMap] ${toolName}: mapped ${ccParam} → ${kiroParam} = ${JSON.stringify(input[ccParam])}`);
                    }
                }
            }
        }

        // 添加未映射的参数（保持原样）
        for (const [key, value] of Object.entries(input)) {
            if (mappedInput[key] === undefined &&
                (!mapping.paramMap || !mapping.paramMap[key])) {
                mappedInput[key] = value;
            }
        }

        // 添加固定参数
        if (mapping.fixedParams) {
            Object.assign(mappedInput, mapping.fixedParams);
            if (this.verboseLogging) {
                console.log(`[Kiro ParamMap] ${toolName}: added fixed params:`, mapping.fixedParams);
            }
        }

        if (this.verboseLogging || toolName === 'Task') {
            console.log(`[Kiro ParamMap] ${toolName}: final mapped input:`, JSON.stringify(mappedInput));
        }
        return mappedInput;
    }

    /**
     * 反向映射工具调用的参数名（Kiro → Claude Code）
     * 用于将 Kiro 返回的 tool_use 参数转换回 CC 期望的格式
     *
     * @param {string} toolName - 工具名称（CC 格式）
     * @param {Object} input - Kiro 返回的参数
     * @returns {Object} - 反向映射后的参数（CC 格式）
     */
    reverseMapToolInput(toolName, input) {
        if (!input || typeof input !== 'object') {
            return input;
        }

        const mapping = CC_TO_KIRO_TOOL_MAPPING[toolName];
        if (!mapping || !mapping.paramMap) {
            return input;
        }

        // 创建反向映射表（Kiro → CC）
        const reverseMap = {};
        for (const [ccParam, kiroParam] of Object.entries(mapping.paramMap)) {
            reverseMap[kiroParam] = ccParam;
        }

        // Kiro 特有参数列表（这些参数在 Kiro 工具中存在，但 CC 工具中没有）
        // ⚠️ 包含 raw/raw_arguments 防止旧版代码或边缘情况创建的参数泄漏
        const kiroOnlyParams = ['explanation', 'ignoreWarning', 'depth', 'reason',
                                'caseSensitive', 'excludePattern', 'includeIgnoredFiles',
                                'raw', 'raw_arguments', 'value'];

        const reversedInput = {};

        for (const [key, value] of Object.entries(input)) {
            if (reverseMap[key]) {
                // 有反向映射：使用 CC 参数名
                reversedInput[reverseMap[key]] = value;
                if (this.verboseLogging) {
                    console.log(`[Kiro ReverseMap] ${toolName}: reversed ${key} → ${reverseMap[key]}`);
                }
            } else if (kiroOnlyParams.includes(key)) {
                // Kiro 特有参数：跳过
                if (this.verboseLogging) {
                    console.log(`[Kiro ReverseMap] ${toolName}: filtered out Kiro-only param: ${key}`);
                }
            } else {
                // 其他参数：保留（可能是 CC 和 Kiro 共有的参数，或者是新的参数）
                reversedInput[key] = value;
            }
        }

        if (this.verboseLogging) {
            console.log(`[Kiro ReverseMap] ${toolName}: reversed input:`, JSON.stringify(reversedInput));
        }
        return reversedInput;
    }

    /**
     * Kiro 优化：工具格式转换（支持多种输入格式，统一输出 toolSpecification）
     * 参考 Kiro 源码 extension.js:707778
     * 支持 OpenAI、Anthropic、LangChain、Kiro 原生等多种工具格式
     *
     * ⚠️ 重要：AWS CodeWhisperer API 只接受 toolSpecification 格式！
     * Anthropic 的 builtin tool 格式（如 { type: "bash_20250305", name: "bash" }）
     * 在 CodeWhisperer API 中会导致 400 Bad Request 错误。
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
            if (this.verboseLogging) {
                console.log(`[Kiro] Detected builtin tool: ${tool.name}, passing through without conversion`);
            }
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
            // 压缩 description
            if (tool.toolSpecification.description && tool.toolSpecification.description.length > maxDescLength) {
                tool.toolSpecification.description = tool.toolSpecification.description.substring(0, maxDescLength).trim() + '...';
            }
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
     * Kiro 优化：使用映射表转换工具
     * 优先使用 CC_TO_KIRO_TOOL_MAPPING 中的 Kiro 官方 schema
     * 如果没有映射，则降级到原始的 convertToQTool
     */
    convertToQToolWithMapping(tool, compressInputSchema, maxDescLength) {
        // 获取工具名（兼容多种格式）
        let toolName = null;
        let originalSchema = null;
        let originalDesc = null;

        if (tool.function?.name) {
            toolName = tool.function.name;
            originalSchema = tool.function.parameters;
            originalDesc = tool.function.description;
        } else if (tool.toolSpecification?.name) {
            toolName = tool.toolSpecification.name;
            originalSchema = tool.toolSpecification.inputSchema?.json;
            originalDesc = tool.toolSpecification.description;
        } else if (tool.name) {
            toolName = tool.name;
            originalSchema = tool.input_schema || tool.schema;
            originalDesc = tool.description;
        } else if (tool.id) {
            toolName = tool.id;
            originalSchema = tool.parameters || tool.schema;
            originalDesc = tool.description;
        }

        // 检查是否有映射
        const mapping = CC_TO_KIRO_TOOL_MAPPING[toolName];

        if (mapping && mapping.kiroTool) {
            // ⚠️ 关键修复：使用 CC 原始的 schema，不要用 Kiro 的 schema
            // 因为 CC 会根据返回的 schema 验证参数，如果使用 Kiro schema，
            // CC 会收到它不认识的参数（如 explanation, path），导致验证失败
            // 参数映射只在 mapToolUseParams 中进行（发送给 Kiro 时）

            // 压缩原始 schema
            const compressedSchema = originalSchema ? compressInputSchema(originalSchema) : { type: 'object', properties: {} };

            const desc = mapping.description || originalDesc || '';
            const truncatedDesc = desc.length > maxDescLength
                ? desc.substring(0, maxDescLength).trim() + '...'
                : desc;

            if (this.verboseLogging) {
                console.log(`[Kiro] Mapped tool: ${toolName} → ${mapping.kiroTool} (keeping original CC schema)`);
            }

            return {
                toolSpecification: {
                    name: toolName,  // 保持原工具名，因为 CC 会用原名调用
                    description: truncatedDesc,
                    inputSchema: { json: compressedSchema }
                }
            };
        }

        // 没有映射，使用原始的 convertToQTool 逻辑
        return this.convertToQTool(tool, compressInputSchema, maxDescLength);
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
     * 完全匹配官方 Kiro 源码的 message-history-sanitizer (extension.js:706680-706688)
     *
     * 官方处理流程：
     * 1. ensureStartsWithUserMessage - 确保以 user 消息开始
     * 2. removeEmptyUserMessages - 移除空的 user 消息
     * 3. reorderToolResultMessages - 重新排序工具结果
     * 4. ensureValidToolUsesAndResults - 确保工具调用有对应结果
     * 5. ensureAlternatingMessages - 确保消息交替
     * 6. ensureEndsWithUserMessage - 确保以 user 消息结束
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

        // Step 1: 确保以 user 消息开始（官方: ensureStartsWithUserMessage）
        if (result[0].role !== 'user') {
            sanitizeActions.push('prepend_hello');
            result.unshift({
                role: 'user',
                content: 'Hello'
            });
        }

        // Step 2: 移除空的 user 消息（官方: removeEmptyUserMessages）
        // 保留第一个 user 消息，即使为空
        const firstUserIndex = result.findIndex(m => m.role === 'user');
        const beforeEmpty = result.length;
        result = result.filter((message, index) => {
            if (message.role === 'assistant') return true;
            if (message.role === 'user' && index === firstUserIndex) return true;
            if (message.role === 'user') {
                const content = this.getContentText(message);
                const hasToolResults = Array.isArray(message.content) &&
                    message.content.some(p => p.type === 'tool_result');
                return (content && content.trim() !== '') || hasToolResults;
            }
            return true;
        });
        if (result.length < beforeEmpty) {
            sanitizeActions.push(`removed ${beforeEmpty - result.length} empty messages`);
        }

        // Step 2.5: 过滤格式错误/不完整的 assistant 消息内容
        const beforeInvalid = result.length;
        result = result.filter((message, index) => {
            // 只检查 assistant 消息
            if (message.role !== 'assistant') {
                return true;
            }

            // 如果是数组内容，保留（可能包含 tool_use 等）
            if (Array.isArray(message.content)) {
                return true;
            }

            // 检查字符串内容
            if (typeof message.content === 'string') {
                const content = message.content.trim();

                // 空内容已经在 Step 2 中过滤，这里再检查一次
                if (content === '') {
                    return false;
                }

                // 检查是否是不完整的 JSON（以 { 或 [ 开头但无法解析）
                if ((content.startsWith('{') || content.startsWith('['))) {
                    try {
                        JSON.parse(content);
                        // 能解析，说明是完整的 JSON，保留
                        return true;
                    } catch (e) {
                        // 无法解析，说明是不完整的 JSON，过滤掉
                        console.log(`[Kiro] Filtered invalid JSON content at message ${index}: ${content.substring(0, 50)}...`);
                        return false;
                    }
                }

                // 其他普通文本内容，保留
                return true;
            }

            return true;
        });
        if (result.length < beforeInvalid) {
            sanitizeActions.push(`removed ${beforeInvalid - result.length} invalid messages`);
        }

        // Step 3: 重新排序工具结果（官方: reorderToolResultMessages）
        // 确保 tool_result 紧跟在对应的 tool_use 之后
        result = this._reorderToolResultMessages(result);

        // Step 4: 确保工具调用有对应结果（官方: ensureValidToolUsesAndResults）
        result = this._ensureValidToolUsesAndResults(result);

        // Step 5: 确保消息交替（官方: ensureAlternatingMessages）
        const alternating = [result[0]];
        let insertedCount = 0;
        for (let i = 1; i < result.length; i++) {
            const prev = alternating[alternating.length - 1];
            const curr = result[i];

            if (prev.role === curr.role) {
                insertedCount++;
                // 相同 role 连续出现，插入对应消息（官方: UNDERSTOOD_MESSAGE / CONTINUE_MESSAGE）
                if (prev.role === 'user') {
                    alternating.push({
                        role: 'assistant',
                        content: 'understood'  // 官方 Kiro 用 "understood"
                    });
                } else {
                    alternating.push({
                        role: 'user',
                        content: 'Continue'  // 官方 Kiro 用 "Continue"
                    });
                }
            }
            alternating.push(curr);
        }
        if (insertedCount > 0) {
            sanitizeActions.push(`inserted ${insertedCount} alternating messages`);
        }

        // Step 6: 确保以 user 消息结束（官方: ensureEndsWithUserMessage）
        if (alternating[alternating.length - 1].role !== 'user') {
            sanitizeActions.push('append_continue');
            alternating.push({
                role: 'user',
                content: 'Continue'
            });
        }

        // 额外步骤：过滤掉不完整的 thinking 块（避免 signature 缺失错误）
        for (const message of alternating) {
            if (Array.isArray(message.content)) {
                message.content = message.content.filter(part => {
                    if (part.type !== 'thinking') {
                        return true;
                    }
                    return false;
                });
            }
        }

        // 只在有实际修改时输出一次汇总信息(减少日志噪音)
        if (sanitizeActions.length > 0 && this.verboseLogging) {
            console.log(`[Kiro] Message sanitization: ${sanitizeActions.join(', ')}`);
        }

        return alternating;
    }

    /**
     * 重新排序工具结果消息（官方 Kiro: reorderToolResultMessages）
     * 确保 tool_result 紧跟在对应的 tool_use 之后
     * @private
     */
    _reorderToolResultMessages(messages) {
        // 收集所有 tool_use 的位置和 ID
        const toolUseMap = new Map(); // toolUseId -> messageIndex
        const toolResultMap = new Map(); // toolUseId -> messageIndex

        for (let i = 0; i < messages.length; i++) {
            const message = messages[i];
            if (message.role === 'assistant' && Array.isArray(message.content)) {
                for (const part of message.content) {
                    if (part.type === 'tool_use' && part.id) {
                        toolUseMap.set(part.id, i);
                    }
                }
            } else if (message.role === 'user' && Array.isArray(message.content)) {
                for (const part of message.content) {
                    if (part.type === 'tool_result' && part.tool_use_id) {
                        if (!toolResultMap.has(part.tool_use_id)) {
                            toolResultMap.set(part.tool_use_id, i);
                        }
                    }
                }
            }
        }

        // 如果没有 tool_use，直接返回
        if (toolUseMap.size === 0) {
            return messages;
        }

        // 重新排序：确保 tool_result 紧跟在 tool_use 之后
        const result = [];
        const processed = new Set();

        for (let i = 0; i < messages.length; i++) {
            if (processed.has(i)) continue;

            const message = messages[i];
            result.push(message);
            processed.add(i);

            // 如果是包含 tool_use 的 assistant 消息，找到对应的 tool_result
            if (message.role === 'assistant' && Array.isArray(message.content)) {
                for (const part of message.content) {
                    if (part.type === 'tool_use' && part.id) {
                        const resultIndex = toolResultMap.get(part.id);
                        if (resultIndex !== undefined && resultIndex !== i + 1 && !processed.has(resultIndex)) {
                            result.push(messages[resultIndex]);
                            processed.add(resultIndex);
                        }
                    }
                }
            }
        }

        return result;
    }

    /**
     * 确保工具调用有对应结果（官方 Kiro: ensureValidToolUsesAndResults）
     * 如果 tool_use 没有对应的 tool_result，添加失败的结果
     * @private
     */
    _ensureValidToolUsesAndResults(messages) {
        const result = [];

        for (let i = 0; i < messages.length; i++) {
            const message = messages[i];
            result.push(message);

            // 检查 assistant 消息中的 tool_use
            if (message.role === 'assistant' && Array.isArray(message.content)) {
                const toolUses = message.content.filter(p => p.type === 'tool_use');

                if (toolUses.length > 0) {
                    // 检查下一条消息是否有对应的 tool_result
                    const nextMessage = i + 1 < messages.length ? messages[i + 1] : null;
                    const hasToolResults = nextMessage &&
                        nextMessage.role === 'user' &&
                        Array.isArray(nextMessage.content) &&
                        nextMessage.content.some(p => p.type === 'tool_result');

                    if (!hasToolResults) {
                        // 没有 tool_result，添加失败的结果（官方: FAILED_TOOL_USE_MESSAGE）
                        const failedToolResults = toolUses.map(tu => ({
                            type: 'tool_result',
                            tool_use_id: tu.id || `toolUse_${Math.random().toString(36).substr(2, 9)}`,
                            content: 'Tool execution failed',
                            is_error: true
                        }));

                        result.push({
                            role: 'user',
                            content: failedToolResults
                        });
                    }
                }
            }
        }

        return result;
    }

    /**
     * Kiro 风格的消息摘要（简单截断到 100 字符）
     * 参考: Kiro extension.js:161275-1280
     * 注意：不是 AI 摘要，只是简单截断，节省成本和时间
     *
     * ⚠️ 关键：保持原始 content 的格式（数组就保持数组，字符串就保持字符串）
     */
    /**
     * Kiro 官方的 pruneStringFromTop 实现：使用 tokenizer 精确裁剪
     * 保留字符串的最后 maxTokens 个 token
     */
    pruneStringFromTop(text, maxTokens) {
        try {
            const tokens = this.tokenizer.encode(text);
            if (tokens.length <= maxTokens) {
                return text;
            }
            // 保留最后 maxTokens 个 token
            const prunedTokens = tokens.slice(tokens.length - maxTokens);
            return this.tokenizer.decode(prunedTokens);
        } catch (error) {
            // Fallback: 字符估算
            console.warn('[Kiro Pruning] Tokenizer failed, using character estimation');
            const estimatedChars = Math.floor(maxTokens * 3.5);
            return text.substring(text.length - estimatedChars);
        }
    }

    /**
     * Kiro 官方的 summarize 实现：智能摘要消息内容
     * ⚠️ 关键：保留 tool_result 和 tool_use 的结构，只截断其内容
     */
    summarizeMessage(message) {
        const content = message.content;
        // ⚠️ 优化：提高截断阈值，减少信息丢失
        // 对于工具结果（代码、文件内容），保留更多内容
        const TEXT_TRUNCATE_LENGTH = 1000;      // 普通文本：1000 字符
        const TOOL_RESULT_TRUNCATE_LENGTH = 2000;  // 工具结果：2000 字符（代码更重要）

        if (Array.isArray(content)) {
            // ⚠️ 关键修复：保留 tool_result 和 tool_use 结构，只截断内容
            const summarizedContent = [];
            let hasToolParts = false;

            for (const part of content) {
                if (part.type === 'text' && part.text) {
                    // 截断文本内容
                    const truncated = part.text.length > TEXT_TRUNCATE_LENGTH
                        ? part.text.substring(0, TEXT_TRUNCATE_LENGTH) + '...'
                        : part.text;
                    summarizedContent.push({ type: 'text', text: truncated });
                } else if (part.type === 'tool_result') {
                    hasToolParts = true;
                    // 保留 tool_result 结构，但截断内容（保留更多）
                    const truncatedResult = {
                        type: 'tool_result',
                        tool_use_id: part.tool_use_id
                    };
                    if (part.content) {
                        if (typeof part.content === 'string') {
                            truncatedResult.content = part.content.length > TOOL_RESULT_TRUNCATE_LENGTH
                                ? part.content.substring(0, TOOL_RESULT_TRUNCATE_LENGTH) + '...[truncated]'
                                : part.content;
                        } else {
                            truncatedResult.content = '[content truncated]';
                        }
                    }
                    if (part.is_error) {
                        truncatedResult.is_error = part.is_error;
                    }
                    summarizedContent.push(truncatedResult);
                } else if (part.type === 'tool_use') {
                    hasToolParts = true;
                    // 保留 tool_use 结构
                    summarizedContent.push({
                        type: 'tool_use',
                        id: part.id,
                        name: part.name,
                        input: part.input  // 保留完整的 input
                    });
                } else {
                    // 其他类型直接保留
                    summarizedContent.push(part);
                }
            }

            return summarizedContent.length > 0 ? summarizedContent : [{ type: 'text', text: '...' }];
        }

        // 字符串格式，直接截断
        return `${content.substring(0, TRUNCATE_LENGTH)}...`;
    }

    /**
     * 使用 AI 进行智能摘要（异步方法）- 流式版本
     * 优先尝试 AI 摘要，失败后降级到传统裁剪
     *
     * 优化：使用流式请求复用现有连接，避免建立新连接的开销
     *
     * @param {Array} messages - 消息数组
     * @param {number} contextLength - 上下文长度限制
     * @param {number} reservedTokens - 预留 token 数
     * @returns {Promise<Array>} - 处理后的消息数组
     */
    async pruneChatHistoryWithAI(messages, contextLength, reservedTokens) {
        const minKeep = SUMMARIZATION_CONFIG.MIN_MESSAGES_TO_KEEP || 5;
        const minMessagesForSummary = SUMMARIZATION_CONFIG.MIN_MESSAGES_FOR_SUMMARY || 8;

        // 如果消息数量不足，直接使用传统裁剪
        if (messages.length < minMessagesForSummary) {
            return this.pruneChatHistory(messages, contextLength, reservedTokens);
        }

        // 检查冷却时间（避免频繁摘要）
        const now = Date.now();
        const cooldown = SUMMARIZATION_CONFIG.SUMMARIZATION_COOLDOWN_MS || 3 * 60 * 1000;
        if (this._lastSummarizationTime && (now - this._lastSummarizationTime) < cooldown) {
            return this.pruneChatHistory(messages, contextLength, reservedTokens);
        }

        try {
            // 分离：需要摘要的消息 vs 保留的最近消息
            const messagesToSummarize = messages.slice(0, -minKeep);
            const recentMessages = messages.slice(-minKeep);

            if (messagesToSummarize.length <= 3) {
                return this.pruneChatHistory(messages, contextLength, reservedTokens);
            }

            // 提取对话信息用于摘要
            const extractedInfo = this._extractConversationInfo(messagesToSummarize);

            // 限制总长度避免摘要请求本身超限
            let conversationData = extractedInfo;
            if (conversationData.length > 50000) {
                conversationData = conversationData.substring(0, 50000) + '\n[...truncated for summarization...]';
            }

            // 构建摘要请求
            const summaryPrompt = `[SYSTEM NOTE: Context limit reached. Create a structured summary.]

You are preparing a summary for a new agent instance who will pick up this conversation.

Organize the summary by TASKS/REQUESTS. For each distinct task:
- **SHORT DESCRIPTION**: Brief description of the task
- **STATUS**: done | in-progress | not-started | abandoned
- **DETAILS**: Key context, decisions made, current state
- **NEXT STEPS**: If in-progress, list remaining work
- **FILEPATHS**: Related files (use \`code\` formatting)

CONVERSATION DATA TO SUMMARIZE:
${conversationData}`;

            // ✅ 优化：使用流式请求，复用现有连接
            const summaryRequestBody = {
                messages: [{ role: 'user', content: summaryPrompt }],
                system: null,
                tools: null  // 摘要请求不需要工具
            };

            const summaryModel = SUMMARIZATION_CONFIG.SUMMARIZATION_MODEL || 'claude-sonnet-4-5-20250929';

            // ⚠️ 修复：增加超时时间到 60 秒（流式请求需要更多时间处理大量内容）
            // 之前 10 秒太短，导致摘要全部超时失败
            const SUMMARY_TIMEOUT_MS = 60000;
            let timeoutId;
            let aborted = false;

            console.log('[Kiro AI-Summary] Starting streaming summarization...');
            console.log(`[Kiro AI-Summary] Conversation data length: ${conversationData.length} chars`);
            const streamStartTime = Date.now();

            const summaryPromise = (async () => {
                const chunks = [];
                try {
                    for await (const event of this.streamApiReal('', summaryModel, summaryRequestBody)) {
                        if (aborted) break;
                        if (event.type === 'content' && event.content) {
                            chunks.push(event.content);
                        }
                    }
                    return chunks.join('');
                } catch (streamError) {
                    if (!aborted) throw streamError;
                    return null;
                }
            })();

            const timeoutPromise = new Promise((_, reject) => {
                timeoutId = setTimeout(() => {
                    aborted = true;
                    reject(new Error('Summary timeout after 60s'));
                }, SUMMARY_TIMEOUT_MS);
            });

            const summary = await Promise.race([summaryPromise, timeoutPromise]);
            clearTimeout(timeoutId);

            const streamDuration = Date.now() - streamStartTime;
            console.log(`[Kiro AI-Summary] Streaming completed in ${streamDuration}ms`);

            if (summary) {
                // 使用摘要 + 最近消息构建新的消息历史
                const originalCount = messages.length;
                const newMessages = buildMessagesWithSummary(summary, recentMessages, originalCount);
                this._lastSummarizationTime = now;
                console.log(`[Kiro AI-Summary] Success! Summary length: ${summary.length} chars`);
                return newMessages;
            }
        } catch (error) {
            console.error(`[Kiro AI-Summary] Failed:`, error.message);
        }

        // 降级：AI 摘要失败，使用传统裁剪
        return this.pruneChatHistory(messages, contextLength, reservedTokens);
    }

    /**
     * 提取对话信息用于摘要（内部辅助方法）
     * @param {Array} messages - 消息数组
     * @returns {string} - 提取的对话信息
     */
    _extractConversationInfo(messages) {
        const sections = [];

        for (const msg of messages) {
            if (typeof msg.content === 'string') {
                const role = msg.role === 'user' ? 'User' : 'Assistant';
                sections.push(`${role}: ${msg.content}\n`);
                continue;
            }

            if (!Array.isArray(msg.content)) continue;

            for (const entry of msg.content) {
                if (entry.type === 'text' && entry.text) {
                    const role = msg.role === 'user' ? 'User' : 'Assistant';
                    sections.push(`${role}: ${entry.text}\n`);
                }

                if (entry.type === 'tool_use') {
                    const args = entry.input ? JSON.stringify(entry.input).substring(0, 500) : 'no args';
                    sections.push(`Tool: ${entry.name || 'unknown'} - ${args}\n`);
                }

                if (entry.type === 'tool_result') {
                    const status = entry.is_error ? 'FAILED' : 'SUCCESS';
                    let responseMsg = '';
                    if (entry.content) {
                        const content = typeof entry.content === 'string'
                            ? entry.content
                            : JSON.stringify(entry.content);
                        responseMsg = ` - ${content.substring(0, 300)}`;
                    }
                    sections.push(`ToolResult: ${status}${responseMsg}\n`);
                }
            }
        }

        return sections.join('\n');
    }

    /**
     * Kiro 风格的消息历史修剪策略（传统方法，作为降级方案）
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

        // ⚠️ 关键修复：使用 getFullMessageTokens 计算完整 token 数（包括 tool_result）
        let totalTokens = tokensForCompletion + chatHistory.reduce((acc, message) => {
            return acc + this.getFullMessageTokens(message, true);
        }, 0);

        // 如果不超限，直接返回
        if (totalTokens <= contextLength) {
            return chatHistory;
        }

        // 阶段 1: 处理超长消息（> contextLength/3 的消息）
        const longestMessages = [...chatHistory];
        longestMessages.sort((a, b) => {
            // 使用完整 token 计算进行排序
            return this.getFullMessageTokens(b, true) - this.getFullMessageTokens(a, true);
        });

        const longerThanOneThird = longestMessages.filter(message => {
            return this.getFullMessageTokens(message, true) > contextLength / 3;
        });

        for (const message of longerThanOneThird) {
            const messageTokens = this.getFullMessageTokens(message, true);
            const deltaNeeded = totalTokens - contextLength;
            const distanceFromThird = messageTokens - contextLength / 3;
            const delta = Math.min(deltaNeeded, distanceFromThird);

            // ⚠️ 优化：如果消息包含 tool_result，直接清空 tool_result 内容而不是截断
            if (Array.isArray(message.content)) {
                let hasToolResult = false;
                for (const part of message.content) {
                    if (part.type === 'tool_result') {
                        hasToolResult = true;
                        // 截断 tool_result 内容
                        if (typeof part.content === 'string' && part.content.length > 500) {
                            part.content = part.content.substring(0, 500) + '\n[... content truncated for context limit ...]';
                        } else if (Array.isArray(part.content)) {
                            part.content = [{ type: 'text', text: '[... content truncated for context limit ...]' }];
                        }
                    }
                }
                if (hasToolResult) {
                    // 重新计算 token 并更新 totalTokens
                    const newTokens = this.getFullMessageTokens(message, true);
                    totalTokens -= (messageTokens - newTokens);
                    if (totalTokens <= contextLength) {
                        return chatHistory;
                    }
                    continue;
                }
            }

            // 对于纯文本消息，从顶部修剪
            const content = this.getContentText(message);
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
                return chatHistory;
            }
        }

        // 阶段 2: 保留最后 5 条消息，摘要前面的消息
        let i = 0;
        while (totalTokens > contextLength && i < chatHistory.length - 5) {
            const message = chatHistory[i];
            // ⚠️ 关键修复：使用完整 token 计算
            const oldTokens = this.getFullMessageTokens(message, true);
            const summarized = this.summarizeMessage(message);  // 传入整个 message
            const newTokens = this.countTextTokens(this.getContentText({ content: summarized }), true);

            message.content = summarized;  // summarized 已经是正确格式（数组或字符串）
            totalTokens = totalTokens - oldTokens + newTokens;
            i++;
        }

        if (totalTokens <= contextLength) {
            return chatHistory;
        }

        // 阶段 3: 删除最旧的消息（保留至少 5 条）
        while (chatHistory.length > 5 && totalTokens > contextLength) {
            const message = chatHistory.shift();
            // ⚠️ 关键修复：使用完整 token 计算
            totalTokens -= this.getFullMessageTokens(message, true);
        }

        if (totalTokens <= contextLength) {
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

            // ⚠️ 关键修复：使用完整 token 计算
            const oldTokens = this.getFullMessageTokens(message, true);
            const summarized = this.summarizeMessage(message);  // 传入整个 message
            const newTokens = this.countTextTokens(this.getContentText({ content: summarized }), true);

            message.content = summarized;  // summarized 已经是正确格式
            totalTokens = totalTokens - oldTokens + newTokens;
            i++;
        }

        if (totalTokens <= contextLength) {
            return chatHistory;
        }

        // 阶段 5: 继续删除旧消息（保留至少 1 条）
        while (totalTokens > contextLength && chatHistory.length > 1) {
            const message = chatHistory.shift();
            // ⚠️ 关键修复：使用完整 token 计算
            totalTokens -= this.getFullMessageTokens(message, true);
        }

        if (totalTokens <= contextLength) {
            return chatHistory;
        }

        // 阶段 6: 最终修剪第一条消息
        if (totalTokens > contextLength && chatHistory.length > 0) {
            const message = chatHistory[0];
            // ⚠️ 关键修复：使用完整 token 计算
            const currentMessageTokens = this.getFullMessageTokens(message, true);

            // ⚠️ FIX: 正确计算需要删除多少 tokens
            const tokensToRemove = totalTokens - contextLength;
            const targetMessageTokens = Math.max(100, currentMessageTokens - tokensToRemove); // 至少保留100 tokens

            // 如果消息包含 tool_result，直接截断
            if (Array.isArray(message.content)) {
                for (const part of message.content) {
                    if (part.type === 'tool_result') {
                        part.content = '[... content truncated ...]';
                    }
                }
            }

            const content = this.getContentText(message);
            const estimatedChars = Math.floor(targetMessageTokens * 3.5);
            const prunedText = content.substring(content.length - estimatedChars);

            // ⚠️ 保持原始格式：数组就保持数组，字符串就保持字符串
            if (Array.isArray(message.content)) {
                message.content = [{ type: 'text', text: prunedText }];
            } else {
                message.content = prunedText;
            }
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
     * 计算消息的完整 token 数（包括 tool_result, tool_use, thinking, 图片等）
     * ⚠️ 关键修复：之前 getContentText 只提取 text 类型，导致其他内容被忽略
     * 这会导致 token 估算严重低估，从而触发 CONTENT_LENGTH_EXCEEDS_THRESHOLD 错误
     */
    getFullMessageTokens(message, useFastEstimate = true) {
        if (!message) return 0;

        let allText = '';  // 收集所有文本内容
        let imageCount = 0;

        // 提取文本内容
        const textContent = this.getContentText(message);
        allText += textContent;

        // ⚠️ 计算所有内容类型的 token 数
        if (Array.isArray(message.content)) {
            for (const part of message.content) {
                if (part.type === 'tool_result') {
                    // tool_result 的内容可能是字符串或数组
                    if (typeof part.content === 'string') {
                        allText += part.content;
                    } else if (Array.isArray(part.content)) {
                        const toolResultText = part.content
                            .filter(c => c.type === 'text' && c.text)
                            .map(c => c.text)
                            .join('');
                        allText += toolResultText;
                        // 检查是否有图片
                        imageCount += part.content.filter(c => c.type === 'image').length;
                    }
                    // JSON 结构开销（约 15 tokens）
                    allText += '                ';  // 16 个空格代表结构开销
                } else if (part.type === 'tool_use') {
                    // tool_use 的 input 也需要计算
                    if (part.input) {
                        const inputStr = typeof part.input === 'string'
                            ? part.input
                            : JSON.stringify(part.input);
                        allText += inputStr;
                    }
                    // tool_use 元数据（name, id 等）
                    allText += (part.name || '') + (part.id || '') + '          ';  // 结构开销
                } else if (part.type === 'thinking') {
                    // ⚠️ 关键：thinking 内容也需要计算
                    if (part.thinking) {
                        allText += part.thinking;
                    }
                } else if (part.type === 'image') {
                    // 图片 token 计数
                    imageCount++;
                }
            }
        }

        // 图片 token 估算：每张图片约 1000-2000 tokens（根据分辨率）
        const imageTokens = imageCount * 1500;

        // ⚠️ 关键修复：使用 countTextTokens 正确处理中文
        // 中文约 2.5 tokens/字，英文约 0.35 tokens/字符
        const textTokens = this.countTextTokens(allText, useFastEstimate);

        // JSON 格式开销（约 10%）
        return Math.ceil(textTokens * 1.1) + imageTokens;
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
        const buildStartTime = Date.now();
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
        const sanitizeStartTime = Date.now();
        messages = this.sanitizeMessages(messages);
        const sanitizeDuration = Date.now() - sanitizeStartTime;
        if (sanitizeDuration > 50) {
            console.log(`[Kiro Perf] sanitizeMessages took ${sanitizeDuration}ms`);
        }

        // Kiro 官方逻辑：使用MODEL_MAPPING映射到AWS支持的模型ID（提前定义，供后续使用）
        const codewhispererModel = MODEL_MAPPING[model] || MODEL_MAPPING[this.modelName];

        // Kiro 优化 1.5：消息历史修剪（防止 CONTENT_LENGTH_EXCEEDS_THRESHOLD 错误）
        // 参考 Kiro 官方客户端的实现
        const contextLength = KIRO_CONSTANTS.MAX_CONTEXT_TOKENS;
        const autoSummarizeThreshold = Math.floor(contextLength * KIRO_CONSTANTS.AUTO_SUMMARIZE_THRESHOLD);

        // ⚠️ 关键修复：使用 getFullMessageTokens 计算完整 token 数（包括 tool_result）
        // 之前使用 getContentText 只计算 text 类型，导致 tool_result 被忽略，token 严重低估
        let currentTokens = messages.reduce((acc, message) => {
            return acc + this.getFullMessageTokens(message, true);
        }, 0);

        // 添加系统提示词的 token 数
        if (systemPrompt) {
            currentTokens += this.countTextTokens(systemPrompt, true);
        }

        // 添加工具定义的 token 数（如果有）- 只计算一次，缓存结果
        let toolsTokens = 0;
        if (tools && Array.isArray(tools)) {
            // 性能优化：使用简单估算替代 JSON.stringify
            // 每个工具约 80 基础 tokens + description tokens + schema 属性数 * 50
            for (const tool of tools) {
                toolsTokens += 80;  // 基础元数据
                const desc = tool.description || tool.function?.description || '';
                if (desc) {
                    toolsTokens += this.countTextTokens(desc, true);
                }
                const schema = tool.input_schema || tool.function?.parameters || tool.parameters;
                if (schema?.properties) {
                    toolsTokens += Object.keys(schema.properties).length * 50;
                }
            }
            currentTokens += toolsTokens;
        }

        // 如果超过阈值，触发消息修剪
        const thresholdPct = Math.round(KIRO_CONSTANTS.AUTO_SUMMARIZE_THRESHOLD * 100);
        if (currentTokens > autoSummarizeThreshold) {
            console.log(`[Kiro Auto-Pruning] Token usage: ${currentTokens}/${contextLength} (${Math.round(currentTokens/contextLength*100)}%) > ${thresholdPct}% threshold - TRIGGERING PRUNING`);
            console.log(`[Kiro Token Detail] messages=${messages.length}, sysTokens=${systemPrompt ? this.countTextTokens(systemPrompt, true) : 0}, toolsTokens=${toolsTokens}`);
        } else {
            // ⚠️ 每10条消息打印一次详细日志
            if (messages.length % 10 === 0 || messages.length <= 5) {
                console.log(`[Kiro Token-Check] ${currentTokens}/${contextLength} (${Math.round(currentTokens/contextLength*100)}%) < ${thresholdPct}% threshold - NO PRUNING`);
                console.log(`[Kiro Token Detail] messages=${messages.length}, msgTokens=${currentTokens - toolsTokens - (systemPrompt ? this.countTextTokens(systemPrompt, true) : 0)}, sysTokens=${systemPrompt ? this.countTextTokens(systemPrompt, true) : 0}, toolsTokens=${toolsTokens}`);
            }
        }

        if (currentTokens > autoSummarizeThreshold) {

            // 预留给工具和系统提示词的 token（复用已计算的 toolsTokens）
            const tokensForCompletion = 4096;  // 预留给响应的 token
            let reservedTokens = tokensForCompletion + (systemPrompt ? this.countTextTokens(systemPrompt, true) : 0);
            reservedTokens += toolsTokens;  // 直接复用，不再重复计算

            // 执行修剪（优先使用 AI 摘要，失败则降级到传统裁剪）
            const pruneStartTime = Date.now();
            messages = await this.pruneChatHistoryWithAI(messages, contextLength, reservedTokens);
            const pruneDuration = Date.now() - pruneStartTime;
            console.log(`[Kiro Perf] pruneChatHistoryWithAI took ${pruneDuration}ms`);

            // 修剪后重新计算 token 数（使用完整 token 计算方法）
            const prunedTokens = messages.reduce((acc, message) => {
                return acc + this.getFullMessageTokens(message, true);
            }, 0);
            console.log(`[Kiro Auto-Pruning] Completed: ${prunedTokens}/${contextLength} (${Math.round(prunedTokens/contextLength*100)}%)`);
        }

        // Kiro 优化 2：提取 conversationId 和 continuationId（多轮对话优化）
        // 从消息历史中提取（如果客户端提供），否则生成新的
        const conversationId = this.extractMetadata(messages, 'conversationId') || uuidv4();
        const continuationId = this.extractMetadata(messages, 'continuationId');  // 可选
        const taskType = this.extractMetadata(messages, 'taskType');  // 可选
        const processedMessages = messages;

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
                    if (this.verboseLogging) {
                        console.log(`[Kiro] Merged adjacent ${currentMsg.role} messages`);
                    }
                } else {
                    mergedMessages.push(currentMsg);
                }
            }
        }
        
        // 用合并后的消息替换原消息数组
        processedMessages.length = 0;
        processedMessages.push(...mergedMessages);

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

        // ⭐ 工具处理策略：AWS CodeWhisperer API 只支持 toolSpecification 格式
        //
        // ⚠️ 重要发现：AWS CodeWhisperer API 不支持 Anthropic 的 builtin tool 格式！
        // Anthropic API 的 builtin tools（如 { type: "bash_20250305", name: "bash" }）
        // 在 CodeWhisperer API 中是无效的，会导致 400 Bad Request 错误。
        //
        // CodeWhisperer 只接受 toolSpecification 格式：
        // { toolSpecification: { name: "...", description: "...", inputSchema: { json: {...} } } }
        //
        // 因此我们只做工具压缩（减少 description 长度），不做格式转换。

        // ⚠️ 关键修复：限制工具总大小以避免 CONTENT_LENGTH_EXCEEDS_THRESHOLD 错误
        const MAX_TOOL_COUNT = 25;  // 限制工具数量
        const DESCRIPTION_MAX_LENGTH = 500;  // 工具描述最大长度（减少以降低请求体大小）
        let toolsContext = {};

        // ⚠️ 内置工具（builtin tools）定义 - 用于过滤
        // 这些工具由 Anthropic 官方 API 或客户端本地处理，AWS CodeWhisperer 不支持
        // 完全匹配官方 Kiro 的 isBuiltinTool 逻辑 (extension.js:683316-683325)
        const builtinToolNames = ['web_search', 'bash', 'code_execution', 'computer', 'str_replace_editor', 'str_replace_based_edit_tool'];
        const isBuiltinTool = (tool) => {
            return tool && typeof tool === 'object' &&
                   'type' in tool && 'name' in tool &&
                   typeof tool.type === 'string' && typeof tool.name === 'string' &&
                   builtinToolNames.includes(tool.name);
        };

        // 获取工具名（兼容多种格式）
        const getToolName = (tool) => {
            if (tool.function?.name) return tool.function.name;
            if (tool.toolSpecification?.name) return tool.toolSpecification.name;
            if (tool.name) return tool.name;
            if (tool.id) return tool.id;
            return null;
        };

        // 检查工具是否应该被移除（使用 CC_TO_KIRO_TOOL_MAPPING）
        const shouldRemoveTool = (tool) => {
            const name = getToolName(tool);
            if (!name) return false;
            const mapping = CC_TO_KIRO_TOOL_MAPPING[name];
            if (mapping?.remove) {
                if (this.verboseLogging) {
                    console.log(`[Kiro] Removing unsupported tool: ${name} (${mapping.reason || 'not supported'})`);
                }
                return true;
            }
            return false;
        };

        if (tools && Array.isArray(tools) && tools.length > 0) {
            // 第一步：过滤掉内置工具（AWS CodeWhisperer 不支持）
            let filteredTools = tools.filter(tool => {
                const isBuiltin = isBuiltinTool(tool);
                if (isBuiltin && this.verboseLogging) {
                    console.log(`[Kiro] Filtering out builtin tool: ${tool.name} (not supported by AWS CodeWhisperer)`);
                }
                return !isBuiltin;
            });

            // 第二步：使用 CC_TO_KIRO_TOOL_MAPPING 过滤不支持的工具
            filteredTools = filteredTools.filter(tool => !shouldRemoveTool(tool));

            // 第三步：限制工具数量
            if (filteredTools.length > MAX_TOOL_COUNT) {
                console.warn(`[Kiro] ⚠️ Too many tools: ${filteredTools.length} > ${MAX_TOOL_COUNT}, keeping first ${MAX_TOOL_COUNT}`);
                filteredTools = filteredTools.slice(0, MAX_TOOL_COUNT);
            }

            // 转换所有工具为 toolSpecification 格式（使用映射表和压缩）
            if (filteredTools.length > 0) {
                toolsContext = {
                    tools: filteredTools.map(tool => this.convertToQToolWithMapping(tool, compressInputSchema, DESCRIPTION_MAX_LENGTH))
                };
                if (this.verboseLogging) {
                    console.log(`[Kiro] Processed ${filteredTools.length} tools (original: ${tools.length})`);
                }            }
        }

        // ⚠️ 关键修复：收集保留的工具名称，用于过滤历史消息中的 tool_use 和 tool_result
        const keptToolNames = new Set();
        if (tools && Array.isArray(tools)) {
            // 收集裁剪后保留的工具名称
            const maxTools = Math.min(tools.length, MAX_TOOL_COUNT);
            for (let i = 0; i < maxTools; i++) {
                const tool = tools[i];
                const name = tool.name || (tool.function && tool.function.name);
                if (name) {
                    keptToolNames.add(name);
                }
            }
        }

        // 建立 toolUseId → toolName 的映射，用于过滤 tool_result
        const toolUseIdToName = new Map();
        for (const message of processedMessages) {
            if (message.role === 'assistant' && Array.isArray(message.content)) {
                for (const part of message.content) {
                    if (part.type === 'tool_use' && part.id && part.name) {
                        toolUseIdToName.set(part.id, part.name);
                    }
                }
            }
        }

        // 日志输出工具裁剪信息
        if (tools && tools.length > MAX_TOOL_COUNT) {
            console.log(`[Kiro] Tool trimming info: kept ${keptToolNames.size} tools, mapped ${toolUseIdToName.size} toolUseIds`);
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
                            // ⚠️ 关键修复：过滤掉引用被裁剪工具的 tool_result
                            const toolName = toolUseIdToName.get(part.tool_use_id);
                            if (keptToolNames.size > 0 && toolName && !keptToolNames.has(toolName)) {
                                if (this.verboseLogging) {
                                    console.log(`[Kiro] Filtering out tool_result for trimmed tool: ${toolName} (toolUseId: ${part.tool_use_id})`);
                                }
                                continue; // 跳过这个 tool_result
                            }

                            // 官方 Kiro 优化：截断过长的工具输出，防止 400 错误
                            let toolContent = this.getContentText(part.content);
                            if (toolContent.length > KIRO_CONSTANTS.MAX_TOOL_OUTPUT_LENGTH) {
                                const truncatedLength = KIRO_CONSTANTS.MAX_TOOL_OUTPUT_LENGTH;
                                toolContent = toolContent.substring(0, truncatedLength) +
                                    `\n\n[... truncated ${toolContent.length - truncatedLength} characters ...]`;
                            }
                            toolResults.push({
                                content: [{ text: toolContent }],
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

                // 修复：Kiro API 不接受空 content，当只有 toolResults 时添加默认文本
                if (!userInputMessage.content || userInputMessage.content.trim() === '') {
                    userInputMessage.content = toolResults.length > 0 ? 'Tool results provided.' : 'Continue';
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
                            // ⚠️ 关键修复：过滤掉被裁剪的工具
                            if (keptToolNames.size > 0 && !keptToolNames.has(part.name)) {
                                if (this.verboseLogging) {
                                    console.log(`[Kiro] Filtering out tool_use for trimmed tool: ${part.name}`);
                                }
                                continue; // 跳过这个 tool_use
                            }

                            // 应用参数映射（CC → Kiro）
                            const mappedInput = this.mapToolUseParams(part.name, part.input);
                            toolUses.push({
                                input: mappedInput,
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

                // ⚠️ 关键修复：Kiro API 不接受空 content，当只有 toolUses 时添加默认文本
                if (!assistantResponseMessage.content || assistantResponseMessage.content.trim() === '') {
                    assistantResponseMessage.content = toolUses.length > 0 ? 'Calling tools...' : '...';
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
                        // ⚠️ 关键修复：过滤掉被裁剪的工具
                        if (keptToolNames.size > 0 && !keptToolNames.has(part.name)) {
                            if (this.verboseLogging) {
                                console.log(`[Kiro] Filtering out tool_use for trimmed tool: ${part.name}`);
                            }
                            continue;
                        }
                        // 应用参数映射（CC → Kiro）
                        const mappedInput = this.mapToolUseParams(part.name, part.input);
                        assistantResponseMessage.toolUses.push({
                            input: mappedInput,
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
            // ⚠️ 关键修复：Kiro API 不接受空 content
            if (!assistantResponseMessage.content || assistantResponseMessage.content.trim() === '') {
                assistantResponseMessage.content = assistantResponseMessage.toolUses ? 'Calling tools...' : '...';
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
                        // ⚠️ 关键修复：过滤掉引用被裁剪工具的 tool_result
                        const toolName = toolUseIdToName.get(part.tool_use_id);
                        if (keptToolNames.size > 0 && toolName && !keptToolNames.has(toolName)) {
                            if (this.verboseLogging) {
                                console.log(`[Kiro] Filtering out tool_result for trimmed tool: ${toolName} (toolUseId: ${part.tool_use_id})`);
                            }
                            continue;
                        }

                        // 官方 Kiro 优化：截断过长的工具输出，防止 400 错误
                        let toolContent = this.getContentText(part.content);
                        if (toolContent.length > KIRO_CONSTANTS.MAX_TOOL_OUTPUT_LENGTH) {
                            const truncatedLength = KIRO_CONSTANTS.MAX_TOOL_OUTPUT_LENGTH;
                            toolContent = toolContent.substring(0, truncatedLength) +
                                `\n\n[... truncated ${toolContent.length - truncatedLength} characters ...]`;
                        }
                        currentToolResults.push({
                            content: [{ text: toolContent }],
                            status: 'success',
                            toolUseId: part.tool_use_id
                        });
                    } else if (part.type === 'tool_use') {
                        // ⚠️ 关键修复：过滤掉被裁剪的工具
                        if (keptToolNames.size > 0 && !keptToolNames.has(part.name)) {
                            if (this.verboseLogging) {
                                console.log(`[Kiro] Filtering out tool_use for trimmed tool: ${part.name}`);
                            }
                            continue;
                        }
                        // 应用参数映射（CC → Kiro）
                        const mappedInput = this.mapToolUseParams(part.name, part.input);
                        currentToolUses.push({
                            input: mappedInput,
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

            // ⚠️ 关键修复：限制 currentContent 长度，防止 400 错误
            // 之前只裁剪了 history，但 currentMessage 没有被裁剪
            const MAX_CURRENT_CONTENT_LENGTH = 32000;  // 32KB 限制
            if (currentContent.length > MAX_CURRENT_CONTENT_LENGTH) {
                console.log(`[Kiro] ⚠️ currentContent too long (${currentContent.length} chars), truncating to ${MAX_CURRENT_CONTENT_LENGTH}`);

                // 智能截断：移除 <system-reminder> 块以保留更多有用内容
                let truncatedContent = currentContent;

                // 先尝试移除 system-reminder 块
                const systemReminderPattern = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
                truncatedContent = truncatedContent.replace(systemReminderPattern, '[system-reminder removed for context limit]');

                // 如果还是太长，从中间截断，保留开头和结尾
                if (truncatedContent.length > MAX_CURRENT_CONTENT_LENGTH) {
                    const keepStart = Math.floor(MAX_CURRENT_CONTENT_LENGTH * 0.7);  // 保留 70% 开头
                    const keepEnd = MAX_CURRENT_CONTENT_LENGTH - keepStart - 100;     // 剩余给结尾
                    truncatedContent = truncatedContent.substring(0, keepStart) +
                        '\n\n[... content truncated for API limit ...]\n\n' +
                        truncatedContent.substring(truncatedContent.length - keepEnd);
                }

                currentContent = truncatedContent;
                console.log(`[Kiro] currentContent truncated to ${currentContent.length} chars`);
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
        }

        // 只有当 userInputMessageContext 有内容时才添加
        if (Object.keys(userInputMessageContext).length > 0) {
            userInputMessage.userInputMessageContext = userInputMessageContext;
        }

        request.conversationState.currentMessage.userInputMessage = userInputMessage;

        if (this.authMethod === KIRO_CONSTANTS.AUTH_METHOD_SOCIAL) {
            request.profileArn = this.profileArn;
        }

        // ⚠️ 关键修复：清理消息历史，确保符合 Kiro API 规则
        // 官方 Kiro 扩展的 message-history-sanitizer 会验证并修复消息
        this.sanitizeMessageHistory(history, currentToolResults);

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

        // ⚠️ 性能计时：buildCodewhispererRequest 总耗时
        const buildDuration = Date.now() - buildStartTime;
        if (buildDuration > 100) {
            console.log(`[Kiro Perf] buildCodewhispererRequest total: ${buildDuration}ms (messages: ${messages.length})`);
        }

        return request;
    }

    /**
     * 清理消息历史，确保符合 Kiro API 规则
     * 规则来自官方 Kiro 扩展的 message-history-sanitizer
     * 不仅验证，还会自动修复问题
     *
     * @param {Array} history - 消息历史（会被原地修改）
     * @param {Array} currentToolResults - 当前消息的 toolResults
     */
    sanitizeMessageHistory(history, currentToolResults) {
        if (!history || history.length === 0) {
            return;
        }

        let fixCount = 0;

        // 规则 1: 如果 assistant 消息有 toolUses，下一条消息必须有匹配的 toolResults
        // 如果没有，移除 toolUses（因为没有对应的结果，继续保留会导致 400 错误）
        for (let i = 0; i < history.length; i++) {
            const message = history[i];

            if (message.assistantResponseMessage?.toolUses?.length > 0) {
                const toolUses = message.assistantResponseMessage.toolUses;
                let toolResults = [];

                // 检查是否是最后一条 history 消息
                if (i === history.length - 1) {
                    // toolResults 在 currentMessage 中
                    toolResults = currentToolResults || [];
                } else {
                    // toolResults 在下一条消息中
                    const nextMessage = history[i + 1];
                    if (nextMessage?.userInputMessage?.userInputMessageContext?.toolResults) {
                        toolResults = nextMessage.userInputMessage.userInputMessageContext.toolResults;
                    }
                }

                // 创建 toolResult IDs 集合
                const toolResultIds = new Set(toolResults.map(tr => tr.toolUseId));

                // 过滤掉没有对应 toolResult 的 toolUses
                const validToolUses = toolUses.filter(tu => toolResultIds.has(tu.toolUseId));

                if (validToolUses.length !== toolUses.length) {
                    const removedCount = toolUses.length - validToolUses.length;
                    console.warn(`[Kiro Sanitize] History[${i}]: Removed ${removedCount} orphan toolUses without matching toolResults`);
                    fixCount++;

                    if (validToolUses.length === 0) {
                        // 全部移除，删除 toolUses 字段
                        delete message.assistantResponseMessage.toolUses;
                    } else {
                        message.assistantResponseMessage.toolUses = validToolUses;
                    }
                }
            }
        }

        // 规则 2: user 消息必须有 content 或 toolResults，否则添加默认内容
        for (let i = 0; i < history.length; i++) {
            const message = history[i];
            if (message.userInputMessage) {
                const hasContent = message.userInputMessage.content && message.userInputMessage.content.trim() !== '';
                const hasToolResults = message.userInputMessage.userInputMessageContext?.toolResults?.length > 0;

                if (!hasContent && !hasToolResults) {
                    message.userInputMessage.content = 'Continue';
                    console.warn(`[Kiro Sanitize] History[${i}]: Added default content to empty user message`);
                    fixCount++;
                }
            }
        }

        // 规则 3: assistant 消息必须有 content
        for (let i = 0; i < history.length; i++) {
            const message = history[i];
            if (message.assistantResponseMessage) {
                const hasContent = message.assistantResponseMessage.content && message.assistantResponseMessage.content.trim() !== '';
                if (!hasContent) {
                    message.assistantResponseMessage.content = message.assistantResponseMessage.toolUses ? 'Calling tools...' : '...';
                    console.warn(`[Kiro Sanitize] History[${i}]: Added default content to empty assistant message`);
                    fixCount++;
                }
            }
        }

        // 规则 4: toolUse 必须有 input 字段
        for (let i = 0; i < history.length; i++) {
            const message = history[i];
            if (message.assistantResponseMessage?.toolUses) {
                for (const toolUse of message.assistantResponseMessage.toolUses) {
                    if (toolUse.input === undefined) {
                        toolUse.input = {};
                        console.warn(`[Kiro Sanitize] History[${i}]: Added empty input to toolUse '${toolUse.name}'`);
                        fixCount++;
                    }
                }
            }
        }

        // 规则 5: 如果有孤立的 toolResults（没有对应的 toolUses），移除它们
        for (let i = 0; i < history.length; i++) {
            const message = history[i];
            if (message.userInputMessage?.userInputMessageContext?.toolResults?.length > 0) {
                const toolResults = message.userInputMessage.userInputMessageContext.toolResults;

                // 找到前一条 assistant 消息的 toolUseIds
                let prevToolUseIds = new Set();
                if (i > 0 && history[i - 1].assistantResponseMessage?.toolUses) {
                    prevToolUseIds = new Set(history[i - 1].assistantResponseMessage.toolUses.map(tu => tu.toolUseId));
                }

                // 过滤掉没有对应 toolUse 的 toolResults
                const validToolResults = toolResults.filter(tr => prevToolUseIds.has(tr.toolUseId));

                if (validToolResults.length !== toolResults.length) {
                    const removedCount = toolResults.length - validToolResults.length;
                    console.warn(`[Kiro Sanitize] History[${i}]: Removed ${removedCount} orphan toolResults without matching toolUses`);
                    fixCount++;

                    if (validToolResults.length === 0) {
                        // 全部移除，删除 toolResults
                        delete message.userInputMessage.userInputMessageContext.toolResults;
                        // 如果 context 为空，也删除
                        if (Object.keys(message.userInputMessage.userInputMessageContext).length === 0) {
                            delete message.userInputMessage.userInputMessageContext;
                        }
                    } else {
                        message.userInputMessage.userInputMessageContext.toolResults = validToolResults;
                    }
                }
            }
        }

        // 规则 6: 截断过长的单条消息内容（防止单条消息超过 AWS 限制）
        // AWS 实际限制 ~223K tokens (~710K chars)，我们设置 200K chars 的单条消息限制
        // 这样多条消息加起来才不会超限
        const MAX_SINGLE_MESSAGE_LENGTH = 200000;  // 200KB 限制（之前太保守只有 64KB）
        for (let i = 0; i < history.length; i++) {
            const message = history[i];

            // 截断 user 消息
            if (message.userInputMessage?.content && message.userInputMessage.content.length > MAX_SINGLE_MESSAGE_LENGTH) {
                const originalLength = message.userInputMessage.content.length;
                const keepStart = Math.floor(MAX_SINGLE_MESSAGE_LENGTH * 0.7);
                const keepEnd = MAX_SINGLE_MESSAGE_LENGTH - keepStart - 100;
                message.userInputMessage.content =
                    message.userInputMessage.content.substring(0, keepStart) +
                    '\n\n[... content truncated ...]\n\n' +
                    message.userInputMessage.content.substring(originalLength - keepEnd);
                console.warn(`[Kiro Sanitize] History[${i}]: Truncated user content from ${originalLength} to ${message.userInputMessage.content.length} chars`);
                fixCount++;
            }

            // 截断 assistant 消息
            if (message.assistantResponseMessage?.content && message.assistantResponseMessage.content.length > MAX_SINGLE_MESSAGE_LENGTH) {
                const originalLength = message.assistantResponseMessage.content.length;
                const keepStart = Math.floor(MAX_SINGLE_MESSAGE_LENGTH * 0.7);
                const keepEnd = MAX_SINGLE_MESSAGE_LENGTH - keepStart - 100;
                message.assistantResponseMessage.content =
                    message.assistantResponseMessage.content.substring(0, keepStart) +
                    '\n\n[... content truncated ...]\n\n' +
                    message.assistantResponseMessage.content.substring(originalLength - keepEnd);
                console.warn(`[Kiro Sanitize] History[${i}]: Truncated assistant content from ${originalLength} to ${message.assistantResponseMessage.content.length} chars`);
                fixCount++;
            }
        }

        // 规则 7: 确保消息交替 (user → assistant → user)
        // 如果有连续的 user 消息，在它们之间插入占位的 assistant 消息
        // 需要从后往前遍历，避免插入操作影响索引
        for (let i = history.length - 1; i > 0; i--) {
            const prevMessage = history[i - 1];
            const currMessage = history[i];

            // 检查是否有连续的 user 消息（两条都只有 userInputMessage）
            const prevIsUser = prevMessage.userInputMessage && !prevMessage.assistantResponseMessage;
            const currIsUser = currMessage.userInputMessage && !currMessage.assistantResponseMessage;

            if (prevIsUser && currIsUser) {
                // 在 prevMessage 和 currMessage 之间插入一个 assistant 占位消息
                const placeholderAssistant = {
                    assistantResponseMessage: {
                        content: 'Continue.',
                        messageId: `placeholder-${Date.now()}-${i}`
                    }
                };
                history.splice(i, 0, placeholderAssistant);
                console.warn(`[Kiro Sanitize] Inserted placeholder assistant message between History[${i - 1}] and History[${i}] to fix consecutive user messages`);
                fixCount++;
            }
        }

        // 规则 8: 确保消息交替 - 连续的 assistant 消息也需要处理
        // 如果有连续的 assistant 消息，在它们之间插入占位的 user 消息
        for (let i = history.length - 1; i > 0; i--) {
            const prevMessage = history[i - 1];
            const currMessage = history[i];

            // 检查是否有连续的 assistant 消息
            const prevIsAssistant = prevMessage.assistantResponseMessage && !prevMessage.userInputMessage;
            const currIsAssistant = currMessage.assistantResponseMessage && !currMessage.userInputMessage;

            if (prevIsAssistant && currIsAssistant) {
                // 在 prevMessage 和 currMessage 之间插入一个 user 占位消息
                const placeholderUser = {
                    userInputMessage: {
                        content: 'Continue',
                        messageId: `placeholder-user-${Date.now()}-${i}`
                    }
                };
                history.splice(i, 0, placeholderUser);
                console.warn(`[Kiro Sanitize] Inserted placeholder user message between History[${i - 1}] and History[${i}] to fix consecutive assistant messages`);
                fixCount++;
            }
        }

        if (fixCount > 0) {
            console.log(`[Kiro Sanitize] Applied ${fixCount} fixes to message history`);
        }
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
        const callStartTime = Date.now();
        if (!this.isInitialized) await this.initialize();
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000; // 1 second base delay

        // 检查是否启用 thinking（从 body 或配置中读取）
        const enableThinking = body.thinking?.type === 'enabled' ||
                             body.extended_thinking === true ||
                             this.config.ENABLE_THINKING_BY_DEFAULT === true;

        // 🔍 性能诊断：记录请求构建时间
        const buildStartTime = Date.now();
        const requestData = await this.buildCodewhispererRequest(body.messages, model, body.tools, body.system, enableThinking);
        const buildDuration = Date.now() - buildStartTime;
        if (buildDuration > 100) {
            console.log(`[Kiro Perf] buildCodewhispererRequest took ${buildDuration}ms (messages: ${body.messages?.length || 0})`);
        }

        // ========================================
        // 📤 请求日志
        // ========================================
        const requestStartTime = Date.now();
        const requestJson = JSON.stringify(requestData);
        const requestSizeKB = (requestJson.length / 1024).toFixed(2);
        const conversationState = requestData?.conversationState;

        // 提取当前消息内容预览
        const currentContent = conversationState?.currentMessage?.userInputMessage?.content || '';
        const contentPreview = currentContent.length > 60
            ? currentContent.substring(0, 60) + '...'
            : currentContent;

        // 简洁模式：只显示关键信息
        if (!this.verboseLogging) {
            console.log(`[Kiro] 📤 REQUEST [${model}] - ${new Date().toISOString()}`);
        } else {
            // 详细模式：显示所有信息
            console.log('\n' + '='.repeat(60));
            console.log(`📤 REQUEST [${model}]${isRetry ? ' (retry ' + retryCount + ')' : ''}`);
            console.log('='.repeat(60));
            console.log(`Timestamp: ${new Date().toISOString()}`);
            console.log(`URL: ${model.startsWith('amazonq') ? this.amazonQUrl : this.baseUrl}`);
            console.log(`Messages: ${(conversationState?.history?.length || 0) + 1} | Tools: ${conversationState?.currentMessage?.userInputMessage?.userInputMessageContext?.tools?.length || 0} | System: ${body.system ? 'yes' : 'no'}`);
            console.log(`Request Size: ${requestSizeKB} KB | Thinking: ${enableThinking ? 'enabled' : 'disabled'}`);
            if (conversationState?.conversationId) {
                console.log(`Conversation ID: ${conversationState.conversationId}`);
            }
            console.log(`Message Preview: ${contentPreview}`);
            console.log('='.repeat(60));
        }

        try {
            const token = this.accessToken; // Use the already initialized token
            const headers = {
                'Authorization': `Bearer ${token}`,
                'amz-sdk-invocation-id': `${uuidv4()}`,
            };

            // 当 model 以 kiro-amazonq 开头时，使用 amazonQUrl，否则使用 baseUrl
            const requestUrl = model.startsWith('amazonq') ? this.amazonQUrl : this.baseUrl;

            // 自适应超时：根据模型类型调整（慢模型 x3）
            const adaptiveTimeout = getAdaptiveTimeout(model, KIRO_CONSTANTS.AXIOS_TIMEOUT);

            const response = await this.axiosInstance.post(requestUrl, requestData, {
                headers,
                timeout: adaptiveTimeout  // 使用自适应超时
            });

            // ========================================
            // 📥 响应日志
            // ========================================
            const requestDuration = ((Date.now() - requestStartTime) / 1000).toFixed(2);
            const responseSize = response.data ? Buffer.byteLength(JSON.stringify(response.data)) : 0;
            const responseSizeKB = (responseSize / 1024).toFixed(2);

            // 简洁模式：只显示关键信息
            if (!this.verboseLogging) {
                console.log(`[Kiro] 📥 RESPONSE [${response.status}] [${requestDuration}s]`);
            } else {
                // 详细模式：显示所有信息
                console.log('\n' + '='.repeat(60));
                console.log(`📥 RESPONSE [${response.status} ${response.statusText}] [${requestDuration}s]`);
                console.log('='.repeat(60));
                console.log(`Response Size: ${responseSizeKB} KB`);
                console.log('='.repeat(60) + '\n');
            }

            return response;
        } catch (error) {
            // ⚠️ Socket 错误处理（UND_ERR_SOCKET, ECONNRESET 等）
            // 这些错误通常是连接池中的连接失效导致的
            const isSocketError = !error.response && (
                error.code === 'ECONNRESET' ||
                error.code === 'ETIMEDOUT' ||
                error.code === 'ENOTFOUND' ||
                error.code === 'UND_ERR_SOCKET' ||
                error.code === 'UND_ERR_CONNECT_TIMEOUT' ||
                error.message?.includes('socket') ||
                error.message?.includes('ECONNRESET')
            );

            if (isSocketError && retryCount < maxRetries) {
                console.log(`[Kiro] Socket error detected: ${error.code || error.message}`);
                console.log(`[Kiro] Resetting connection pool and retrying... (attempt ${retryCount + 1}/${maxRetries})`);

                // 重置连接池
                await this.resetConnectionPool();

                // 短暂延迟后重试
                const delay = 1000;
                await new Promise(resolve => setTimeout(resolve, delay));

                return this.callApi(method, model, body, isRetry, retryCount + 1);
            } else if (isSocketError) {
                console.error('[Kiro] Socket error after max retries:', error.code || error.message);
                throw new Error(`Connection failed: ${error.message}. Please check your network or try restarting the service.`);
            }

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
                // 打印请求体的关键信息帮助调试
                try {
                    const reqState = requestData?.conversationState;
                    console.error('[Kiro] Request debug info:', {
                        historyLength: reqState?.history?.length || 0,
                        hasCurrentMessage: !!reqState?.currentMessage,
                        currentMsgType: reqState?.currentMessage?.userInputMessage ? 'userInputMessage' : 'unknown',
                        currentMsgContentLen: reqState?.currentMessage?.userInputMessage?.content?.length || 0,
                        hasTools: !!(reqState?.currentMessage?.userInputMessage?.userInputMessageContext?.tools),
                        toolsCount: reqState?.currentMessage?.userInputMessage?.userInputMessageContext?.tools?.length || 0,
                        hasToolResults: !!(reqState?.currentMessage?.userInputMessage?.userInputMessageContext?.toolResults),
                        toolResultsCount: reqState?.currentMessage?.userInputMessage?.userInputMessageContext?.toolResults?.length || 0,
                    });

                    // ⚠️ 关键调试：打印 toolResults 结构
                    const toolResults = reqState?.currentMessage?.userInputMessage?.userInputMessageContext?.toolResults;
                    if (toolResults && toolResults.length > 0) {
                        console.error('[Kiro] ToolResults structure:', JSON.stringify(toolResults.map(tr => ({
                            toolUseId: tr.toolUseId,
                            status: tr.status,
                            hasContent: !!tr.content,
                            contentType: Array.isArray(tr.content) ? 'array' : typeof tr.content,
                            contentLength: tr.content ? (Array.isArray(tr.content) ? tr.content.length : String(tr.content).length) : 0,
                            // 新增：打印 content 详细结构
                            contentDetail: Array.isArray(tr.content) ? tr.content.map(c => ({
                                type: typeof c,
                                hasText: !!c?.text,
                                textLen: c?.text?.length || 0,
                                textPreview: c?.text?.substring(0, 100) || ''
                            })) : null
                        })), null, 2));
                    }

                    // ⚠️ 关键调试：打印 history 中的 toolUses
                    if (reqState?.history) {
                        for (let idx = 0; idx < reqState.history.length; idx++) {
                            const h = reqState.history[idx];
                            if (h.userInputMessage) {
                                console.error(`[Kiro] History[${idx}] userInputMessage.content length:`, h.userInputMessage.content?.length || 0);
                            }
                            if (h.assistantResponseMessage) {
                                console.error(`[Kiro] History[${idx}] assistantResponseMessage.content length:`, h.assistantResponseMessage.content?.length || 0);
                                if (h.assistantResponseMessage.toolUses) {
                                    // ⚠️ 增强调试：打印完整的 toolUse 结构，检查是否有 input 字段
                                    console.error(`[Kiro] History[${idx}] toolUses:`, JSON.stringify(h.assistantResponseMessage.toolUses.map(tu => ({
                                        toolUseId: tu.toolUseId,
                                        name: tu.name,
                                        hasInput: tu.input !== undefined,
                                        inputType: typeof tu.input,
                                        inputKeys: tu.input && typeof tu.input === 'object' ? Object.keys(tu.input) : null
                                    }))));
                                }
                            }
                        }
                    }
                } catch (debugErr) {
                    console.error('[Kiro] Failed to log request debug info:', debugErr.message);
                }
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
        if (this.verboseLogging) {
            console.log(`[Kiro] Calling generateContent with model: ${finalModel}`);
        }

        // Estimate input tokens before making the API call
        const inputTokens = this.estimateInputTokens(requestBody);
        console.log(`[Kiro Token] generateContent estimateInputTokens: ${inputTokens} tokens (${requestBody.messages?.length || 0} messages)`);
        
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
        const callStartTime = Date.now();
        if (!this.isInitialized) await this.initialize();
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;

        // 检查是否启用 thinking（从 body 或配置中读取）
        const enableThinking = body.thinking?.type === 'enabled' ||
                             body.extended_thinking === true ||
                             this.config.ENABLE_THINKING_BY_DEFAULT === true;

        // 🔍 性能诊断：记录请求构建时间
        const buildStartTime = Date.now();
        const requestData = await this.buildCodewhispererRequest(body.messages, model, body.tools, body.system, enableThinking);
        const buildDuration = Date.now() - buildStartTime;
        if (buildDuration > 100) {
            console.log(`[Kiro Perf] streamApiReal buildCodewhispererRequest took ${buildDuration}ms (messages: ${body.messages?.length || 0})`);
        }

        // ========================================
        // 📤 流式请求日志
        // ========================================
        const requestStartTime = Date.now();
        const requestJson = JSON.stringify(requestData);
        const requestSizeKB = (requestJson.length / 1024).toFixed(2);
        const conversationState = requestData?.conversationState;

        // 提取当前消息内容预览
        const currentContent = conversationState?.currentMessage?.userInputMessage?.content || '';
        const contentPreview = currentContent.length > 60
            ? currentContent.substring(0, 60) + '...'
            : currentContent;

        // 简洁模式：只显示关键信息
        if (!this.verboseLogging) {
            console.log(`[Kiro] 📤 STREAM [${model}] - ${new Date().toISOString()}`);
        } else {
            // 详细模式：显示所有信息
            console.log('\n' + '='.repeat(60));
            console.log(`📤 STREAM REQUEST [${model}]${isRetry ? ' (retry ' + retryCount + ')' : ''}`);
            console.log('='.repeat(60));
            console.log(`Timestamp: ${new Date().toISOString()}`);
            console.log(`URL: ${model.startsWith('amazonq') ? this.amazonQUrl : this.baseUrl}`);
            console.log(`Messages: ${(conversationState?.history?.length || 0) + 1} | Tools: ${conversationState?.currentMessage?.userInputMessage?.userInputMessageContext?.tools?.length || 0} | System: ${body.system ? 'yes' : 'no'}`);
            console.log(`Request Size: ${requestSizeKB} KB | Thinking: ${enableThinking ? 'enabled' : 'disabled'}`);
            if (conversationState?.conversationId) {
                console.log(`Conversation ID: ${conversationState.conversationId}`);
            }
            console.log(`Message Preview: ${contentPreview}`);
            console.log('='.repeat(60));
        }

        const token = this.accessToken;
        const headers = {
            'Authorization': `Bearer ${token}`,
            'amz-sdk-invocation-id': `${uuidv4()}`,
        };

        const requestUrl = model.startsWith('amazonq') ? this.amazonQUrl : this.baseUrl;

        // 自适应超时：根据模型类型调整（慢模型 x3）
        const adaptiveTimeout = getAdaptiveTimeout(model, KIRO_CONSTANTS.AXIOS_TIMEOUT);

        let stream = null;
        let eventCount = 0;  // 统计流式事件数量
        let totalBytesReceived = 0;  // 统计接收的字节数
        let firstTokenTime = null;  // 首字时间（TTFT）

        try {
            const response = await this.axiosInstance.post(requestUrl, requestData, {
                headers,
                responseType: 'stream',
                timeout: adaptiveTimeout,  // 使用自适应超时
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            });

            stream = response.data;
            let pendingBuffer = Buffer.alloc(0);  // 待处理的缓冲区
            let lastContentEvent = null;  // 用于检测连续重复的 content 事件

            for await (const chunk of stream) {
                totalBytesReceived += chunk.length;

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
                    eventCount++;

                    // 记录首字时间（TTFT）
                    if (firstTokenTime === null && (event.type === 'content' || event.type === 'thinking')) {
                        firstTokenTime = Date.now() - requestStartTime;
                        console.log(`[Kiro] ⚡ TTFT: ${(firstTokenTime / 1000).toFixed(2)}s`);
                    }

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

            // ========================================
            // 📥 流式响应日志
            // ========================================
            const requestDuration = ((Date.now() - requestStartTime) / 1000).toFixed(2);
            const totalSizeKB = (totalBytesReceived / 1024).toFixed(2);

            // 简洁模式：只显示关键信息
            if (!this.verboseLogging) {
                console.log(`[Kiro] 📥 STREAM [Complete] [${requestDuration}s]`);
            } else {
                // 详细模式：显示所有信息
                console.log('\n' + '='.repeat(60));
                console.log(`📥 STREAM RESPONSE [Complete] [${requestDuration}s]`);
                console.log('='.repeat(60));
                console.log(`Total Events: ${eventCount} | Total Size: ${totalSizeKB} KB`);
                console.log('='.repeat(60) + '\n');
            }
        } catch (error) {
            // 确保出错时关闭流
            if (stream && typeof stream.destroy === 'function') {
                stream.destroy();
            }

            // ⚠️ Socket 错误处理（流式 API）
            const isSocketError = !error.response && (
                error.code === 'ECONNRESET' ||
                error.code === 'ETIMEDOUT' ||
                error.code === 'ENOTFOUND' ||
                error.code === 'UND_ERR_SOCKET' ||
                error.code === 'UND_ERR_CONNECT_TIMEOUT' ||
                error.message?.includes('socket') ||
                error.message?.includes('ECONNRESET')
            );

            if (isSocketError && retryCount < maxRetries) {
                console.log(`[Kiro Stream] Socket error detected: ${error.code || error.message}`);
                console.log(`[Kiro Stream] Resetting connection pool and retrying... (attempt ${retryCount + 1}/${maxRetries})`);

                // 重置连接池
                await this.resetConnectionPool();

                // 短暂延迟后重试
                await new Promise(resolve => setTimeout(resolve, 1000));

                yield* this.streamApiReal(method, model, body, isRetry, retryCount + 1);
                return;
            } else if (isSocketError) {
                console.error('[Kiro Stream] Socket error after max retries:', error.code || error.message);
                throw new Error(`Stream connection failed: ${error.message}. Please check your network or try restarting the service.`);
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

            // ⚠️ 关键调试：400 错误详细日志
            if (error.response?.status === 400) {
                console.error('[Kiro Stream] ❌ 400 Bad Request Error in streaming');

                // 安全获取响应数据（可能是流对象）
                let errorData = 'Unable to read response data';
                try {
                    if (typeof error.response.data === 'string') {
                        errorData = error.response.data.substring(0, 500);
                    } else if (error.response.data && typeof error.response.data.on === 'function') {
                        // 这是一个流，无法直接读取
                        errorData = '[Stream response - check statusText]';
                    } else if (error.response.data) {
                        errorData = JSON.stringify(error.response.data).substring(0, 500);
                    }
                } catch (e) {
                    errorData = `[Error reading data: ${e.message}]`;
                }

                console.error('[Kiro Stream] Error details:', {
                    status: error.response.status,
                    statusText: error.response.statusText,
                    data: errorData,
                    amznErrorType: error.response.headers?.['x-amzn-errortype'] || 'unknown'
                });

                // 打印请求体的关键信息
                try {
                    const reqState = requestData?.conversationState;
                    console.error('[Kiro Stream] Request debug info:', {
                        historyLength: reqState?.history?.length || 0,
                        hasCurrentMessage: !!reqState?.currentMessage,
                        currentMsgType: reqState?.currentMessage?.userInputMessage ? 'userInputMessage' : 'unknown',
                        currentMsgContentLen: reqState?.currentMessage?.userInputMessage?.content?.length || 0,
                        hasTools: !!(reqState?.currentMessage?.userInputMessage?.userInputMessageContext?.tools),
                        toolsCount: reqState?.currentMessage?.userInputMessage?.userInputMessageContext?.tools?.length || 0,
                        hasToolResults: !!(reqState?.currentMessage?.userInputMessage?.userInputMessageContext?.toolResults),
                        toolResultsCount: reqState?.currentMessage?.userInputMessage?.userInputMessageContext?.toolResults?.length || 0,
                    });

                    // 打印 history 中每个消息的 content 长度
                    if (reqState?.history) {
                        for (let idx = 0; idx < reqState.history.length; idx++) {
                            const h = reqState.history[idx];
                            if (h.userInputMessage) {
                                console.error(`[Kiro Stream] History[${idx}] user.content len: ${h.userInputMessage.content?.length || 0}`);
                            }
                            if (h.assistantResponseMessage) {
                                console.error(`[Kiro Stream] History[${idx}] assistant.content len: ${h.assistantResponseMessage.content?.length || 0}, hasToolUses: ${!!h.assistantResponseMessage.toolUses}`);
                            }
                        }
                    }
                } catch (debugErr) {
                    console.error('[Kiro Stream] Failed to log debug info:', debugErr.message);
                }
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
        if (this.verboseLogging) {
            console.log(`[Kiro] Calling generateContentStream with model: ${finalModel} (real streaming, thinking: ${enableThinking})`);
        }

        // ⚠️ 性能计时：token 估算
        const tokenStartTime = Date.now();
        const inputTokens = this.estimateInputTokens(requestBody);
        const tokenDuration = Date.now() - tokenStartTime;
        // ⚠️ 调试：打印 token 计算结果
        console.log(`[Kiro Token] estimateInputTokens: ${inputTokens} tokens (${requestBody.messages?.length || 0} messages, ${tokenDuration}ms)`);
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
                // Debug: 记录事件类型（仅在调试时启用，生产环境注释掉以提升性能）
                // console.log(`[Kiro Debug] Event received: type=${event.type}`);

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
                                    // 没有找到完整的 <thinking> 标签
                                    // ⚠️ 优化：快速判断是否可能有 thinking 标签
                                    // 1. 如果 buffer 不以 < 开头且长度 > 0，肯定没有 thinking → 立即输出
                                    // 2. 如果 buffer 以 < 开头但不是 <thinking>... 前缀，也立即输出
                                    // 3. 如果是 <thinking> 的前缀（如 "<t", "<think"），等待更多数据

                                    let canEmitImmediately = false;
                                    if (contentBuffer.length > 0 && !contentBuffer.startsWith('<')) {
                                        // 不以 < 开头，肯定没有 thinking
                                        canEmitImmediately = true;
                                    } else if (contentBuffer.startsWith('<') && contentBuffer.length >= 10) {
                                        // 以 < 开头且长度足够判断（<thinking> 是 10 字符）
                                        // 如果不是 <thinking> 的前缀，可以输出
                                        if (!('<thinking>'.startsWith(contentBuffer.slice(0, 10)))) {
                                            canEmitImmediately = true;
                                        }
                                    }

                                    const shouldEmit = thinkingTagClosed || canEmitImmediately ||
                                                      (thinkingBlockIndex === null && contentBuffer.length > 15);

                                    if (shouldEmit && contentBuffer.length > 0) {
                                        // 计算保留字符数
                                        // - 如果确定没有 thinking，只保留 1 字符
                                        // - 如果 thinking 已结束，保留 15 字符防止新 thinking 块
                                        const keepChars = (canEmitImmediately || thinkingBlockIndex === null) ? 1 : 15;
                                        const textToEmit = contentBuffer.length > keepChars
                                            ? contentBuffer.slice(0, -keepChars)
                                            : (canEmitImmediately ? contentBuffer : '');

                                        if (textToEmit) {
                                            contentBuffer = canEmitImmediately && contentBuffer.length <= keepChars
                                                ? ''
                                                : contentBuffer.slice(-keepChars);
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
                    const tc = event.toolUse;

                    if (tc && tc.toolUseId) {
                        // ⚠️ 完美复刻官方逻辑（extension.js:708090）：
                        // if (!toolCalls.has(toolUseId)) { 添加 id/name } else { 只处理 input }

                        if (!seenToolUseIds.has(tc.toolUseId)) {
                            // 第一次遇到这个 toolUseId
                            seenToolUseIds.add(tc.toolUseId);

                            // 如果有未完成的工具调用，先保存它
                            if (currentToolCall) {
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
                        }

                        // ⚠️ 关键：每次都累积 input（无论是否第一次）
                        if (currentToolCall && tc.input) {
                            currentToolCall.input += tc.input;
                        }

                        // 如果有 stop 标志，保存 currentToolCall
                        if (tc.stop && currentToolCall) {
                            try {
                                currentToolCall.input = JSON.parse(currentToolCall.input);
                            } catch (e) {
                                // JSON 解析失败，保留原始字符串
                            }

                            // ⭐ 服务端执行 webSearch 工具
                            if (currentToolCall.name === 'webSearch') {
                                if (this.verboseLogging) {
                                    console.log('[Kiro WebSearch] Detected webSearch tool call, executing on server...');
                                }
                                currentToolCall.serverSideExecute = true;  // 标记为服务端执行
                            }

                            toolCalls.push(currentToolCall);
                            currentToolCall = null;
                        }
                    }
                } else if (event.type === 'metering') {
                    // Token 计量事件
                    const meterData = event.data;
                    if (meterData.usage !== undefined) {
                        // Kiro 返回的是 credit usage，需要转换为 token
                        const estimatedTokens = Math.ceil(meterData.usage * 1000);
                        outputTokens = estimatedTokens;
                    }
                } else if (event.type === 'codeReference') {
                    // ⭐ 代码引用追踪事件（官方 Kiro 特性）
                    // 收集代码引用信息，用于开源许可证追踪和代码溯源
                    const references = event.data.references;
                    if (references && references.length > 0) {
                        codeReferences.push(...references);
                        if (this.verboseLogging) {
                            console.log(`[Kiro] Code references detected: ${references.length} sources`);
                        }
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

            // ⭐ 4.5. 处理服务端执行的工具（webSearch）
            // 如果有 webSearch 工具调用，执行搜索并将结果作为额外内容返回
            const serverSideTools = toolCalls.filter(tc => tc.serverSideExecute);
            const clientSideTools = toolCalls.filter(tc => !tc.serverSideExecute);

            if (serverSideTools.length > 0) {
                if (this.verboseLogging) {
                    console.log(`[Kiro WebSearch] Processing ${serverSideTools.length} server-side tool calls...`);
                }

                let searchResultsContent = '';
                for (const tc of serverSideTools) {
                    if (tc.name === 'webSearch') {
                        const query = tc.input?.query || tc.input;
                        if (query) {
                            // 执行搜索
                            const searchResult = await executeWebSearch(query, this.verboseLogging);
                            const searchResultText = formatSearchResults(searchResult);
                            searchResultsContent += `\n\n---\n**Web Search Results for "${query}":**\n${searchResultText}`;
                        }
                    }
                }

                // 如果有搜索结果，发送为额外的文本内容
                if (searchResultsContent) {
                    const searchBlockIndex = (thinkingContent ? 1 : 0) + (textBlockStarted ? 1 : 0);

                    // 发送搜索结果文本块
                    yield {
                        type: "content_block_start",
                        index: searchBlockIndex,
                        content_block: { type: "text", text: "" }
                    };

                    yield {
                        type: "content_block_delta",
                        index: searchBlockIndex,
                        delta: { type: "text_delta", text: searchResultsContent }
                    };

                    yield { type: "content_block_stop", index: searchBlockIndex };

                    totalContent += searchResultsContent;
                    if (this.verboseLogging) {
                        console.log('[Kiro WebSearch] Search results added to response');
                    }
                }
            }

            // 5. 处理工具调用（如果有，只处理客户端执行的工具）
            if (clientSideTools.length > 0) {
                // 计算起始索引：thinking块(0或无) + text块(0或1) + 搜索结果块(如果有)
                let startIndex = 0;
                if (thinkingContent) startIndex++;  // thinking块占用index 0
                if (textBlockStarted) startIndex++;  // text块占用下一个index
                if (serverSideTools.length > 0) startIndex++;  // 搜索结果块

                for (let i = 0; i < clientSideTools.length; i++) {
                    const tc = clientSideTools[i];
                    const blockIndex = startIndex + i;

                    // ⚠️ 关键：反向映射参数名（Kiro → CC）
                    // Kiro 返回的参数使用 Kiro 的参数名（如 path, explanation）
                    // 需要转换回 CC 的参数名（如 file_path）并过滤 CC 不支持的参数
                    let toolInput = tc.input || {};
                    if (typeof toolInput === 'string') {
                        try {
                            toolInput = JSON.parse(toolInput);
                        } catch (e) {
                            // ⚠️ 修复：不完整的工具调用应该被跳过
                            // 打印详细日志帮助调试
                            console.warn(`[Kiro] Failed to parse tool input as JSON for ${tc.name}:`, toolInput.substring(0, 100));
                            console.warn(`[Kiro] Skipping incomplete tool call: ${tc.name} (toolUseId: ${tc.toolUseId})`);
                            // 跳过这个工具调用，不要发送空参数
                            continue;
                        }
                    }

                    // 检查必需参数是否存在（针对 Write 工具）
                    if (tc.name === 'Write' || tc.name === 'write_file') {
                        const hasFilePath = toolInput.file_path || toolInput.path;
                        const hasContent = toolInput.content !== undefined;
                        if (!hasFilePath || !hasContent) {
                            console.warn(`[Kiro] Incomplete Write tool call - missing required params. file_path: ${!!hasFilePath}, content: ${!!hasContent}`);
                            console.warn(`[Kiro] Skipping incomplete Write tool call (toolUseId: ${tc.toolUseId})`);
                            continue;
                        }
                    }

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

                    const reversedInput = this.reverseMapToolInput(tc.name, toolInput);
                    const inputJson = JSON.stringify(reversedInput);

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
            }

            // 7. 发送 message_delta 事件
            // 在流结束后统一计算 output tokens，避免在流式循环中阻塞事件循环
            outputTokens = this.countTextTokens(totalContent);
            if (thinkingContent) {
                outputTokens += this.countTextTokens(thinkingContent);
            }
            for (const tc of clientSideTools) {
                outputTokens += this.countTextTokens(JSON.stringify(tc.input || {}));
            }

            yield {
                type: "message_delta",
                delta: { stop_reason: clientSideTools.length > 0 ? "tool_use" : "end_turn" },
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
     * ⚠️ 修复：使用 getFullMessageTokens 替代 getContentText，确保计算 tool_use/tool_result
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

        // ⚠️ 关键修复：使用 getFullMessageTokens 计算完整 token（包含 tool_use, tool_result, thinking）
        if (requestBody.messages && Array.isArray(requestBody.messages)) {
            for (const message of requestBody.messages) {
                totalTokens += this.getFullMessageTokens(message, fast);
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
                        // 如果是字符串，先解析
                        if (typeof inputObject === 'string') {
                            inputObject = JSON.parse(inputObject);
                        }
                    } catch (e) {
                        // ⚠️ 修复：不要使用 raw_arguments，CC 不认识这个参数
                        console.warn(`[Kiro] Invalid JSON for tool call arguments (${tc.function.name}):`,
                            typeof tc.function.arguments === 'string' ? tc.function.arguments.substring(0, 100) : tc.function.arguments);
                        // 使用空对象作为 fallback，让 CC 处理缺失参数的情况
                        inputObject = {};
                    }

                    // ⚠️ 关键：反向映射参数名（Kiro → CC）
                    const reversedInput = this.reverseMapToolInput(tc.function.name, inputObject);
                    const inputJson = JSON.stringify(reversedInput);

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
                            partial_json: inputJson
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
                        // 如果是字符串，先解析
                        if (typeof inputObject === 'string') {
                            inputObject = JSON.parse(inputObject);
                        }
                    } catch (e) {
                        // ⚠️ 修复：不要使用 raw_arguments，CC 不认识这个参数
                        console.warn(`[Kiro] Invalid JSON for tool call arguments (${tc.function.name}):`,
                            typeof tc.function.arguments === 'string' ? tc.function.arguments.substring(0, 100) : tc.function.arguments);
                        // 使用空对象作为 fallback，让 CC 处理缺失参数的情况
                        inputObject = {};
                    }

                    // ⚠️ 关键：反向映射参数名（Kiro → CC）
                    const reversedInput = this.reverseMapToolInput(tc.function.name, inputObject);

                    contentArray.push({
                        type: "tool_use",
                        id: tc.id,
                        name: tc.function.name,
                        input: reversedInput
                    });
                    outputTokens += this.countTextTokens(JSON.stringify(reversedInput));
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
            if (this.verboseLogging) {
                console.log(`[Kiro] Expiry date: ${expirationTime.getTime()}, Current time: ${currentTime.getTime()}, ${this.config.CRON_NEAR_MINUTES || 10} minutes from now: ${thresholdTime.getTime()}`);
            }
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
