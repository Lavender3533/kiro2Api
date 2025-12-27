/**
 * SQLite 版本的提供商池管理器
 * 使用 SQLite 进行数据持久化，支持高效查询和并发操作
 */

import { sqliteDB } from './sqlite-db.js';
import { getServiceAdapter } from './adapter.js';
import * as fs from 'fs';

export class SQLiteProviderPoolManager {
    // 默认健康检查模型配置
    static DEFAULT_HEALTH_CHECK_MODELS = {
        'claude-kiro-oauth': 'claude-sonnet-4-20250514'
    };

    constructor(options = {}) {
        this.globalConfig = options.globalConfig || {};
        this.maxErrorCount = options.maxErrorCount ?? 3;
        this.healthCheckInterval = options.healthCheckInterval ?? 10 * 60 * 1000; // 10 分钟
        this.usageCacheTTL = options.usageCacheTTL ?? 300; // 5 分钟
        this.logLevel = options.logLevel || 'info';

        // 轮询索引（内存中维护）
        this.roundRobinIndex = {};

        // 并发控制
        this.healthCheckConcurrency = options.healthCheckConcurrency ?? 5;
        this.usageQueryConcurrency = options.usageQueryConcurrency ?? 10;

        // 初始化数据库
        const dbPath = options.dbPath || this.globalConfig.SQLITE_DB_PATH || 'data/provider_pool.db';
        sqliteDB.init(dbPath);

        this._log('info', `SQLiteProviderPoolManager initialized (maxErrorCount: ${this.maxErrorCount})`);
    }

    /**
     * 日志输出方法
     * @private
     */
    _log(level, message) {
        const levels = { debug: 0, info: 1, warn: 2, error: 3 };
        if (levels[level] >= levels[this.logLevel]) {
            const logMethod = level === 'debug' ? 'log' : level;
            console[logMethod](`[SQLitePoolManager] ${message}`);
        }
    }

    /**
     * 从 JSON 文件导入提供商配置（智能合并，不覆盖运行时数据）
     * @param {Object} providerPools - 原始提供商池配置（从 JSON 文件加载）
     */
    importFromJson(providerPools) {
        const db = sqliteDB.getDb();
        let newCount = 0;
        let updateCount = 0;

        const transaction = db.transaction(() => {
            for (const providerType in providerPools) {
                const providers = providerPools[providerType];
                for (const provider of providers) {
                    // 检查是否已存在
                    const existing = sqliteDB.getProviderByUuid(provider.uuid);

                    if (existing) {
                        // 已存在：只更新配置字段，保留运行时数据
                        const stmt = db.prepare(`
                            UPDATE providers SET
                                config = ?,
                                not_supported_models = ?,
                                updated_at = datetime('now')
                            WHERE uuid = ?
                        `);
                        stmt.run(
                            JSON.stringify(provider),
                            provider.notSupportedModels ? JSON.stringify(provider.notSupportedModels) : null,
                            provider.uuid
                        );
                        updateCount++;
                    } else {
                        // 新账号：完整插入
                        sqliteDB.upsertProvider({
                            ...provider,
                            providerType
                        });
                        newCount++;
                    }
                }
            }
        });
        transaction();
        this._log('info', `Imported from JSON: ${newCount} new, ${updateCount} updated (runtime data preserved)`);
    }

    /**
     * 导出提供商配置到 JSON 格式
     * @returns {Object} 提供商池配置
     */
    exportToJson() {
        const providers = sqliteDB.getProviders();
        const result = {};

        for (const p of providers) {
            if (!result[p.providerType]) {
                result[p.providerType] = [];
            }
            result[p.providerType].push(p.config);
        }

        return result;
    }

    /**
     * 获取指定类型的所有提供商
     * @param {string} providerType - 提供商类型
     */
    getProviderPools(providerType) {
        const providers = sqliteDB.getProviders(providerType);
        return providers.map(p => p.config);
    }

    /**
     * 选择一个健康的提供商
     * @param {string} providerType - 提供商类型
     * @param {string} requestedModel - 请求的模型
     * @param {Object} options - 选项
     */
    selectProvider(providerType, requestedModel = null, options = {}) {
        if (!providerType || typeof providerType !== 'string') {
            this._log('error', `Invalid providerType: ${providerType}`);
            return null;
        }

        const healthyProviders = sqliteDB.getHealthyProviders(providerType, requestedModel);

        if (healthyProviders.length === 0) {
            this._log('warn', `No healthy providers for ${providerType}${requestedModel ? ` supporting ${requestedModel}` : ''}`);
            return null;
        }

        // 轮询选择
        const indexKey = requestedModel ? `${providerType}:${requestedModel}` : providerType;
        const currentIndex = this.roundRobinIndex[indexKey] || 0;
        const providerIndex = currentIndex % healthyProviders.length;
        const selected = healthyProviders[providerIndex];

        this.roundRobinIndex[indexKey] = (currentIndex + 1) % healthyProviders.length;

        // 更新使用统计
        if (!options.skipUsageCount) {
            sqliteDB.incrementUsage(selected.uuid);
        }

        this._log('debug', `Selected provider: ${selected.uuid} for ${providerType}${requestedModel ? ` (model: ${requestedModel})` : ''}`);
        return selected.config;
    }

    /**
     * 标记提供商为不健康
     */
    markProviderUnhealthy(providerType, providerConfig, errorOrMessage = null) {
        if (!providerConfig?.uuid) {
            this._log('error', 'Invalid providerConfig in markProviderUnhealthy');
            return;
        }

        const provider = sqliteDB.getProviderByUuid(providerConfig.uuid);
        if (!provider) return;

        let isRetryableError = false;
        let isFatalError = false;
        let errorMessage = null;

        if (typeof errorOrMessage === 'object' && errorOrMessage !== null) {
            isRetryableError = errorOrMessage.isRateLimitError === true || errorOrMessage.retryable === true;
            errorMessage = errorOrMessage.message || String(errorOrMessage);
        } else if (typeof errorOrMessage === 'string') {
            errorMessage = errorOrMessage;
            isRetryableError = errorMessage && (
                errorMessage.includes('RATE_LIMIT_EXCEEDED') ||
                errorMessage.includes('429') ||
                errorMessage.includes('Too Many Requests') ||
                errorMessage.includes('Rate Limit')
            );
        }

        // 检查致命错误
        if (errorMessage) {
            const msg = errorMessage.toLowerCase();
            isFatalError =
                (msg.includes('400') && msg.includes('token refresh')) ||
                msg.includes('402') ||
                msg.includes('403') ||
                msg.includes('forbidden') ||
                msg.includes('suspended') ||
                msg.includes('locked') ||
                msg.includes('quota') ||
                msg.includes('payment required') ||
                (msg.includes('401') && !msg.includes('rate')) ||
                msg.includes('token is expired') ||
                msg.includes('invalid token') ||
                msg.includes('unauthorized');
        }

        if (!isRetryableError) {
            const newErrorCount = provider.errorCount + 1;
            const isHealthy = !isFatalError && newErrorCount < this.maxErrorCount;

            sqliteDB.updateProviderHealth(providerConfig.uuid, isHealthy, {
                errorCount: newErrorCount,
                lastErrorTime: new Date().toISOString(),
                lastErrorMessage: errorMessage
            });

            // 记录健康检查历史
            sqliteDB.recordHealthCheck(providerConfig.uuid, providerType, false, null, errorMessage);

            if (!isHealthy) {
                this._log('warn', `Marked provider unhealthy: ${providerConfig.uuid} (${isFatalError ? 'fatal error' : 'error count exceeded'})`);
            }
        } else {
            this._log('info', `Retryable error for ${providerConfig.uuid}, not counting as fatal`);
        }
    }

    /**
     * 标记提供商为健康
     */
    markProviderHealthy(providerType, providerConfig, resetUsageCount = false, healthCheckModel = null, userInfo = null) {
        if (!providerConfig?.uuid) {
            this._log('error', 'Invalid providerConfig in markProviderHealthy');
            return;
        }

        const extra = {
            errorCount: 0,
            lastErrorTime: null,
            lastErrorMessage: null,
            lastHealthCheckTime: new Date().toISOString(),
            lastHealthCheckModel: healthCheckModel
        };

        if (userInfo?.email) {
            extra.cachedEmail = userInfo.email;
        }
        if (userInfo?.userId) {
            extra.cachedUserId = userInfo.userId;
        }

        sqliteDB.updateProviderHealth(providerConfig.uuid, true, extra);

        if (!resetUsageCount) {
            sqliteDB.incrementUsage(providerConfig.uuid);
        }

        // 记录健康检查历史
        sqliteDB.recordHealthCheck(providerConfig.uuid, providerType, true, healthCheckModel, null);

        this._log('info', `Marked provider healthy: ${providerConfig.uuid}`);
    }

    /**
     * 禁用提供商
     */
    disableProvider(providerType, providerConfig) {
        if (!providerConfig?.uuid) return;

        const stmt = sqliteDB.getDb().prepare(`
            UPDATE providers SET is_disabled = 1, updated_at = datetime('now') WHERE uuid = ?
        `);
        stmt.run(providerConfig.uuid);
        this._log('info', `Disabled provider: ${providerConfig.uuid}`);
    }

    /**
     * 启用提供商
     */
    enableProvider(providerType, providerConfig) {
        if (!providerConfig?.uuid) return;

        const stmt = sqliteDB.getDb().prepare(`
            UPDATE providers SET is_disabled = 0, updated_at = datetime('now') WHERE uuid = ?
        `);
        stmt.run(providerConfig.uuid);
        this._log('info', `Enabled provider: ${providerConfig.uuid}`);
    }

    /**
     * 重置提供商计数器
     */
    resetProviderCounters(providerType, providerConfig) {
        if (!providerConfig?.uuid) return;

        const stmt = sqliteDB.getDb().prepare(`
            UPDATE providers SET error_count = 0, usage_count = 0, updated_at = datetime('now') WHERE uuid = ?
        `);
        stmt.run(providerConfig.uuid);
        this._log('info', `Reset counters for: ${providerConfig.uuid}`);
    }

    /**
     * 并行执行健康检查
     */
    async performHealthChecks(isInit = false) {
        this._log('info', 'Performing health checks...');
        const now = new Date();

        // 获取所有需要检查的提供商
        const providers = sqliteDB.getProviders();
        const tasksToCheck = [];

        for (const provider of providers) {
            if (provider.isDisabled) continue;

            // 跳过最近出错的不健康提供商
            if (!provider.isHealthy && provider.lastErrorTime) {
                const timeSinceError = now.getTime() - new Date(provider.lastErrorTime).getTime();
                if (timeSinceError < this.healthCheckInterval) {
                    this._log('debug', `Skipping ${provider.uuid}: last error too recent`);
                    continue;
                }
            }

            tasksToCheck.push(provider);
        }

        // 并行执行健康检查（限制并发数）
        const results = await this._runWithConcurrency(
            tasksToCheck,
            async (provider) => {
                try {
                    const result = await this._checkProviderHealth(provider.providerType, provider.config);
                    return { provider, result };
                } catch (error) {
                    return { provider, result: { success: false, errorMessage: error.message } };
                }
            },
            this.healthCheckConcurrency
        );

        // 处理结果
        for (const { provider, result } of results) {
            if (result === null) {
                this.resetProviderCounters(provider.providerType, provider.config);
            } else if (result.success) {
                this.markProviderHealthy(provider.providerType, provider.config, true, result.modelName, result.userInfo);
            } else {
                this.markProviderUnhealthy(provider.providerType, provider.config, result.errorMessage);
            }
        }

        this._log('info', `Health checks completed: ${results.length} providers checked`);
    }

    /**
     * 执行单个提供商的健康检查
     * @private
     */
    async _checkProviderHealth(providerType, providerConfig, forceCheck = false) {
        const modelName = providerConfig.checkModelName ||
            SQLiteProviderPoolManager.DEFAULT_HEALTH_CHECK_MODELS[providerType];

        if (!providerConfig.checkHealth && !forceCheck) {
            return null;
        }

        if (!modelName) {
            return { success: false, modelName: null, errorMessage: 'Unknown provider type' };
        }

        const proxyKeys = ['KIRO'];
        const tempConfig = {
            ...providerConfig,
            MODEL_PROVIDER: providerType
        };

        proxyKeys.forEach(key => {
            const proxyKey = `USE_SYSTEM_PROXY_${key}`;
            if (this.globalConfig[proxyKey] !== undefined) {
                tempConfig[proxyKey] = this.globalConfig[proxyKey];
            }
        });

        const serviceAdapter = getServiceAdapter(tempConfig);

        try {
            await serviceAdapter.generateContent(modelName, {
                messages: [{ role: 'user', content: 'Hi' }],
                model: modelName,
                max_tokens: 1
            });

            // 获取用户信息
            let userInfo = null;
            try {
                if (typeof serviceAdapter.getUsageLimits === 'function') {
                    const usageData = await serviceAdapter.getUsageLimits();
                    if (usageData?.userInfo) {
                        userInfo = {
                            email: usageData.userInfo.email,
                            userId: usageData.userInfo.userId
                        };
                    }
                }
            } catch (e) {
                this._log('debug', `Failed to fetch user info: ${e.message}`);
            }

            return { success: true, modelName, errorMessage: null, userInfo };
        } catch (error) {
            return { success: false, modelName, errorMessage: error.message };
        }
    }

    /**
     * 限制并发数的批量执行
     * @private
     */
    async _runWithConcurrency(items, fn, concurrency) {
        const results = [];
        const executing = [];

        for (const item of items) {
            const promise = fn(item).then(result => {
                executing.splice(executing.indexOf(promise), 1);
                return result;
            });

            results.push(promise);
            executing.push(promise);

            if (executing.length >= concurrency) {
                await Promise.race(executing);
            }
        }

        return Promise.all(results);
    }

    /**
     * 获取提供商池统计信息
     */
    getPoolStats(providerType = null) {
        return sqliteDB.getPoolStats(providerType);
    }

    /**
     * 清理维护任务
     */
    async performMaintenance() {
        this._log('info', 'Performing maintenance tasks...');

        // 清理过期的用量缓存
        sqliteDB.cleanExpiredUsageCache();

        // 清理旧的健康检查历史
        sqliteDB.cleanOldHealthHistory(7);

        this._log('info', 'Maintenance completed');
    }

    /**
     * 同步数据回 JSON 文件（定期备份）
     * @param {string} filePath - JSON 文件路径
     */
    syncToJsonFile(filePath = 'provider_pools.json') {
        try {
            const data = this.exportToJson();
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
            this._log('info', `Synced data to ${filePath}`);
        } catch (error) {
            this._log('error', `Failed to sync to JSON: ${error.message}`);
        }
    }

    /**
     * 从 JSON 文件重新加载（热更新）
     * @param {Object} providerPools - 提供商池配置
     */
    reloadFromJson(providerPools) {
        this.importFromJson(providerPools);
        this._log('info', 'Reloaded providers from JSON');
    }

    // ==================== 用量缓存相关 ====================

    /**
     * 获取用量（带缓存）
     * @param {string} providerType - 提供商类型
     * @param {string} uuid - 提供商 UUID
     * @param {Function} fetchFn - 获取用量的函数
     */
    async getUsageWithCache(providerType, uuid, fetchFn) {
        // 先检查缓存
        const cached = sqliteDB.getUsageCache(uuid, providerType);
        if (cached) {
            this._log('debug', `Usage cache hit for ${uuid}`);
            return cached.usageData;
        }

        // 缓存未命中，获取新数据
        this._log('debug', `Usage cache miss for ${uuid}, fetching...`);
        const usageData = await fetchFn();

        // 存入缓存
        sqliteDB.setUsageCache(uuid, providerType, usageData, this.usageCacheTTL);

        return usageData;
    }

    /**
     * 批量获取用量（并行 + 缓存）
     * @param {string} providerType - 提供商类型
     * @param {Function} fetchFn - 获取单个用量的函数 (uuid) => Promise<usageData>
     */
    async batchGetUsage(providerType, fetchFn) {
        const providers = sqliteDB.getProviders(providerType);
        const cachedUsage = sqliteDB.getUsageCacheBatch(providerType);
        const results = [];

        // 分离已缓存和未缓存的提供商
        const needFetch = [];
        for (const provider of providers) {
            const cached = cachedUsage.get(provider.uuid);
            if (cached) {
                results.push({
                    uuid: provider.uuid,
                    usage: cached.usageData,
                    fromCache: true
                });
            } else {
                needFetch.push(provider);
            }
        }

        this._log('info', `Usage batch: ${results.length} cached, ${needFetch.length} need fetch`);

        // 并行获取未缓存的用量
        if (needFetch.length > 0) {
            const fetchResults = await this._runWithConcurrency(
                needFetch,
                async (provider) => {
                    try {
                        const usage = await fetchFn(provider.uuid);
                        // 存入缓存
                        sqliteDB.setUsageCache(provider.uuid, providerType, usage, this.usageCacheTTL);
                        return { uuid: provider.uuid, usage, fromCache: false };
                    } catch (error) {
                        return { uuid: provider.uuid, error: error.message };
                    }
                },
                this.usageQueryConcurrency
            );

            results.push(...fetchResults);
        }

        return results;
    }

    /**
     * 刷新用量缓存
     * @param {string} providerType - 提供商类型
     * @param {string} uuid - 提供商 UUID（可选，不传则刷新所有）
     */
    invalidateUsageCache(providerType, uuid = null) {
        if (uuid) {
            const stmt = sqliteDB.getDb().prepare(`
                DELETE FROM usage_cache WHERE provider_uuid = ? AND provider_type = ?
            `);
            stmt.run(uuid, providerType);
        } else {
            const stmt = sqliteDB.getDb().prepare(`
                DELETE FROM usage_cache WHERE provider_type = ?
            `);
            stmt.run(providerType);
        }
        this._log('info', `Invalidated usage cache for ${providerType}${uuid ? `:${uuid}` : ''}`);
    }
}

export default SQLiteProviderPoolManager;
