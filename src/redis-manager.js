/**
 * Redis Manager - 统一的 Redis 缓存管理
 * 提供 Token 缓存、会话缓存、健康检查缓存等功能
 */

import { createClient } from 'redis';

class RedisManager {
    constructor(config = {}) {
        this.config = {
            host: config.host || process.env.REDIS_HOST || 'localhost',
            port: config.port || process.env.REDIS_PORT || 6379,
            password: config.password || process.env.REDIS_PASSWORD || undefined,
            db: config.db || process.env.REDIS_DB || 0,
            enabled: config.enabled !== false && process.env.REDIS_ENABLED !== 'false',
            keyPrefix: config.keyPrefix || 'kiro2api:',
            // 默认 TTL（秒）
            defaultTTL: {
                token: 3600,           // Token 缓存 1 小时
                providerHealth: 300,   // Provider 健康状态 5 分钟
                conversation: 1800,    // 会话历史 30 分钟
                requestCache: 60       // 请求缓存 1 分钟
            }
        };

        this.client = null;
        this.isConnected = false;
        this.isConnecting = false;

        // 缓存统计
        this.stats = {
            hits: 0,
            misses: 0,
            sets: 0,
            deletes: 0,
            errors: 0
        };
    }

    /**
     * 初始化 Redis 连接
     */
    async initialize() {
        if (!this.config.enabled) {
            console.log('[Redis] Redis caching is disabled');
            return false;
        }

        if (this.isConnected) {
            return true;
        }

        if (this.isConnecting) {
            // 等待连接完成
            await new Promise(resolve => setTimeout(resolve, 100));
            return this.isConnected;
        }

        this.isConnecting = true;

        try {
            const redisConfig = {
                socket: {
                    host: this.config.host,
                    port: this.config.port,
                    reconnectStrategy: (retries) => {
                        if (retries > 10) {
                            console.error('[Redis] Max reconnection attempts reached');
                            return new Error('Max reconnection attempts reached');
                        }
                        return Math.min(retries * 100, 3000);
                    }
                },
                database: this.config.db
            };

            if (this.config.password) {
                redisConfig.password = this.config.password;
            }

            this.client = createClient(redisConfig);

            this.client.on('error', (err) => {
                console.error('[Redis] Connection error:', err.message);
                this.isConnected = false;
            });

            this.client.on('connect', () => {
                console.log('[Redis] Connecting...');
            });

            this.client.on('ready', () => {
                console.log('[Redis] Connected successfully');
                this.isConnected = true;
            });

            this.client.on('reconnecting', () => {
                console.log('[Redis] Reconnecting...');
            });

            await this.client.connect();
            this.isConnecting = false;
            return true;

        } catch (error) {
            console.error('[Redis] Failed to initialize:', error.message);
            this.isConnected = false;
            this.isConnecting = false;
            return false;
        }
    }

    /**
     * 生成带前缀的 key
     */
    _key(key) {
        return `${this.config.keyPrefix}${key}`;
    }

    /**
     * 检查 Redis 是否可用
     */
    isAvailable() {
        return this.config.enabled && this.isConnected && this.client;
    }

    // ==================== Token 缓存 ====================

    /**
     * 缓存 Token
     */
    async cacheToken(providerId, tokenData, ttl = null) {
        if (!this.isAvailable()) return false;

        try {
            const key = this._key(`token:${providerId}`);
            const value = JSON.stringify(tokenData);
            const expiry = ttl || this.config.defaultTTL.token;

            await this.client.setEx(key, expiry, value);
            console.log(`[Redis] Cached token for provider: ${providerId}`);
            this.stats.sets++;
            return true;
        } catch (error) {
            console.error('[Redis] Failed to cache token:', error.message);
            this.stats.errors++;
            return false;
        }
    }

    /**
     * 获取缓存的 Token
     */
    async getToken(providerId) {
        if (!this.isAvailable()) return null;

        try {
            const key = this._key(`token:${providerId}`);
            const value = await this.client.get(key);

            if (value) {
                console.log(`[Redis] Token cache hit for provider: ${providerId}`);
                this.stats.hits++;
                return JSON.parse(value);
            }

            console.log(`[Redis] Token cache miss for provider: ${providerId}`);
            this.stats.misses++;
            return null;
        } catch (error) {
            console.error('[Redis] Failed to get token:', error.message);
            this.stats.errors++;
            return null;
        }
    }

    /**
     * 删除 Token 缓存
     */
    async deleteToken(providerId) {
        if (!this.isAvailable()) return false;

        try {
            const key = this._key(`token:${providerId}`);
            await this.client.del(key);
            console.log(`[Redis] Deleted token cache for provider: ${providerId}`);
            return true;
        } catch (error) {
            console.error('[Redis] Failed to delete token:', error.message);
            return false;
        }
    }

    // ==================== Provider 健康状态缓存 ====================

    /**
     * 缓存 Provider 健康状态
     */
    async cacheProviderHealth(providerId, isHealthy, ttl = null) {
        if (!this.isAvailable()) return false;

        try {
            const key = this._key(`provider:health:${providerId}`);
            const value = isHealthy ? 'healthy' : 'unhealthy';
            const expiry = ttl || this.config.defaultTTL.providerHealth;

            await this.client.setEx(key, expiry, value);
            return true;
        } catch (error) {
            console.error('[Redis] Failed to cache provider health:', error.message);
            return false;
        }
    }

    /**
     * 获取 Provider 健康状态
     */
    async getProviderHealth(providerId) {
        if (!this.isAvailable()) return null;

        try {
            const key = this._key(`provider:health:${providerId}`);
            const value = await this.client.get(key);

            if (value) {
                console.log(`[Redis] Provider health cache hit: ${providerId} = ${value}`);
                return value === 'healthy';
            }

            return null;
        } catch (error) {
            console.error('[Redis] Failed to get provider health:', error.message);
            return null;
        }
    }

    // ==================== 会话历史缓存 ====================

    /**
     * 缓存会话历史
     */
    async cacheConversation(conversationId, messages, ttl = null) {
        if (!this.isAvailable()) return false;

        try {
            const key = this._key(`conversation:${conversationId}`);
            const value = JSON.stringify(messages);
            const expiry = ttl || this.config.defaultTTL.conversation;

            await this.client.setEx(key, expiry, value);
            return true;
        } catch (error) {
            console.error('[Redis] Failed to cache conversation:', error.message);
            return false;
        }
    }

    /**
     * 获取会话历史
     */
    async getConversation(conversationId) {
        if (!this.isAvailable()) return null;

        try {
            const key = this._key(`conversation:${conversationId}`);
            const value = await this.client.get(key);

            if (value) {
                console.log(`[Redis] Conversation cache hit: ${conversationId}`);
                return JSON.parse(value);
            }

            return null;
        } catch (error) {
            console.error('[Redis] Failed to get conversation:', error.message);
            return null;
        }
    }

    // ==================== 请求去重和缓存 ====================

    /**
     * 缓存请求结果（用于去重）
     */
    async cacheRequest(requestHash, result, ttl = null) {
        if (!this.isAvailable()) return false;

        try {
            const key = this._key(`request:${requestHash}`);
            const value = JSON.stringify(result);
            const expiry = ttl || this.config.defaultTTL.requestCache;

            await this.client.setEx(key, expiry, value);
            return true;
        } catch (error) {
            console.error('[Redis] Failed to cache request:', error.message);
            return false;
        }
    }

    /**
     * 获取缓存的请求结果
     */
    async getRequest(requestHash) {
        if (!this.isAvailable()) return null;

        try {
            const key = this._key(`request:${requestHash}`);
            const value = await this.client.get(key);

            if (value) {
                console.log(`[Redis] Request cache hit: ${requestHash}`);
                return JSON.parse(value);
            }

            return null;
        } catch (error) {
            console.error('[Redis] Failed to get request:', error.message);
            return null;
        }
    }

    // ==================== 限流 ====================

    /**
     * 检查限流（简单的计数器实现）
     */
    async checkRateLimit(identifier, limit, windowSeconds) {
        if (!this.isAvailable()) return { allowed: true, remaining: limit };

        try {
            const key = this._key(`ratelimit:${identifier}`);
            const current = await this.client.incr(key);

            if (current === 1) {
                // 第一次请求，设置过期时间
                await this.client.expire(key, windowSeconds);
            }

            const allowed = current <= limit;
            const remaining = Math.max(0, limit - current);

            if (!allowed) {
                console.log(`[Redis] Rate limit exceeded for: ${identifier}`);
            }

            return { allowed, remaining, current };
        } catch (error) {
            console.error('[Redis] Failed to check rate limit:', error.message);
            return { allowed: true, remaining: limit };
        }
    }

    // ==================== 通用操作 ====================

    /**
     * 设置任意 key-value
     */
    async set(key, value, ttl = null) {
        if (!this.isAvailable()) return false;

        try {
            const fullKey = this._key(key);
            const stringValue = typeof value === 'string' ? value : JSON.stringify(value);

            if (ttl) {
                await this.client.setEx(fullKey, ttl, stringValue);
            } else {
                await this.client.set(fullKey, stringValue);
            }

            return true;
        } catch (error) {
            console.error('[Redis] Failed to set key:', error.message);
            return false;
        }
    }

    /**
     * 获取任意 key 的值
     */
    async get(key) {
        if (!this.isAvailable()) return null;

        try {
            const fullKey = this._key(key);
            const value = await this.client.get(fullKey);

            if (value) {
                try {
                    return JSON.parse(value);
                } catch {
                    return value;
                }
            }

            return null;
        } catch (error) {
            console.error('[Redis] Failed to get key:', error.message);
            return null;
        }
    }

    /**
     * 删除 key
     */
    async delete(key) {
        if (!this.isAvailable()) return false;

        try {
            const fullKey = this._key(key);
            await this.client.del(fullKey);
            return true;
        } catch (error) {
            console.error('[Redis] Failed to delete key:', error.message);
            return false;
        }
    }

    /**
     * 清空所有缓存（谨慎使用）
     */
    async flushAll() {
        if (!this.isAvailable()) return false;

        try {
            await this.client.flushDb();
            console.log('[Redis] Flushed all cache');
            return true;
        } catch (error) {
            console.error('[Redis] Failed to flush cache:', error.message);
            return false;
        }
    }

    /**
     * 关闭连接
     */
    async close() {
        if (this.client && this.isConnected) {
            try {
                await this.client.quit();
                console.log('[Redis] Connection closed');
                this.isConnected = false;
            } catch (error) {
                console.error('[Redis] Failed to close connection:', error.message);
            }
        }
    }

    /**
     * 获取统计信息
     */
    async getStats() {
        if (!this.isAvailable()) {
            return {
                enabled: false,
                connected: false
            };
        }

        try {
            const info = await this.client.info('stats');
            const dbSize = await this.client.dbSize();

            // 计算缓存命中率
            const total = this.stats.hits + this.stats.misses;
            const hitRate = total > 0 ? (this.stats.hits / total * 100).toFixed(2) : '0.00';

            return {
                enabled: true,
                connected: this.isConnected,
                host: this.config.host,
                port: this.config.port,
                db: this.config.db,
                keyCount: dbSize,
                cacheStats: {
                    hits: this.stats.hits,
                    misses: this.stats.misses,
                    sets: this.stats.sets,
                    deletes: this.stats.deletes,
                    errors: this.stats.errors,
                    total: total,
                    hitRate: hitRate + '%'
                },
                info: info
            };
        } catch (error) {
            console.error('[Redis] Failed to get stats:', error.message);
            return {
                enabled: true,
                connected: false,
                error: error.message,
                cacheStats: {
                    hits: this.stats.hits,
                    misses: this.stats.misses,
                    sets: this.stats.sets,
                    deletes: this.stats.deletes,
                    errors: this.stats.errors,
                    total: this.stats.hits + this.stats.misses,
                    hitRate: '0.00%'
                }
            };
        }
    }
}

// 导出单例
let redisManagerInstance = null;

export function getRedisManager(config = {}) {
    if (!redisManagerInstance) {
        redisManagerInstance = new RedisManager(config);
    }
    return redisManagerInstance;
}

export default RedisManager;
