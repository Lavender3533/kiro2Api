/**
 * Kiro2API 服务器客户端
 * 用于同步注册的 token 到服务器
 */

import axios from 'axios';
import config from './config.js';

export class Kiro2ApiClient {
    constructor(authToken = null) {
        this.baseUrl = config.kiro2api.baseUrl;
        this.authToken = authToken;
    }

    /**
     * 设置认证 token
     */
    setAuthToken(token) {
        this.authToken = token;
    }

    /**
     * 发送 API 请求
     */
    async request(endpoint, method = 'GET', data = null) {
        try {
            const url = `${this.baseUrl}${endpoint}`;
            const options = {
                method,
                url,
                headers: {
                    'Content-Type': 'application/json',
                },
                timeout: 30000,
            };

            if (this.authToken) {
                options.headers['Authorization'] = `Bearer ${this.authToken}`;
            }

            if (data) {
                options.data = data;
            }

            const response = await axios(options);
            return response.data;
        } catch (error) {
            console.error(`[Kiro2API] API 请求失败: ${error.message}`);
            throw error;
        }
    }

    /**
     * 手动导入 RefreshToken
     * @param {string} refreshToken - Kiro OAuth RefreshToken
     * @param {number} accountNumber - 账号编号
     * @param {string} profileArn - 可选的 ProfileArn
     */
    async importToken(refreshToken, accountNumber, profileArn = null) {
        console.log(`[Kiro2API] 导入 token 到服务器 (账号 #${accountNumber})`);

        const payload = {
            refreshToken,
            accountNumber,
        };

        if (profileArn) {
            payload.profileArn = profileArn;
        }

        const result = await this.request('/api/kiro/oauth/manual-import', 'POST', payload);

        if (result.success) {
            console.log(`[Kiro2API] Token 导入成功: ${result.message || ''}`);
        } else {
            console.error(`[Kiro2API] Token 导入失败: ${result.message || result.error || '未知错误'}`);
        }

        return result;
    }

    /**
     * 获取当前提供商列表
     */
    async getProviders() {
        return this.request('/api/providers');
    }

    /**
     * 获取下一个可用的账号编号
     */
    async getNextAccountNumber() {
        try {
            const providers = await this.getProviders();
            const kiroAccounts = providers['claude-kiro-oauth'] || [];

            let maxNumber = 0;
            for (const account of kiroAccounts) {
                const filePath = account.KIRO_OAUTH_CREDS_FILE_PATH || '';
                const match = filePath.match(/kiro-auth-token-(\d+)\.json/);
                if (match) {
                    const num = parseInt(match[1], 10);
                    if (num > maxNumber) {
                        maxNumber = num;
                    }
                }
            }

            return maxNumber + 1;
        } catch (error) {
            console.warn(`[Kiro2API] 获取账号编号失败: ${error.message}`);
            return 1;
        }
    }

    /**
     * 检查指定账号的 token 是否已存在
     * @param {number} accountNumber - 账号编号
     */
    async checkTokenExists(accountNumber) {
        try {
            const providers = await this.getProviders();
            const kiroAccounts = providers['claude-kiro-oauth'] || [];

            const targetFile = `kiro-auth-token-${accountNumber}.json`;
            const account = kiroAccounts.find(acc => {
                const filePath = acc.KIRO_OAUTH_CREDS_FILE_PATH || '';
                return filePath.includes(targetFile);
            });

            return {
                exists: !!account,
                account: account || null,
            };
        } catch (error) {
            console.warn(`[Kiro2API] 检查 token 失败: ${error.message}`);
            return { exists: false, account: null };
        }
    }

    /**
     * 测试连接
     */
    async test() {
        try {
            console.log('[Kiro2API] 测试连接...');
            const result = await this.request('/health');
            console.log(`[Kiro2API] 连接成功`);
            return { success: true };
        } catch (error) {
            console.error(`[Kiro2API] 连接测试失败: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
}

export default Kiro2ApiClient;
