/**
 * Account Pool Manager - 账号池管理系统
 *
 * 三个池的设计：
 * 1. 健康池 (Healthy Pool): 正常可用的账号
 * 2. 检查池 (Checking Pool): 需要健康检查的账号
 * 3. 异常池 (Banned Pool): 被封禁或有严重问题的账号
 *
 * 状态转换流程：
 * 健康池 -> (出现错误) -> 检查池 -> (检查通过) -> 健康池
 *                                  -> (检查失败) -> 异常池
 * 异常池 -> (定期重试) -> 检查池 -> (检查通过) -> 健康池
 */

import { getRedisManager } from './redis-manager.js';
import fs from 'fs/promises';
import path from 'path';

// 错误类型分类
const ERROR_TYPES = {
    // 临时性错误（可恢复）
    TEMPORARY: {
        RATE_LIMIT: 429,           // 限流
        SERVER_ERROR: 500,         // 服务器错误
        TIMEOUT: 'TIMEOUT',        // 超时
        NETWORK: 'NETWORK'         // 网络错误
    },
    // 永久性错误（需要人工处理）
    PERMANENT: {
        SUSPENDED: 403,            // 账号被封禁
        INVALID_TOKEN: 401,        // Token 无效
        QUOTA_EXCEEDED: 402        // 配额用尽
    }
};

// 池状态
const POOL_STATUS = {
    HEALTHY: 'healthy',      // 健康池
    CHECKING: 'checking',    // 检查池
    BANNED: 'banned'         // 异常池
};

// 配置
const CONFIG = {
    // 错误阈值：连续失败多少次后移入检查池
    ERROR_THRESHOLD: 3,

    // 检查池重试间隔（毫秒）
    CHECKING_RETRY_INTERVAL: 5 * 60 * 1000,  // 5 分钟

    // 异常池重试间隔（毫秒）
    BANNED_RETRY_INTERVAL: 60 * 60 * 1000,   // 1 小时

    // 健康检查超时（毫秒）
    HEALTH_CHECK_TIMEOUT: 10000,             // 10 秒

    // 自动恢复检查间隔（毫秒）
    AUTO_RECOVERY_INTERVAL: 10 * 60 * 1000,  // 10 分钟

    // Redis 缓存 TTL
    CACHE_TTL: {
        POOL_STATUS: 300,        // 池状态缓存 5 分钟
        ERROR_COUNT: 600         // 错误计数缓存 10 分钟
    }
};

class AccountPoolManager {
    constructor(config = {}) {
        this.config = { ...CONFIG, ...config };
        this.redis = getRedisManager();

        // 内存中的池状态（用于快速访问）
        this.pools = {
            [POOL_STATUS.HEALTHY]: new Map(),   // providerId -> account info
            [POOL_STATUS.CHECKING]: new Map(),
            [POOL_STATUS.BANNED]: new Map()
        };

        // 错误计数器
        this.errorCounts = new Map();  // providerId -> count

        // 最后检查时间
        this.lastCheckTime = new Map();  // providerId -> timestamp

        // 缓存统计
        this.cacheStats = {
            hits: 0,
            misses: 0,
            total: 0
        };

        // 自动恢复定时器
        this.recoveryTimer = null;
    }

    /**
     * 初始化账号池管理器
     */
    async initialize(providers) {
        console.log('[AccountPool] Initializing account pool manager...');

        // 从 Redis 加载池状态
        await this._loadPoolStateFromRedis();

        // 如果 Redis 中没有数据，从 providers 初始化
        if (this.pools[POOL_STATUS.HEALTHY].size === 0) {
            for (const provider of providers) {
                this.pools[POOL_STATUS.HEALTHY].set(provider.id, {
                    id: provider.id,
                    type: provider.type,
                    config: provider.config,
                    addedAt: Date.now()
                });
            }
            await this._savePoolStateToRedis();
        }

        // 启动自动恢复检查
        this._startAutoRecovery();

        console.log(`[AccountPool] Initialized with ${this.pools[POOL_STATUS.HEALTHY].size} healthy accounts`);
        console.log(`[AccountPool] Checking pool: ${this.pools[POOL_STATUS.CHECKING].size} accounts`);
        console.log(`[AccountPool] Banned pool: ${this.pools[POOL_STATUS.BANNED].size} accounts`);
    }

    /**
     * 记录账号错误
     */
    async recordError(providerId, error) {
        const errorType = this._classifyError(error);
        const currentCount = this.errorCounts.get(providerId) || 0;
        const newCount = currentCount + 1;

        this.errorCounts.set(providerId, newCount);

        console.log(`[AccountPool] Error recorded for ${providerId}: ${errorType} (count: ${newCount})`);

        // 根据错误类型决定处理方式
        if (errorType === 'PERMANENT') {
            // 永久性错误：直接移入异常池
            await this._moveToPool(providerId, POOL_STATUS.BANNED, error);
            console.log(`[AccountPool] ⚠️ Account ${providerId} moved to BANNED pool (permanent error)`);
        } else if (newCount >= this.config.ERROR_THRESHOLD) {
            // 临时性错误但超过阈值：移入检查池
            await this._moveToPool(providerId, POOL_STATUS.CHECKING, error);
            console.log(`[AccountPool] ⚠️ Account ${providerId} moved to CHECKING pool (error threshold reached)`);
        }

        // 缓存错误计数到 Redis
        await this.redis.set(
            `account:error:${providerId}`,
            newCount,
            this.config.CACHE_TTL.ERROR_COUNT
        );
    }

    /**
     * 记录账号成功
     */
    async recordSuccess(providerId) {
        // 重置错误计数
        this.errorCounts.set(providerId, 0);
        await this.redis.delete(`account:error:${providerId}`);

        // 如果账号在检查池，移回健康池
        if (this.pools[POOL_STATUS.CHECKING].has(providerId)) {
            await this._moveToPool(providerId, POOL_STATUS.HEALTHY);
            console.log(`[AccountPool] ✅ Account ${providerId} recovered to HEALTHY pool`);
        }
    }

    /**
     * 获取可用账号（从健康池）
     */
    async getHealthyAccount(type) {
        const healthyAccounts = Array.from(this.pools[POOL_STATUS.HEALTHY].values())
            .filter(acc => acc.type === type);

        if (healthyAccounts.length === 0) {
            console.log(`[AccountPool] ⚠️ No healthy accounts available for type: ${type}`);
            return null;
        }

        // 简单的轮询策略（可以改进为更复杂的负载均衡）
        const account = healthyAccounts[Math.floor(Math.random() * healthyAccounts.length)];

        console.log(`[AccountPool] Selected healthy account: ${account.id} (${healthyAccounts.length} available)`);
        return account;
    }

    /**
     * 获取池状态统计
     */
    getPoolStats() {
        const stats = {
            healthy: this.pools[POOL_STATUS.HEALTHY].size,
            checking: this.pools[POOL_STATUS.CHECKING].size,
            banned: this.pools[POOL_STATUS.BANNED].size,
            total: this.pools[POOL_STATUS.HEALTHY].size +
                   this.pools[POOL_STATUS.CHECKING].size +
                   this.pools[POOL_STATUS.BANNED].size,
            cacheHitRate: this.cacheStats.total > 0
                ? (this.cacheStats.hits / this.cacheStats.total * 100).toFixed(2) + '%'
                : '0%',
            cacheStats: { ...this.cacheStats }
        };

        return stats;
    }

    /**
     * 获取详细的池信息
     */
    getPoolDetails() {
        const details = {};

        for (const [status, pool] of Object.entries(this.pools)) {
            details[status] = Array.from(pool.values()).map(acc => ({
                id: acc.id,
                type: acc.type,
                addedAt: acc.addedAt,
                lastError: acc.lastError,
                errorCount: this.errorCounts.get(acc.id) || 0,
                lastCheckTime: this.lastCheckTime.get(acc.id)
            }));
        }

        return details;
    }

    /**
     * 分类错误类型
     */
    _classifyError(error) {
        const status = error.response?.status;
        const message = error.message?.toLowerCase() || '';

        // 检查永久性错误
        if (status === ERROR_TYPES.PERMANENT.SUSPENDED) {
            if (message.includes('suspended') || message.includes('locked')) {
                return 'PERMANENT';
            }
        }

        if (status === ERROR_TYPES.PERMANENT.QUOTA_EXCEEDED) {
            if (message.includes('limit') || message.includes('quota')) {
                return 'PERMANENT';
            }
        }

        if (status === ERROR_TYPES.PERMANENT.INVALID_TOKEN) {
            return 'PERMANENT';
        }

        // 其他都视为临时性错误
        return 'TEMPORARY';
    }

    /**
     * 移动账号到指定池
     */
    async _moveToPool(providerId, targetStatus, error = null) {
        let account = null;

        // 从所有池中查找并移除
        for (const pool of Object.values(this.pools)) {
            if (pool.has(providerId)) {
                account = pool.get(providerId);
                pool.delete(providerId);
                break;
            }
        }

        if (!account) {
            console.warn(`[AccountPool] Account ${providerId} not found in any pool`);
            return;
        }

        // 更新账号信息
        account.lastError = error ? {
            message: error.message,
            status: error.response?.status,
            time: Date.now()
        } : null;

        // 添加到目标池
        this.pools[targetStatus].set(providerId, account);
        this.lastCheckTime.set(providerId, Date.now());

        // 保存到 Redis
        await this._savePoolStateToRedis();

        // 缓存池状态
        await this.redis.set(
            `account:pool:${providerId}`,
            targetStatus,
            this.config.CACHE_TTL.POOL_STATUS
        );
    }

    /**
     * 健康检查（用于检查池和异常池的账号恢复）
     */
    async _performHealthCheck(providerId, account) {
        console.log(`[AccountPool] Performing health check for ${providerId}...`);

        try {
            // 这里需要调用实际的健康检查逻辑
            // 暂时返回 true，实际应该调用 provider 的健康检查方法
            // TODO: 集成实际的健康检查逻辑

            return true;
        } catch (error) {
            console.error(`[AccountPool] Health check failed for ${providerId}:`, error.message);
            return false;
        }
    }

    /**
     * 自动恢复检查
     */
    async _autoRecoveryCheck() {
        const now = Date.now();

        // 检查"检查池"中的账号
        for (const [providerId, account] of this.pools[POOL_STATUS.CHECKING].entries()) {
            const lastCheck = this.lastCheckTime.get(providerId) || 0;

            if (now - lastCheck >= this.config.CHECKING_RETRY_INTERVAL) {
                console.log(`[AccountPool] Auto-recovery check for ${providerId} (checking pool)`);

                const isHealthy = await this._performHealthCheck(providerId, account);

                if (isHealthy) {
                    await this._moveToPool(providerId, POOL_STATUS.HEALTHY);
                    console.log(`[AccountPool] ✅ Account ${providerId} recovered to healthy pool`);
                } else {
                    // 检查失败，移入异常池
                    await this._moveToPool(providerId, POOL_STATUS.BANNED);
                    console.log(`[AccountPool] ❌ Account ${providerId} moved to banned pool`);
                }
            }
        }

        // 检查"异常池"中的账号（更长的重试间隔）
        for (const [providerId, account] of this.pools[POOL_STATUS.BANNED].entries()) {
            const lastCheck = this.lastCheckTime.get(providerId) || 0;

            if (now - lastCheck >= this.config.BANNED_RETRY_INTERVAL) {
                console.log(`[AccountPool] Auto-recovery check for ${providerId} (banned pool)`);

                const isHealthy = await this._performHealthCheck(providerId, account);

                if (isHealthy) {
                    await this._moveToPool(providerId, POOL_STATUS.HEALTHY);
                    console.log(`[AccountPool] ✅ Account ${providerId} recovered from banned pool!`);
                } else {
                    // 更新最后检查时间，继续留在异常池
                    this.lastCheckTime.set(providerId, now);
                }
            }
        }
    }

    /**
     * 启动自动恢复定时器
     */
    _startAutoRecovery() {
        if (this.recoveryTimer) {
            clearInterval(this.recoveryTimer);
        }

        this.recoveryTimer = setInterval(
            () => this._autoRecoveryCheck(),
            this.config.AUTO_RECOVERY_INTERVAL
        );

        console.log(`[AccountPool] Auto-recovery started (interval: ${this.config.AUTO_RECOVERY_INTERVAL / 1000}s)`);
    }

    /**
     * 从 Redis 加载池状态
     */
    async _loadPoolStateFromRedis() {
        if (!this.redis.isAvailable()) {
            console.log('[AccountPool] Redis not available, skipping state load');
            return;
        }

        try {
            const poolState = await this.redis.get('account:pool:state');

            if (poolState) {
                // 恢复池状态
                for (const [status, accounts] of Object.entries(poolState.pools)) {
                    this.pools[status] = new Map(accounts);
                }

                // 恢复错误计数
                if (poolState.errorCounts) {
                    this.errorCounts = new Map(poolState.errorCounts);
                }

                // 恢复最后检查时间
                if (poolState.lastCheckTime) {
                    this.lastCheckTime = new Map(poolState.lastCheckTime);
                }

                console.log('[AccountPool] Pool state loaded from Redis');
                this.cacheStats.hits++;
            } else {
                console.log('[AccountPool] No pool state found in Redis');
                this.cacheStats.misses++;
            }

            this.cacheStats.total++;
        } catch (error) {
            console.error('[AccountPool] Failed to load pool state from Redis:', error.message);
            this.cacheStats.misses++;
            this.cacheStats.total++;
        }
    }

    /**
     * 保存池状态到 Redis
     */
    async _savePoolStateToRedis() {
        if (!this.redis.isAvailable()) {
            return;
        }

        try {
            const poolState = {
                pools: {},
                errorCounts: Array.from(this.errorCounts.entries()),
                lastCheckTime: Array.from(this.lastCheckTime.entries()),
                updatedAt: Date.now()
            };

            // 转换 Map 为数组以便序列化
            for (const [status, pool] of Object.entries(this.pools)) {
                poolState.pools[status] = Array.from(pool.entries());
            }

            await this.redis.set('account:pool:state', poolState, 3600); // 1 小时 TTL

            console.log('[AccountPool] Pool state saved to Redis');
        } catch (error) {
            console.error('[AccountPool] Failed to save pool state to Redis:', error.message);
        }
    }

    /**
     * 停止自动恢复
     */
    stop() {
        if (this.recoveryTimer) {
            clearInterval(this.recoveryTimer);
            this.recoveryTimer = null;
            console.log('[AccountPool] Auto-recovery stopped');
        }
    }
}

// 导出单例
let accountPoolManagerInstance = null;

export function getAccountPoolManager(config = {}) {
    if (!accountPoolManagerInstance) {
        accountPoolManagerInstance = new AccountPoolManager(config);
    }
    return accountPoolManagerInstance;
}

export default AccountPoolManager;
export { POOL_STATUS, ERROR_TYPES };
