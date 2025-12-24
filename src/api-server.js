import * as http from 'http';
import { initializeConfig, CONFIG, logProviderSpecificDetails } from './config-manager.js';
import { initApiService } from './service-manager.js';
import { initializeUIManagement } from './ui-manager.js';
import { initializeAPIManagement } from './api-manager.js';
import { createRequestHandler } from './request-handler.js';

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * 描述 / Description:
 * (最终生产就绪版本 / Final Production Ready Version)
 * 此脚本创建一个独立的 Node.js HTTP 服务器，作为 AWS CodeWhisperer (Kiro) API 的本地代理。
 * 此版本包含所有功能和错误修复，设计为健壮、灵活且易于通过全面可控的日志系统进行监控。
 *
 * This script creates a standalone Node.js HTTP server that acts as a local proxy for the AWS CodeWhisperer (Kiro) API.
 * This version includes all features and bug fixes, designed to be robust, flexible, and easy to monitor through a comprehensive and controllable logging system.
 *
 * 主要功能 / Key Features:
 * - Claude API 兼容性：无缝桥接使用 Claude API 格式的客户端与 AWS CodeWhisperer API。支持 Claude Messages API (`/v1/messages`) 端点。
 *   Claude API Compatibility: Seamlessly bridges clients using the Claude API format with the AWS CodeWhisperer API. Supports Claude Messages API (`/v1/messages`) endpoint.
 *
 * - 强大的身份验证管理：支持 OAuth 2.0 配置，通过 Base64 字符串或文件路径加载凭据。能够自动刷新过期令牌以确保服务持续运行。
 *   Robust Authentication Management: Supports OAuth 2.0 configuration via Base64 strings or file paths. Capable of automatically refreshing expired tokens to ensure continuous service operation.
 *
 * - 灵活的 API 密钥验证：支持 `Authorization: Bearer <key>` 请求头验证，可通过 `--api-key` 启动参数配置。
 *   Flexible API Key Validation: Supports `Authorization: Bearer <key>` request header validation, configurable via the `--api-key` startup parameter.
 *
 * - 动态系统提示管理 / Dynamic System Prompt Management:
 *   - 文件注入：通过 `--system-prompt-file` 从外部文件加载系统提示，并通过 `--system-prompt-mode` 控制其行为（覆盖或追加）。
 *     File Injection: Loads system prompts from external files via `--system-prompt-file` and controls their behavior (overwrite or append) with `--system-prompt-mode`.
 *   - 实时同步：能够将请求中包含的系统提示实时写入 `fetch_system_prompt.txt` 文件，便于开发者观察和调试。
 *     Real-time Synchronization: Capable of writing system prompts included in requests to the `fetch_system_prompt.txt` file in real-time, facilitating developer observation and debugging.
 *
 * - 智能请求转换和修复：自动将 Claude 格式的请求转换为 Kiro 格式，包括消息验证、工具格式转换以及修复缺失字段。
 *   Intelligent Request Conversion and Repair: Automatically converts Claude-formatted requests to Kiro format, including message validation, tool format conversion, and fixing missing fields.
 *
 * - 全面可控的日志系统：提供两种日志模式（控制台或文件），详细记录每个请求的输入和输出、剩余令牌有效性等信息，用于监控和调试。
 *   Comprehensive and Controllable Logging System: Provides two logging modes (console or file), detailing input and output of each request, remaining token validity, and other information for monitoring and debugging.
 *
 * - 高度可配置的启动：支持通过命令行参数配置服务监听地址、端口、API 密钥和日志模式。
 *   Highly Configurable Startup: Supports configuring service listening address, port, API key, and logging mode via command-line parameters.
 *
 * 使用示例 / Usage Examples:
 *
 * 基本用法 / Basic Usage:
 * node src/api-server.js
 *
 * 服务器配置 / Server Configuration:
 * node src/api-server.js --host 0.0.0.0 --port 8080 --api-key your-secret-key
 *
 * Kiro OAuth 提供商（使用 Base64 凭据）/ Kiro OAuth Provider (with Base64 credentials):
 * node src/api-server.js --model-provider claude-kiro-oauth --kiro-oauth-creds-base64 eyJ0eXBlIjoi...
 *
 * Kiro OAuth 提供商（使用凭据文件）/ Kiro OAuth Provider (with credentials file):
 * node src/api-server.js --model-provider claude-kiro-oauth --kiro-oauth-creds-file ./configs/kiro/kiro-auth-token.json
 *
 * 系统提示管理 / System Prompt Management:
 * node src/api-server.js --system-prompt-file custom-prompt.txt --system-prompt-mode append
 *
 * 日志配置 / Logging Configuration:
 * node src/api-server.js --log-prompts console
 * node src/api-server.js --log-prompts file --prompt-log-base-name my-logs
 *
 * 完整示例 / Complete Example:
 * node src/api-server.js \
 *   --host 0.0.0.0 \
 *   --port 8045 \
 *   --api-key my-secret-key \
 *   --model-provider claude-kiro-oauth \
 *   --kiro-oauth-creds-file ./configs/kiro/kiro-auth-token.json \
 *   --system-prompt-file ./custom-system-prompt.txt \
 *   --system-prompt-mode overwrite \
 *   --log-prompts file \
 *   --prompt-log-base-name api-logs
 *
 * 命令行参数 / Command Line Parameters:
 * --host <address>                    服务器监听地址 / Server listening address (default: localhost)
 * --port <number>                     服务器监听端口 / Server listening port (default: 8045)
 * --api-key <key>                     身份验证所需的 API 密钥 / Required API key for authentication (default: 123456)
 * --model-provider <provider>         AI 模型提供商 / AI model provider: claude-kiro-oauth (default)
 * --kiro-oauth-creds-base64 <b64>    Kiro OAuth 凭据的 Base64 字符串 / Kiro OAuth credentials as Base64 string
 * --kiro-oauth-creds-file <path>     Kiro OAuth 凭据 JSON 文件路径 / Path to Kiro OAuth credentials JSON file
 * --system-prompt-file <path>        系统提示文件路径 / Path to system prompt file (default: input_system_prompt.txt)
 * --system-prompt-mode <mode>        系统提示模式 / System prompt mode: overwrite or append (default: overwrite)
 * --log-prompts <mode>               提示日志模式 / Prompt logging mode: console, file, or none (default: none)
 * --prompt-log-base-name <name>      提示日志文件基础名称 / Base name for prompt log files (default: prompt_log)
 * --request-max-retries <number>     API 请求失败时，自动重试的最大次数。 / Max retries for API requests on failure (default: 3)
 * --request-base-delay <number>      自动重试之间的基础延迟时间（毫秒）。每次重试后延迟会增加。 / Base delay in milliseconds between retries, increases with each retry (default: 1000)
 * --cron-near-minutes <number>       OAuth 令牌刷新任务计划的间隔时间（分钟）。 / Interval for OAuth token refresh task in minutes (default: 15)
 * --cron-refresh-token <boolean>     是否开启 OAuth 令牌自动刷新任务 / Whether to enable automatic OAuth token refresh task (default: true)
 * --provider-pools-file <path>       提供商号池配置文件路径 / Path to provider pools configuration file (default: null)
 *
 */

import 'dotenv/config'; // Import dotenv and configure it
import './converters/register-converters.js'; // 注册所有转换器
import { getProviderPoolManager } from './service-manager.js';

// --- Server Initialization ---
async function startServer() {
    // Initialize configuration
    await initializeConfig();
    
    // Initialize API services
    const services = await initApiService(CONFIG);
    
    // Initialize UI management features
    initializeUIManagement(CONFIG);
    
    // Initialize API management and get heartbeat function
    const heartbeatAndRefreshToken = initializeAPIManagement(services);
    
    // Create request handler
    const requestHandlerInstance = createRequestHandler(CONFIG, getProviderPoolManager());

    const server = http.createServer(requestHandlerInstance);
    server.listen(CONFIG.SERVER_PORT, CONFIG.HOST, async () => {
        console.log(`--- Unified API Server Configuration ---`);
        const configuredProviders = Array.isArray(CONFIG.DEFAULT_MODEL_PROVIDERS) && CONFIG.DEFAULT_MODEL_PROVIDERS.length > 0
            ? CONFIG.DEFAULT_MODEL_PROVIDERS
            : [CONFIG.MODEL_PROVIDER];
        const uniqueProviders = [...new Set(configuredProviders)];
        console.log(`  Primary Model Provider: ${CONFIG.MODEL_PROVIDER}`);
        if (uniqueProviders.length > 1) {
            console.log(`  Additional Model Providers: ${uniqueProviders.slice(1).join(', ')}`);
        }
        uniqueProviders.forEach((provider) => logProviderSpecificDetails(provider, CONFIG));
        console.log(`  System Prompt File: ${CONFIG.SYSTEM_PROMPT_FILE_PATH || 'Default'}`);
        console.log(`  System Prompt Mode: ${CONFIG.SYSTEM_PROMPT_MODE}`);
        console.log(`  Host: ${CONFIG.HOST}`);
        console.log(`  Port: ${CONFIG.SERVER_PORT}`);
        console.log(`  Required API Key: ${CONFIG.REQUIRED_API_KEY}`);
        console.log(`  Prompt Logging: ${CONFIG.PROMPT_LOG_MODE}${CONFIG.PROMPT_LOG_FILENAME ? ` (to ${CONFIG.PROMPT_LOG_FILENAME})` : ''}`);
        console.log(`------------------------------------------`);
        console.log(`\nUnified API Server running on http://${CONFIG.HOST}:${CONFIG.SERVER_PORT}`);
        console.log(`Supports multiple API formats:`);
        console.log(`  • OpenAI-compatible: /v1/chat/completions, /v1/responses, /v1/models`);
        console.log(`  • Gemini-compatible: /v1beta/models, /v1beta/models/{model}:generateContent`);
        console.log(`  • Claude-compatible: /v1/messages`);
        console.log(`  • Health check: /health`);
        console.log(`  • UI Management Console: http://${CONFIG.HOST}:${CONFIG.SERVER_PORT}/`);

        // Auto-open browser to UI (only if host is localhost or 127.0.0.1)
        if (CONFIG.HOST === 'localhost' || CONFIG.HOST === '127.0.0.1') {
            try {
                const open = (await import('open')).default;
                setTimeout(() => {
                    open(`http://${CONFIG.HOST}:${CONFIG.SERVER_PORT}/login.html`)
                        .then(() => {
                            console.log('[UI] Opened login page in default browser');
                        })
                        .catch(err => {
                            console.log('[UI] Please open manually: http://' + CONFIG.HOST + ':' + CONFIG.SERVER_PORT + '/login.html');
                        });
                }, 1000);
            } catch (err) {
                console.log(`[UI] Login page available at: http://${CONFIG.HOST}:${CONFIG.SERVER_PORT}/login.html`);
            }
        } else {
            console.log('[UI] Login page available at: http://' + CONFIG.HOST + ':' + CONFIG.SERVER_PORT + '/login.html');
        }

        // Suppress unhandled error events from open module
        process.on('uncaughtException', (err) => {
            if (err.code === 'ENOENT' && err.syscall === 'spawn xdg-open') {
                console.log('[UI] Could not auto-open browser. Please visit http://' + CONFIG.HOST + ':' + CONFIG.SERVER_PORT + '/login.html manually');
            } else {
                console.error('[Server] Uncaught Exception:', err);
                process.exit(1);
            }
        });

        if (CONFIG.CRON_REFRESH_TOKEN) {
            console.log(`  • Cron Near Minutes: ${CONFIG.CRON_NEAR_MINUTES}`);
            console.log(`  • Cron Refresh Token: ${CONFIG.CRON_REFRESH_TOKEN}`);
            // 每 CRON_NEAR_MINUTES 分钟执行一次心跳日志和令牌刷新
            setInterval(heartbeatAndRefreshToken, CONFIG.CRON_NEAR_MINUTES * 60 * 1000);
        }
        // 服务器完全启动后,执行初始健康检查
        const poolManager = getProviderPoolManager();
        if (poolManager) {
            console.log('[Initialization] Performing initial health checks for provider pools...');
            poolManager.performHealthChecks(true);
        }
    });
    return server; // Return the server instance for testing purposes
}

startServer().catch(err => {
    console.error("[Server] Failed to start server:", err.message);
    process.exit(1);
});
