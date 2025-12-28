/**
 * SQLite 数据库管理器
 * 用于提供商池和用量缓存的持久化存储
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

class SQLiteDB {
    constructor() {
        this.db = null;
        this.dbPath = null;
    }

    /**
     * 初始化数据库
     * @param {string} dbPath - 数据库文件路径
     */
    init(dbPath = 'data/provider_pool.db') {
        if (this.db) {
            return this.db;
        }

        this.dbPath = dbPath;

        // 确保目录存在
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        this.db = new Database(dbPath);

        // 启用 WAL 模式提高并发性能
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');

        // 创建表
        this._createTables();

        console.log(`[SQLiteDB] Database initialized: ${dbPath}`);
        return this.db;
    }

    /**
     * 创建数据表
     * @private
     */
    _createTables() {
        // 提供商表
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS providers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                uuid TEXT UNIQUE NOT NULL,
                provider_type TEXT NOT NULL,
                config TEXT NOT NULL,
                is_healthy INTEGER DEFAULT 1,
                is_disabled INTEGER DEFAULT 0,
                error_count INTEGER DEFAULT 0,
                usage_count INTEGER DEFAULT 0,
                last_used TEXT,
                last_error_time TEXT,
                last_error_message TEXT,
                last_health_check_time TEXT,
                last_health_check_model TEXT,
                cached_email TEXT,
                cached_user_id TEXT,
                not_supported_models TEXT,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            )
        `);

        // 用量缓存表
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS usage_cache (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                provider_uuid TEXT NOT NULL,
                provider_type TEXT NOT NULL,
                usage_data TEXT NOT NULL,
                cached_at TEXT DEFAULT (datetime('now')),
                expires_at TEXT NOT NULL,
                UNIQUE(provider_uuid, provider_type)
            )
        `);

        // 健康检查历史表（可选，用于分析）
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS health_check_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                provider_uuid TEXT NOT NULL,
                provider_type TEXT NOT NULL,
                is_healthy INTEGER NOT NULL,
                check_model TEXT,
                error_message TEXT,
                check_time TEXT DEFAULT (datetime('now'))
            )
        `);

        // 创建索引
        this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_providers_type ON providers(provider_type);
            CREATE INDEX IF NOT EXISTS idx_providers_healthy ON providers(is_healthy, is_disabled);
            CREATE INDEX IF NOT EXISTS idx_usage_cache_expires ON usage_cache(expires_at);
            CREATE INDEX IF NOT EXISTS idx_health_history_uuid ON health_check_history(provider_uuid);
        `);
    }

    /**
     * 获取数据库实例
     */
    getDb() {
        if (!this.db) {
            throw new Error('Database not initialized. Call init() first.');
        }
        return this.db;
    }

    /**
     * 关闭数据库连接
     */
    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
            console.log('[SQLiteDB] Database connection closed');
        }
    }

    // ==================== 提供商相关操作 ====================

    /**
     * 插入或更新提供商
     * @param {Object} provider - 提供商配置
     */
    upsertProvider(provider) {
        const db = this.getDb();
        const stmt = db.prepare(`
            INSERT INTO providers (
                uuid, provider_type, config, is_healthy, is_disabled,
                error_count, usage_count, last_used, last_error_time,
                last_error_message, last_health_check_time, last_health_check_model,
                cached_email, cached_user_id, not_supported_models, updated_at
            ) VALUES (
                @uuid, @provider_type, @config, @is_healthy, @is_disabled,
                @error_count, @usage_count, @last_used, @last_error_time,
                @last_error_message, @last_health_check_time, @last_health_check_model,
                @cached_email, @cached_user_id, @not_supported_models, datetime('now')
            )
            ON CONFLICT(uuid) DO UPDATE SET
                provider_type = @provider_type,
                config = @config,
                is_healthy = @is_healthy,
                is_disabled = @is_disabled,
                error_count = @error_count,
                usage_count = @usage_count,
                last_used = @last_used,
                last_error_time = @last_error_time,
                last_error_message = @last_error_message,
                last_health_check_time = @last_health_check_time,
                last_health_check_model = @last_health_check_model,
                cached_email = @cached_email,
                cached_user_id = @cached_user_id,
                not_supported_models = @not_supported_models,
                updated_at = datetime('now')
        `);

        return stmt.run({
            uuid: provider.uuid,
            provider_type: provider.providerType || provider.provider_type,
            config: JSON.stringify(provider.config || provider),
            is_healthy: provider.isHealthy !== false ? 1 : 0,
            is_disabled: provider.isDisabled ? 1 : 0,
            error_count: provider.errorCount || 0,
            usage_count: provider.usageCount || 0,
            last_used: provider.lastUsed || null,
            last_error_time: provider.lastErrorTime || null,
            last_error_message: provider.lastErrorMessage || null,
            last_health_check_time: provider.lastHealthCheckTime || null,
            last_health_check_model: provider.lastHealthCheckModel || null,
            cached_email: provider.cachedEmail || null,
            cached_user_id: provider.cachedUserId || null,
            not_supported_models: provider.notSupportedModels ? JSON.stringify(provider.notSupportedModels) : null
        });
    }

    /**
     * 批量插入或更新提供商
     * @param {Array} providers - 提供商配置数组
     * @param {string} providerType - 提供商类型
     */
    upsertProviders(providers, providerType) {
        const db = this.getDb();
        const upsert = db.transaction((items) => {
            for (const provider of items) {
                this.upsertProvider({
                    ...provider,
                    providerType
                });
            }
        });
        return upsert(providers);
    }

    /**
     * 获取所有提供商
     * @param {string} providerType - 可选，过滤提供商类型
     */
    getProviders(providerType = null) {
        const db = this.getDb();
        let stmt;
        if (providerType) {
            stmt = db.prepare('SELECT * FROM providers WHERE provider_type = ?');
            return stmt.all(providerType).map(this._parseProviderRow);
        } else {
            stmt = db.prepare('SELECT * FROM providers');
            return stmt.all().map(this._parseProviderRow);
        }
    }

    /**
     * 获取健康的提供商
     * @param {string} providerType - 提供商类型
     * @param {string} model - 可选，过滤支持的模型
     */
    getHealthyProviders(providerType, model = null) {
        const db = this.getDb();
        let providers;
        if (model) {
            // SQLite 没有 json_array_contains，使用 JavaScript 过滤
            const allHealthy = db.prepare(`
                SELECT * FROM providers
                WHERE provider_type = ?
                AND is_healthy = 1
                AND is_disabled = 0
            `).all(providerType);

            providers = allHealthy.filter(p => {
                if (!p.not_supported_models) return true;
                try {
                    const notSupported = JSON.parse(p.not_supported_models);
                    return !notSupported.includes(model);
                } catch {
                    return true;
                }
            });
        } else {
            const stmt = db.prepare(`
                SELECT * FROM providers
                WHERE provider_type = ?
                AND is_healthy = 1
                AND is_disabled = 0
            `);
            providers = stmt.all(providerType);
        }
        return providers.map(this._parseProviderRow);
    }

    /**
     * 通过 UUID 获取提供商
     * @param {string} uuid - 提供商 UUID
     */
    getProviderByUuid(uuid) {
        const db = this.getDb();
        const stmt = db.prepare('SELECT * FROM providers WHERE uuid = ?');
        const row = stmt.get(uuid);
        return row ? this._parseProviderRow(row) : null;
    }

    /**
     * 更新提供商健康状态
     * @param {string} uuid - 提供商 UUID
     * @param {boolean} isHealthy - 是否健康
     * @param {Object} extra - 额外更新字段
     */
    updateProviderHealth(uuid, isHealthy, extra = {}) {
        const db = this.getDb();
        const fields = ['is_healthy = ?', "updated_at = datetime('now')"];
        const values = [isHealthy ? 1 : 0];

        if (extra.errorCount !== undefined) {
            fields.push('error_count = ?');
            values.push(extra.errorCount);
        }
        if (extra.lastErrorTime !== undefined) {
            fields.push('last_error_time = ?');
            values.push(extra.lastErrorTime);
        }
        if (extra.lastErrorMessage !== undefined) {
            fields.push('last_error_message = ?');
            values.push(extra.lastErrorMessage);
        }
        if (extra.lastHealthCheckTime !== undefined) {
            fields.push('last_health_check_time = ?');
            values.push(extra.lastHealthCheckTime);
        }
        if (extra.lastHealthCheckModel !== undefined) {
            fields.push('last_health_check_model = ?');
            values.push(extra.lastHealthCheckModel);
        }
        if (extra.cachedEmail !== undefined) {
            fields.push('cached_email = ?');
            values.push(extra.cachedEmail);
        }
        if (extra.cachedUserId !== undefined) {
            fields.push('cached_user_id = ?');
            values.push(extra.cachedUserId);
        }

        values.push(uuid);
        const stmt = db.prepare(`UPDATE providers SET ${fields.join(', ')} WHERE uuid = ?`);
        return stmt.run(...values);
    }

    /**
     * 更新提供商使用统计
     * @param {string} uuid - 提供商 UUID
     */
    incrementUsage(uuid) {
        const db = this.getDb();
        const stmt = db.prepare(`
            UPDATE providers
            SET usage_count = usage_count + 1,
                last_used = datetime('now'),
                updated_at = datetime('now')
            WHERE uuid = ?
        `);
        return stmt.run(uuid);
    }

    /**
     * 删除提供商
     * @param {string} uuid - 提供商 UUID
     */
    deleteProvider(uuid) {
        const db = this.getDb();
        const stmt = db.prepare('DELETE FROM providers WHERE uuid = ?');
        return stmt.run(uuid);
    }

    /**
     * 解析提供商行数据
     * @private
     */
    _parseProviderRow(row) {
        let config = {};
        try {
            config = JSON.parse(row.config);
        } catch (e) {
            console.error('[SQLiteDB] Failed to parse provider config:', e);
        }

        let notSupportedModels = null;
        if (row.not_supported_models) {
            try {
                notSupportedModels = JSON.parse(row.not_supported_models);
            } catch (e) {}
        }

        return {
            uuid: row.uuid,
            providerType: row.provider_type,
            config: {
                ...config,
                uuid: row.uuid,
                isHealthy: row.is_healthy === 1,
                isDisabled: row.is_disabled === 1,
                errorCount: row.error_count,
                usageCount: row.usage_count,
                lastUsed: row.last_used,
                lastErrorTime: row.last_error_time,
                lastErrorMessage: row.last_error_message,
                lastHealthCheckTime: row.last_health_check_time,
                lastHealthCheckModel: row.last_health_check_model,
                cachedEmail: row.cached_email,
                cachedUserId: row.cached_user_id,
                notSupportedModels
            },
            isHealthy: row.is_healthy === 1,
            isDisabled: row.is_disabled === 1,
            errorCount: row.error_count,
            usageCount: row.usage_count,
            lastUsed: row.last_used,
            lastErrorTime: row.last_error_time,
            lastErrorMessage: row.last_error_message,
            lastHealthCheckTime: row.last_health_check_time,
            lastHealthCheckModel: row.last_health_check_model,
            cachedEmail: row.cached_email,
            cachedUserId: row.cached_user_id,
            notSupportedModels,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        };
    }

    // ==================== 用量缓存相关操作 ====================

    /**
     * 设置用量缓存
     * @param {string} uuid - 提供商 UUID
     * @param {string} providerType - 提供商类型
     * @param {Object} usageData - 用量数据
     * @param {number} ttlSeconds - 缓存有效期（秒），默认 5 分钟
     */
    setUsageCache(uuid, providerType, usageData, ttlSeconds = 300) {
        const db = this.getDb();
        const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
        const stmt = db.prepare(`
            INSERT INTO usage_cache (provider_uuid, provider_type, usage_data, expires_at, cached_at)
            VALUES (?, ?, ?, ?, datetime('now'))
            ON CONFLICT(provider_uuid, provider_type) DO UPDATE SET
                usage_data = excluded.usage_data,
                expires_at = excluded.expires_at,
                cached_at = datetime('now')
        `);
        return stmt.run(uuid, providerType, JSON.stringify(usageData), expiresAt);
    }

    /**
     * 获取用量缓存
     * @param {string} uuid - 提供商 UUID
     * @param {string} providerType - 提供商类型
     * @returns {Object|null} 缓存的用量数据，如果过期或不存在则返回 null
     */
    getUsageCache(uuid, providerType) {
        const db = this.getDb();
        const stmt = db.prepare(`
            SELECT * FROM usage_cache
            WHERE provider_uuid = ?
            AND provider_type = ?
            AND expires_at > datetime('now')
        `);
        const row = stmt.get(uuid, providerType);
        if (!row) return null;

        try {
            return {
                usageData: JSON.parse(row.usage_data),
                cachedAt: row.cached_at,
                expiresAt: row.expires_at
            };
        } catch (e) {
            return null;
        }
    }

    /**
     * 批量获取用量缓存
     * @param {string} providerType - 提供商类型
     * @returns {Map} UUID -> 用量数据的映射
     */
    getUsageCacheBatch(providerType) {
        const db = this.getDb();
        const stmt = db.prepare(`
            SELECT * FROM usage_cache
            WHERE provider_type = ?
            AND expires_at > datetime('now')
        `);
        const rows = stmt.all(providerType);
        const cache = new Map();

        for (const row of rows) {
            try {
                cache.set(row.provider_uuid, {
                    usageData: JSON.parse(row.usage_data),
                    cachedAt: row.cached_at,
                    expiresAt: row.expires_at
                });
            } catch (e) {}
        }

        return cache;
    }

    /**
     * 清理过期的用量缓存
     */
    cleanExpiredUsageCache() {
        const db = this.getDb();
        const stmt = db.prepare(`DELETE FROM usage_cache WHERE expires_at <= datetime('now')`);
        const result = stmt.run();
        if (result.changes > 0) {
            console.log(`[SQLiteDB] Cleaned ${result.changes} expired usage cache entries`);
        }
        return result;
    }

    /**
     * 清空所有用量缓存
     */
    clearAllUsageCache() {
        const db = this.getDb();
        const stmt = db.prepare('DELETE FROM usage_cache');
        return stmt.run();
    }

    // ==================== 健康检查历史 ====================

    /**
     * 记录健康检查结果
     * @param {string} uuid - 提供商 UUID
     * @param {string} providerType - 提供商类型
     * @param {boolean} isHealthy - 是否健康
     * @param {string} checkModel - 检查使用的模型
     * @param {string} errorMessage - 错误信息
     */
    recordHealthCheck(uuid, providerType, isHealthy, checkModel = null, errorMessage = null) {
        const db = this.getDb();
        const stmt = db.prepare(`
            INSERT INTO health_check_history (provider_uuid, provider_type, is_healthy, check_model, error_message)
            VALUES (?, ?, ?, ?, ?)
        `);
        return stmt.run(uuid, providerType, isHealthy ? 1 : 0, checkModel, errorMessage);
    }

    /**
     * 获取健康检查历史
     * @param {string} uuid - 提供商 UUID
     * @param {number} limit - 返回记录数量
     */
    getHealthCheckHistory(uuid, limit = 10) {
        const db = this.getDb();
        const stmt = db.prepare(`
            SELECT * FROM health_check_history
            WHERE provider_uuid = ?
            ORDER BY check_time DESC
            LIMIT ?
        `);
        return stmt.all(uuid, limit);
    }

    /**
     * 清理旧的健康检查历史（保留最近 N 天）
     * @param {number} days - 保留天数
     */
    cleanOldHealthHistory(days = 7) {
        const db = this.getDb();
        const stmt = db.prepare(`
            DELETE FROM health_check_history
            WHERE check_time < datetime('now', '-' || ? || ' days')
        `);
        const result = stmt.run(days);
        if (result.changes > 0) {
            console.log(`[SQLiteDB] Cleaned ${result.changes} old health check history entries`);
        }
        return result;
    }

    // ==================== 统计查询 ====================

    /**
     * 获取提供商池统计信息
     * @param {string} providerType - 可选，过滤提供商类型
     */
    getPoolStats(providerType = null) {
        const db = this.getDb();
        let whereClause = providerType ? 'WHERE provider_type = ?' : '';
        let params = providerType ? [providerType] : [];

        const stmt = db.prepare(`
            SELECT
                provider_type,
                COUNT(*) as total,
                SUM(CASE WHEN is_healthy = 1 AND is_disabled = 0 THEN 1 ELSE 0 END) as healthy,
                SUM(CASE WHEN is_healthy = 0 THEN 1 ELSE 0 END) as unhealthy,
                SUM(CASE WHEN is_disabled = 1 THEN 1 ELSE 0 END) as disabled,
                SUM(usage_count) as total_usage,
                SUM(error_count) as total_errors
            FROM providers
            ${whereClause}
            GROUP BY provider_type
        `);

        return stmt.all(...params);
    }
}

// 导出单例
export const sqliteDB = new SQLiteDB();
export default sqliteDB;
