/**
 * Roxy Browser 指纹浏览器 API 客户端
 * 参考: D:\project\github\roxy_client.py
 */

import axios from 'axios';
import config from './config.js';

export class RoxyBrowserClient {
    constructor() {
        this.baseUrl = config.roxyBrowser.baseUrl;
        this.token = config.roxyBrowser.token;
        this._workspaceId = config.roxyBrowser.workspaceId || null;
    }

    /**
     * 构建请求头
     */
    _buildHeaders() {
        return {
            'Content-Type': 'application/json',
            'token': this.token,
        };
    }

    /**
     * 发送 POST 请求
     */
    async _post(path, data = null) {
        try {
            const response = await axios.post(`${this.baseUrl}${path}`, data, {
                headers: this._buildHeaders(),
                timeout: 120000,
            });
            return response.data;
        } catch (error) {
            console.error(`[RoxyBrowser] POST 请求失败: ${error.message}`);
            return { code: 500, msg: error.message };
        }
    }

    /**
     * 发送 GET 请求
     */
    async _get(path, params = null) {
        try {
            const response = await axios.get(`${this.baseUrl}${path}`, {
                headers: this._buildHeaders(),
                params,
                timeout: 120000,
            });
            return response.data;
        } catch (error) {
            console.error(`[RoxyBrowser] GET 请求失败: ${error.message}`);
            return { code: 500, msg: error.message };
        }
    }

    /**
     * 健康检查
     */
    async health() {
        const result = await this._get('/health');
        return result.code === 0;
    }

    /**
     * 获取工作空间 ID
     */
    async getWorkspaceId() {
        if (this._workspaceId) {
            return this._workspaceId;
        }

        const result = await this._get('/browser/workspace');
        if (result.code === 0) {
            const rows = result.data?.rows || [];
            if (rows.length > 0) {
                this._workspaceId = rows[0].id;
                console.log(`[RoxyBrowser] 获取工作空间 ID: ${this._workspaceId}`);
                return this._workspaceId;
            }
        }

        console.error('[RoxyBrowser] 获取工作空间 ID 失败');
        return null;
    }

    /**
     * 随机选择操作系统（macOS 或 Linux）
     */
    _getRandomOS() {
        const osOptions = [
            { os: 'MacOS', osVersion: '14' },      // macOS Sonoma
            { os: 'MacOS', osVersion: '13' },      // macOS Ventura
            { os: 'MacOS', osVersion: '12' },      // macOS Monterey
            { os: 'Linux', osVersion: 'Ubuntu' },
            { os: 'Linux', osVersion: 'Fedora' },
        ];

        const selected = osOptions[Math.floor(Math.random() * osOptions.length)];
        console.log(`[RoxyBrowser] 随机选择操作系统: ${selected.os} ${selected.osVersion}`);
        return selected;
    }

    /**
     * 创建新的浏览器窗口
     * @param {object} options - 窗口配置
     */
    async createBrowser(options = {}) {
        const workspaceId = await this.getWorkspaceId();
        if (!workspaceId) {
            throw new Error('无法获取工作空间 ID');
        }

        // 代理配置（默认无代理）
        const proxyInfo = options.proxy || {
            proxyMethod: 'custom',
            proxyCategory: 'noproxy',
        };

        // 指纹配置
        const fingerInfo = {
            isLanguageBaseIp: false,
            language: 'en-US',
            isDisplayLanguageBaseIp: false,
            displayLanguage: 'en-US',
            isTimeZone: true,
            forbidImage: false,
            forbidMedia: false,
            forbidAudio: false,
            randomFingerprint: true,
            clearCookie: true,
            clearCacheFile: true,
            clearLocalStorage: true,
            syncTab: false,
            syncCookie: false,
            syncPassword: false,
            openWorkbench: 0,
            portScanProtect: true,
        };

        // 随机选择 macOS 或 Linux（避免使用 Windows）
        const osConfig = this._getRandomOS();

        const data = {
            workspaceId,
            windowName: options.name || `kiro-register-${Date.now()}`,
            coreVersion: '125',
            os: osConfig.os,
            osVersion: osConfig.osVersion,
            proxyInfo,
            fingerInfo,
            defaultOpenUrl: [],
        };

        let result = await this._post('/browser/create', data);

        if (result.code === 0) {
            const dirId = result.data?.dirId;
            console.log(`[RoxyBrowser] 创建浏览器成功: ${dirId}`);
            return dirId;
        }

        // 如果额度不足，自动清理旧窗口后重试
        const errorMsg = result.msg || '';
        if (errorMsg.includes('额度不足') || errorMsg.toLowerCase().includes('quota')) {
            console.log('[RoxyBrowser] 窗口额度不足，自动清理旧窗口...');
            await this.cleanOldBrowsers(0);

            // 重试创建
            result = await this._post('/browser/create', data);
            if (result.code === 0) {
                const dirId = result.data?.dirId;
                console.log(`[RoxyBrowser] 创建浏览器成功: ${dirId}`);
                return dirId;
            }
        }

        throw new Error(`创建浏览器失败: ${result.msg}`);
    }

    /**
     * 打开浏览器窗口
     * @param {string} dirId - 浏览器窗口 ID
     * @returns {Promise<{ws: string, http: string}>} 连接信息
     */
    async openBrowser(dirId) {
        const workspaceId = await this.getWorkspaceId();

        const data = {
            workspaceId,
            dirId,
            args: ['--remote-allow-origins=*'],
        };

        const result = await this._post('/browser/open', data);

        if (result.code === 0) {
            const info = result.data || {};
            console.log(`[RoxyBrowser] 打开浏览器成功: ws=${info.ws}`);
            return {
                ws: info.ws,
                http: info.http,
                driver: info.driver,
                coreVersion: info.coreVersion,
                pid: info.pid,
            };
        }

        throw new Error(`打开浏览器失败: ${result.msg}`);
    }

    /**
     * 关闭浏览器窗口
     * @param {string} dirId - 浏览器窗口 ID
     */
    async closeBrowser(dirId) {
        const result = await this._post('/browser/close', { dirId });
        if (result.code === 0) {
            console.log(`[RoxyBrowser] 关闭浏览器成功: ${dirId}`);
            return true;
        }
        console.warn(`[RoxyBrowser] 关闭浏览器失败: ${result.msg}`);
        return false;
    }

    /**
     * 删除浏览器窗口
     * @param {string} dirId - 浏览器窗口 ID
     */
    async deleteBrowser(dirId) {
        const workspaceId = await this.getWorkspaceId();
        const result = await this._post('/browser/delete', {
            workspaceId,
            dirIds: [dirId],
        });
        if (result.code === 0) {
            console.log(`[RoxyBrowser] 删除浏览器成功: ${dirId}`);
            return true;
        }
        console.warn(`[RoxyBrowser] 删除浏览器失败: ${result.msg}`);
        return false;
    }

    /**
     * 获取浏览器列表
     */
    async getBrowserList() {
        const workspaceId = await this.getWorkspaceId();
        if (!workspaceId) return [];

        const result = await this._get('/browser/list_v3', {
            workspaceId,
            page_index: 1,
            page_size: 100,
        });

        if (result.code === 0) {
            return result.data?.rows || [];
        }
        return [];
    }

    /**
     * 清理旧的浏览器窗口
     * @param {number} keepCount - 保留数量，默认全部删除
     */
    async cleanOldBrowsers(keepCount = 0) {
        const browsers = await this.getBrowserList();
        if (!browsers.length) return 0;

        // 按创建时间排序（保留最新的）
        browsers.sort((a, b) => (b.createTime || '').localeCompare(a.createTime || ''));

        const toDelete = keepCount > 0 ? browsers.slice(keepCount) : browsers;
        let deleted = 0;

        console.log(`[RoxyBrowser] 清理旧浏览器: 共 ${browsers.length} 个，删除 ${toDelete.length} 个`);

        for (const browser of toDelete) {
            const dirId = browser.dirId;
            if (dirId) {
                await this.closeBrowser(dirId);
                if (await this.deleteBrowser(dirId)) {
                    deleted++;
                }
            }
        }

        return deleted;
    }

    /**
     * 创建并打开新窗口
     * @param {string} name - 窗口名称
     * @returns {Promise<{dirId: string, ws: string}>}
     */
    async createAndOpen(name) {
        console.log(`[RoxyBrowser] 创建新窗口: ${name}`);

        // 创建窗口
        const dirId = await this.createBrowser({ name });

        // 打开窗口
        const openResult = await this.openBrowser(dirId);

        return {
            dirId,
            ws: openResult.ws,
            http: openResult.http,
        };
    }

    /**
     * 测试连接
     */
    async test() {
        try {
            console.log('[RoxyBrowser] 测试连接...');
            const healthy = await this.health();
            if (!healthy) {
                return { success: false, error: 'Health check failed' };
            }

            const workspaceId = await this.getWorkspaceId();
            if (!workspaceId) {
                return { success: false, error: 'Failed to get workspace ID' };
            }

            const browsers = await this.getBrowserList();
            console.log(`[RoxyBrowser] 连接成功, 工作空间: ${workspaceId}, 窗口数: ${browsers.length}`);
            return { success: true, workspaceId, windowCount: browsers.length };
        } catch (error) {
            console.error(`[RoxyBrowser] 连接测试失败: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
}

export default RoxyBrowserClient;
