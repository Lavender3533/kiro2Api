import fs from 'fs';
import path from 'path';
import os from 'os';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';

// 延迟导入 broadcastEvent 避免循环依赖
let _broadcastEvent = null;
async function getBroadcastEvent() {
    if (!_broadcastEvent) {
        const uiManager = await import('./ui-manager.js');
        _broadcastEvent = uiManager.broadcastEvent;
    }
    return _broadcastEvent;
}

/**
 * Kiro OAuth 配置 (AWS SSO BuilderId)
 */
const KIRO_OAUTH_CONFIG = {
    startUrl: 'https://view.awsapps.com/start/',
    region: 'us-east-1',
    credentialsDir: '.aws/sso/cache',
    credentialsFile: 'kiro-auth-token.json',
    logPrefix: '[Kiro OAuth]'
};

/**
 * 生成 UUID
 */
function generateUUID() {
    return uuidv4();
}

/**
 * 处理 Kiro OAuth 授权 (AWS SSO 设备授权流程)
 * 使用动态客户端注册来获取 clientId 和 clientSecret
 * @param {Object} currentConfig - 当前配置对象
 * @param {Object} providerPoolManager - 提供商池管理器实例（可选）
 * @returns {Promise<Object>} 返回授权URL和相关信息
 */
export async function handleKiroOAuth(currentConfig, providerPoolManager = null) {
    try {
        const region = currentConfig.KIRO_REGION || KIRO_OAUTH_CONFIG.region;
        const startUrl = currentConfig.KIRO_START_URL || KIRO_OAUTH_CONFIG.startUrl;

        // AWS SSO OIDC 的 scopes (从 Kiro 源码获取)
        const scopes = [
            'codewhisperer:completions',
            'codewhisperer:analysis',
            'codewhisperer:conversations',
            'codewhisperer:transformations',
            'codewhisperer:taskassist'
        ];

        console.log(`${KIRO_OAUTH_CONFIG.logPrefix} Starting automatic client registration...`);
        console.log(`${KIRO_OAUTH_CONFIG.logPrefix} Region: ${region}, Start URL: ${startUrl}`);

        // Step 1: 自动注册 Client (调用 AWS SSO OIDC RegisterClient API)
        const registerClientUrl = `https://oidc.${region}.amazonaws.com/client/register`;
        const registerClientBody = {
            clientName: 'Kiro IDE',
            clientType: 'public',
            scopes: scopes,
            grantTypes: ['authorization_code', 'refresh_token'],
            redirectUris: ['http://127.0.0.1/oauth/callback'],
            issuerUrl: startUrl
        };

        const axios = (await import('axios')).default;
        const registerResponse = await axios.post(registerClientUrl, registerClientBody, {
            headers: {
                'Content-Type': 'application/json'
            },
            timeout: 30000
        });

        const { clientId, clientSecret, clientSecretExpiresAt } = registerResponse.data;

        if (!clientId || !clientSecret) {
            throw new Error('Failed to register client: missing clientId or clientSecret in response');
        }

        console.log(`${KIRO_OAUTH_CONFIG.logPrefix} Client registered successfully!`);
        console.log(`${KIRO_OAUTH_CONFIG.logPrefix} Client ID: ${clientId.substring(0, 10)}...`);
        console.log(`${KIRO_OAUTH_CONFIG.logPrefix} Client expires at: ${new Date(clientSecretExpiresAt * 1000).toISOString()}`);

        // 动态导入 KiroApiService (避免循环依赖)
        const { KiroApiService } = await import('./claude/claude-kiro.js');

        // 创建临时实例用于设备授权
        const kiroService = new KiroApiService(currentConfig);

        // 设置必要的属性
        kiroService.clientId = clientId;
        kiroService.clientSecret = clientSecret;
        kiroService.region = region;
        kiroService.authMethod = 'IdC';

        // 初始化 axios 实例 (skipAuthCheck=true 因为设备授权前没有现有凭据)
        await kiroService.initialize(true);

        console.log(`${KIRO_OAUTH_CONFIG.logPrefix} 启动设备授权流程`);
        console.log(`${KIRO_OAUTH_CONFIG.logPrefix} Start URL: ${startUrl}`);

        // 启动设备授权流程
        const deviceAuthInfo = await kiroService.startDeviceAuthorization(startUrl);

        console.log(`${KIRO_OAUTH_CONFIG.logPrefix} Device authorization started`);
        console.log(`${KIRO_OAUTH_CONFIG.logPrefix} User Code: ${deviceAuthInfo.userCode}`);
        console.log(`${KIRO_OAUTH_CONFIG.logPrefix} Verification URI: ${deviceAuthInfo.verificationUriComplete}`);

        // 启动后台轮询（不等待完成）
        kiroService.pollDeviceToken(
            deviceAuthInfo.deviceCode,
            deviceAuthInfo.interval,
            deviceAuthInfo.expiresIn
        ).then(async tokenResult => {
            // 轮询成功，保存token到configs/kiro目录
            const kiroConfigDir = path.join(process.cwd(), 'configs', 'kiro');

            // 确保目录存在
            await fs.promises.mkdir(kiroConfigDir, { recursive: true });

            // 生成唯一的账户编号
            const accountNumber = Date.now();
            const tokenFilePath = path.join(kiroConfigDir, `kiro-auth-token-${accountNumber}.json`);
            const credentialsData = {
                accessToken: tokenResult.accessToken,
                refreshToken: tokenResult.refreshToken,
                expiresAt: tokenResult.expiresAt,
                clientId: clientId,
                clientSecret: clientSecret,
                authMethod: 'IdC',
                provider: 'BuilderId',
                region: region
            };

            await fs.promises.writeFile(tokenFilePath, JSON.stringify(credentialsData, null, 2));
            console.log(`${KIRO_OAUTH_CONFIG.logPrefix} Token saved to: ${tokenFilePath}`);

            // 自动添加到 provider_pools.json
            try {
                const poolsFilePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'provider_pools.json';
                let providerPools = {};

                // 读取现有池
                if (existsSync(poolsFilePath)) {
                    const fileContent = readFileSync(poolsFilePath, 'utf8');
                    providerPools = JSON.parse(fileContent);
                }

                // 确保 claude-kiro-oauth 数组存在
                if (!providerPools['claude-kiro-oauth']) {
                    providerPools['claude-kiro-oauth'] = [];
                }

                // 检查是否已存在相同路径的配置
                const relativePath = path.relative(process.cwd(), tokenFilePath);
                const normalizedPath = relativePath.replace(/\\/g, '/');
                const exists = providerPools['claude-kiro-oauth'].some(p => {
                    const existingPath = (p.KIRO_OAUTH_CREDS_FILE_PATH || '').replace(/\\/g, '/');
                    return existingPath === normalizedPath || existingPath === './' + normalizedPath;
                });

                if (!exists) {
                    // 创建新的提供商配置
                    const newProvider = {
                        uuid: generateUUID(),
                        KIRO_OAUTH_CREDS_FILE_PATH: normalizedPath,
                        isHealthy: true,
                        usageCount: 0,
                        errorCount: 0,
                        lastUsed: null,
                        lastErrorTime: null,
                        isDisabled: false,
                        lastHealthCheckTime: new Date().toISOString(),
                        lastHealthCheckModel: 'claude-haiku-4-5',
                        lastErrorMessage: null,
                        checkModelName: '',
                        checkHealth: true,
                        notSupportedModels: []
                    };

                    providerPools['claude-kiro-oauth'].push(newProvider);

                    // 保存到文件
                    writeFileSync(poolsFilePath, JSON.stringify(providerPools, null, 2), 'utf8');
                    console.log(`${KIRO_OAUTH_CONFIG.logPrefix} Auto-added to provider pool with UUID: ${newProvider.uuid}`);

                    // 更新 provider pool manager
                    if (providerPoolManager) {
                        providerPoolManager.providerPools = providerPools;
                        providerPoolManager.initializeProviderStatus();
                    }

                    // 广播提供商更新事件
                    const broadcast = await getBroadcastEvent();
                    if (broadcast) {
                        broadcast('provider_update', {
                            action: 'add',
                            provider: 'claude-kiro-oauth',
                            uuid: newProvider.uuid,
                            timestamp: new Date().toISOString()
                        });
                    }
                }
            } catch (poolError) {
                console.error(`${KIRO_OAUTH_CONFIG.logPrefix} Failed to update provider pool:`, poolError);
            }

            // 广播授权完成事件
            const broadcast = await getBroadcastEvent();
            if (broadcast) {
                broadcast('oauth_complete', {
                    provider: 'claude-kiro-oauth',
                    success: true,
                    timestamp: new Date().toISOString()
                });
            }
        }).catch(async error => {
            console.error(`${KIRO_OAUTH_CONFIG.logPrefix} Background polling failed:`, error.message);
            const broadcast = await getBroadcastEvent();
            if (broadcast) {
                broadcast('oauth_complete', {
                    provider: 'claude-kiro-oauth',
                    success: false,
                    error: error.message,
                    timestamp: new Date().toISOString()
                });
            }
        });

        // 广播授权开始事件
        const broadcast = await getBroadcastEvent();
        if (broadcast) {
            broadcast('oauth_start', {
                provider: 'claude-kiro-oauth',
                timestamp: new Date().toISOString()
            });
        }

        return {
            authUrl: deviceAuthInfo.verificationUriComplete,
            authInfo: {
                provider: 'claude-kiro-oauth',
                authMethod: 'IdC',
                deviceCode: deviceAuthInfo.deviceCode,
                userCode: deviceAuthInfo.userCode,
                verificationUri: deviceAuthInfo.verificationUri,
                verificationUriComplete: deviceAuthInfo.verificationUriComplete,
                expiresIn: deviceAuthInfo.expiresIn,
                interval: deviceAuthInfo.interval,
                instructions: '请在浏览器中打开此链接进行AWS SSO授权。授权完成后,系统会自动获取访问令牌并添加到提供商池中。'
            }
        };
    } catch (error) {
        console.error(`${KIRO_OAUTH_CONFIG.logPrefix} 授权失败:`, error);
        throw new Error(`Kiro OAuth 授权失败: ${error.message}`);
    }
}
