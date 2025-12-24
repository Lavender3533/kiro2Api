'use client';

import { useEffect, useState } from 'react';
import {
  IconChartLine,
  IconClock,
  IconAlertTriangle,
  IconCheck,
  IconRefresh,
  IconTrendingUp,
  IconActivity,
  IconX,
  IconLoader2,
  IconFile,
  IconCrown,
  IconHeartbeat,
  IconUser
} from '@tabler/icons-react';
import { CardSpotlight } from '@/components/ui/card-spotlight';
import { Badge } from '@/components/ui/badge';
import { PageLoadingSkeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';

interface UsageBreakdown {
  displayName: string;
  currentUsage: number;
  usageLimit: number;
  unit?: string;
  freeTrial?: {
    currentUsage: number;
    usageLimit: number;
    expiresAt?: string;
  };
}

interface ProviderInstance {
  uuid: string;
  email?: string;
  userId?: string;
  usageCount?: number;
  errorCount?: number;
  isHealthy?: boolean;
  isDisabled?: boolean;
  credentialsPath?: string;
  subscription?: {
    title: string;
    type: string;
  };
  limits?: {
    used?: number;
    remaining?: number;
    total?: number;
    percentUsed?: number;
    unit?: string;
  };
  usageBreakdown?: UsageBreakdown[];
  nextDateReset?: string;
  daysUntilReset?: number;
}

interface ProviderData {
  providerType: string;
  instances: ProviderInstance[];
  totalCount: number;
  successCount: number;
  errorCount: number;
}

interface UsageResponse {
  timestamp: string;
  providers: {
    [key: string]: ProviderData;
  };
  fromCache?: boolean;
}

interface QuotaSummary {
  totalQuota: number;
  usedQuota: number;
  remainingQuota: number;
  percentUsed: number;
  healthyCount: number;
  bannedCount: number;
  totalCount: number;
}

export default function UsagePage() {
  const toast = useToast();
  const [usageData, setUsageData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activePool, setActivePool] = useState<'all' | 'healthy' | 'banned'>('all');
  const [refreshingAccount, setRefreshingAccount] = useState<string | null>(null);

  useEffect(() => {
    loadStats(false);
  }, []);

  const loadStats = async (forceRefresh: boolean = true) => {
    setRefreshing(true);
    setError(null);
    const startTime = Date.now();
    try {
      const token = localStorage.getItem('authToken');
      const url = forceRefresh ? '/api/usage?refresh=true' : '/api/usage';
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });
      if (response.ok) {
        const data = await response.json();
        setUsageData(data);
      } else {
        setError('加载用量数据失败');
      }
    } catch (err) {
      console.error('Failed to load usage stats:', err);
      setError('加载用量数据失败');
    } finally {
      // 确保动画至少显示 800ms
      const elapsed = Date.now() - startTime;
      const minDelay = 800;
      if (elapsed < minDelay) {
        await new Promise(resolve => setTimeout(resolve, minDelay - elapsed));
      }
      setLoading(false);
      setRefreshing(false);
    }
  };

  // 单个账号刷新用量
  const refreshAccountUsage = async (providerType: string, uuid: string) => {
    setRefreshingAccount(uuid);
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch(`/api/usage/${providerType}/${uuid}?refresh=true`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (response.ok) {
        // 重新加载所有数据（从缓存，但这个账号的数据会是新的）
        await loadStats(false);
        toast.success('刷新成功');
      } else {
        toast.error('刷新失败');
      }
    } catch (err) {
      console.error('Failed to refresh account usage:', err);
      toast.error('刷新失败');
    } finally {
      setRefreshingAccount(null);
    }
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString('zh-CN');
  };

  const formatPercentage = (value?: number) => {
    if (value === undefined || value === null) return '0%';
    return `${value.toFixed(1)}%`;
  };

  // 判断账号属于哪个池
  const getAccountPool = (instance: ProviderInstance): 'healthy' | 'banned' => {
    if (instance.isDisabled || !instance.isHealthy) {
      return 'banned';
    }
    return 'healthy';
  };

  // 计算汇总数据
  const calculateSummary = (): QuotaSummary => {
    let totalQuota = 0;
    let usedQuota = 0;
    let healthyCount = 0;
    let bannedCount = 0;
    let totalCount = 0;

    const providers = usageData?.providers || {};
    for (const providerData of Object.values(providers)) {
      if (providerData.instances) {
        for (const instance of providerData.instances) {
          totalCount++;
          if (instance.isHealthy && !instance.isDisabled) {
            healthyCount++;
          } else {
            bannedCount++;
          }
          if (instance.limits) {
            totalQuota += instance.limits.total || 0;
            usedQuota += instance.limits.used || 0;
          }
        }
      }
    }

    const remainingQuota = totalQuota - usedQuota;
    const percentUsed = totalQuota > 0 ? (usedQuota / totalQuota) * 100 : 0;

    return {
      totalQuota,
      usedQuota,
      remainingQuota,
      percentUsed,
      healthyCount,
      bannedCount,
      totalCount
    };
  };

  // 过滤账号
  const filterInstances = (instances: ProviderInstance[]): ProviderInstance[] => {
    if (activePool === 'all') return instances;
    return instances.filter(i => getAccountPool(i) === activePool);
  };

  if (loading) {
    return <PageLoadingSkeleton />;
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-red-400">{error}</div>
      </div>
    );
  }

  const providers = usageData?.providers || {};
  const summary = calculateSummary();

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between animate-fade-in-up">
        <div>
          <h1 className="text-3xl font-bold mb-2">用量统计</h1>
          <p className="text-gray-400">API 使用情况和配额监控</p>
          {usageData?.timestamp && (
            <p className="text-xs text-gray-500 mt-1">
              更新时间: {formatDate(usageData.timestamp)}
              {usageData.fromCache && <span className="ml-2 text-blue-400">(缓存)</span>}
            </p>
          )}
        </div>
        <button
          onClick={() => loadStats(true)}
          disabled={refreshing}
          className="flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 rounded-lg font-semibold transition-all duration-200 hover:shadow-lg hover:shadow-purple-500/50 disabled:opacity-50"
        >
          {refreshing ? (
            <IconLoader2 className="w-5 h-5 animate-spin" />
          ) : (
            <IconRefresh className="w-5 h-5" />
          )}
          <span>{refreshing ? '刷新中...' : '刷新全部'}</span>
        </button>
      </div>

      {/* Quota Summary Card */}
      <CardSpotlight className="overflow-hidden">
        <div className="flex flex-col lg:flex-row lg:items-center gap-6">
          {/* 左侧：总额度进度条 */}
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
                <IconTrendingUp className="w-6 h-6" />
              </div>
              <div>
                <h2 className="text-xl font-bold">总额度概览</h2>
                <p className="text-sm text-gray-400">{summary.totalCount} 个账号</p>
              </div>
            </div>

            <div className="mb-3">
              <div className="flex justify-between text-sm mb-2">
                <span className="text-gray-400">已使用 / 总额度</span>
                <span className="font-bold">
                  <span className={summary.percentUsed > 80 ? 'text-red-400' : summary.percentUsed > 50 ? 'text-orange-400' : 'text-green-400'}>
                    {summary.usedQuota.toFixed(1)}
                  </span>
                  <span className="text-gray-500"> / </span>
                  <span className="text-white">{summary.totalQuota.toFixed(1)}</span>
                </span>
              </div>
              <div className="h-4 bg-white/10 rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all duration-500 ${
                    summary.percentUsed > 80
                      ? 'bg-gradient-to-r from-red-500 to-pink-600'
                      : summary.percentUsed > 50
                        ? 'bg-gradient-to-r from-orange-500 to-yellow-500'
                        : 'bg-gradient-to-r from-green-500 to-emerald-600'
                  }`}
                  style={{ width: `${Math.min(summary.percentUsed, 100)}%` }}
                />
              </div>
              <div className="flex justify-between text-xs text-gray-500 mt-1">
                <span>{summary.percentUsed.toFixed(1)}% 已使用</span>
                <span>剩余 {summary.remainingQuota.toFixed(1)}</span>
              </div>
            </div>
          </div>

          {/* 右侧：池筛选按钮 */}
          <div className="lg:w-64 lg:border-l lg:border-white/10 lg:pl-6">
            <h3 className="text-sm font-medium text-gray-400 mb-3">按状态筛选</h3>
            <div className="grid grid-cols-3 gap-2">
              <button
                onClick={() => setActivePool('all')}
                className={`text-center p-3 rounded-lg border transition-all ${
                  activePool === 'all'
                    ? 'bg-blue-500/20 border-blue-500/50 ring-2 ring-blue-500'
                    : 'bg-white/5 border-white/10 hover:bg-white/10'
                }`}
              >
                <div className="text-lg font-bold">{summary.totalCount}</div>
                <div className="text-xs text-gray-400">全部</div>
              </button>
              <button
                onClick={() => setActivePool('healthy')}
                className={`text-center p-3 rounded-lg border transition-all ${
                  activePool === 'healthy'
                    ? 'bg-green-500/20 border-green-500/50 ring-2 ring-green-500'
                    : 'bg-white/5 border-white/10 hover:bg-white/10'
                }`}
              >
                <div className="text-lg font-bold text-green-400">{summary.healthyCount}</div>
                <div className="text-xs text-gray-400">健康</div>
              </button>
              <button
                onClick={() => setActivePool('banned')}
                className={`text-center p-3 rounded-lg border transition-all ${
                  activePool === 'banned'
                    ? 'bg-red-500/20 border-red-500/50 ring-2 ring-red-500'
                    : 'bg-white/5 border-white/10 hover:bg-white/10'
                }`}
              >
                <div className="text-lg font-bold text-red-400">{summary.bannedCount}</div>
                <div className="text-xs text-gray-400">异常</div>
              </button>
            </div>
          </div>
        </div>
      </CardSpotlight>

      {/* Provider Usage */}
      {Object.entries(providers).map(([providerName, providerData]) => {
        const filteredInstances = filterInstances(providerData.instances || []);
        if (filteredInstances.length === 0) return null;

        return (
          <CardSpotlight key={providerName}>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-xl font-bold">{providerName}</h3>
                <Badge variant="secondary">
                  {filteredInstances.length} / {providerData.instances?.length || 0} 个账户
                </Badge>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {filteredInstances.map((instance, index) => {
                  const pool = getAccountPool(instance);
                  const isRefreshing = refreshingAccount === instance.uuid;

                  return (
                    <div key={instance.uuid || index} className="p-4 rounded-lg bg-white/5 border border-white/10">
                      {/* Header: Email & Health Status */}
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm" title={instance.email}>
                            {instance.email || `账户 ${index + 1}`}
                          </span>
                          {pool === 'healthy' ? (
                            <Badge className="bg-green-500/20 text-green-400 border-green-500/30">健康</Badge>
                          ) : (
                            <Badge className="bg-red-500/20 text-red-400 border-red-500/30">异常</Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {instance.subscription && (
                            <Badge variant="outline" className="flex items-center gap-1">
                              <IconCrown className="w-3 h-3" />
                              {instance.subscription.title}
                            </Badge>
                          )}
                          <button
                            onClick={() => refreshAccountUsage(providerName, instance.uuid)}
                            disabled={isRefreshing}
                            className="p-1.5 rounded-lg hover:bg-white/10 transition-colors disabled:opacity-50"
                            title="刷新此账号用量"
                          >
                            {isRefreshing ? (
                              <IconLoader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <IconRefresh className="w-4 h-4" />
                            )}
                          </button>
                        </div>
                      </div>

                      {/* Credentials Path */}
                      {instance.credentialsPath && (
                        <div className="flex items-center gap-2 mb-3 text-xs text-gray-500">
                          <IconFile className="w-3 h-3" />
                          <span className="truncate" title={instance.credentialsPath}>
                            {instance.credentialsPath}
                          </span>
                        </div>
                      )}

                      {/* Total Usage */}
                      {instance.limits && (
                        <div className="mb-4 p-3 rounded-lg bg-white/5">
                          <div className="flex justify-between text-sm mb-2">
                            <span className="text-gray-400">总用量</span>
                            <span className="font-medium">
                              {(instance.limits.used || 0).toFixed(2)} / {(instance.limits.total || 0).toFixed(2)}
                            </span>
                          </div>
                          <div className="h-2 bg-white/10 rounded-full overflow-hidden mb-1">
                            <div
                              className={`h-full transition-all ${
                                (instance.limits.percentUsed || 0) > 90
                                  ? 'bg-red-500'
                                  : (instance.limits.percentUsed || 0) > 70
                                    ? 'bg-orange-500'
                                    : 'bg-gradient-to-r from-green-500 to-emerald-600'
                              }`}
                              style={{ width: `${Math.min(instance.limits.percentUsed || 0, 100)}%` }}
                            />
                          </div>
                          <p className="text-xs text-gray-500 text-right">
                            {formatPercentage(instance.limits.percentUsed)}
                          </p>
                        </div>
                      )}

                      {/* Usage Breakdown */}
                      {instance.usageBreakdown && instance.usageBreakdown.length > 0 && (
                        <div className="space-y-2 mb-3">
                          {instance.usageBreakdown.map((breakdown, idx) => (
                            <div key={idx} className="text-sm">
                              <div className="flex justify-between text-gray-400">
                                <span>{breakdown.displayName}</span>
                                <span>
                                  {(breakdown.currentUsage || 0).toFixed(2)} / {(breakdown.usageLimit || 0).toFixed(2)}
                                </span>
                              </div>
                              {breakdown.freeTrial && (
                                <div className="mt-1 pl-3 border-l-2 border-purple-500/50">
                                  <div className="flex justify-between text-xs text-purple-400">
                                    <span>免费试用</span>
                                    <span>
                                      {(breakdown.freeTrial.currentUsage || 0).toFixed(2)} / {(breakdown.freeTrial.usageLimit || 0).toFixed(2)}
                                    </span>
                                  </div>
                                  {breakdown.freeTrial.expiresAt && (
                                    <p className="text-xs text-gray-500">
                                      到期: {new Date(breakdown.freeTrial.expiresAt).toLocaleString('zh-CN')}
                                    </p>
                                  )}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Footer Stats */}
                      <div className="pt-3 border-t border-white/10 grid grid-cols-2 gap-2 text-xs text-gray-400">
                        {instance.usageCount !== undefined && (
                          <div className="flex justify-between">
                            <span>使用次数:</span>
                            <span className="text-white">{instance.usageCount}</span>
                          </div>
                        )}
                        {instance.errorCount !== undefined && instance.errorCount > 0 && (
                          <div className="flex justify-between">
                            <span>错误次数:</span>
                            <span className="text-red-400">{instance.errorCount}</span>
                          </div>
                        )}
                        {instance.daysUntilReset !== undefined && (
                          <div className="flex justify-between">
                            <span>重置倒计时:</span>
                            <span className="text-blue-400">{instance.daysUntilReset} 天</span>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </CardSpotlight>
        );
      })}

      {Object.keys(providers).length === 0 && (
        <CardSpotlight>
          <div className="text-center py-12">
            <IconChartLine className="w-12 h-12 mx-auto text-gray-600 mb-4" />
            <p className="text-gray-400 text-lg">暂无用量数据</p>
            <p className="text-gray-500 text-sm mt-2">配置提供商后将在此显示用量统计</p>
          </div>
        </CardSpotlight>
      )}

      {/* 筛选后无结果提示 */}
      {Object.keys(providers).length > 0 &&
       Object.values(providers).every(p => filterInstances(p.instances || []).length === 0) && (
        <CardSpotlight>
          <div className="text-center py-12">
            <p className="text-gray-400 text-lg">
              {activePool === 'healthy' ? '健康池' : '异常池'}暂无账号
            </p>
            <button
              onClick={() => setActivePool('all')}
              className="mt-4 text-blue-400 hover:underline"
            >
              查看全部账号
            </button>
          </div>
        </CardSpotlight>
      )}
    </div>
  );
}
