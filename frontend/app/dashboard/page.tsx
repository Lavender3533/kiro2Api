'use client';

import { useEffect, useState } from 'react';
import {
  IconBolt,
  IconClock,
  IconCpu,
  IconChartLine,
  IconRefresh,
  IconLoader2,
  IconCheck,
  IconX,
  IconAlertTriangle,
  IconUser,
  IconTrendingUp
} from '@tabler/icons-react';
import { CardSpotlight } from '@/components/ui/card-spotlight';
import { Badge } from '@/components/ui/badge';
import { PageLoadingSkeleton } from '@/components/ui/skeleton';

interface SystemInfo {
  uptime: number | string;
  nodeVersion: string;
  serverTime: string;
  memoryUsage: string;
}

interface PoolStats {
  healthy: number;
  checking: number;
  banned: number;
  total: number;
  totalUsageCount: number;
  totalErrorCount: number;
  cacheHitRate: string;
}

interface QuotaSummary {
  totalQuota: number;
  usedQuota: number;
  remainingQuota: number;
  percentUsed: number;
  healthyAccounts: number;
  totalAccounts: number;
  accountsWithQuota: number;
}

// 格式化运行时间
function formatUptime(uptime: number | string): string {
  const seconds = typeof uptime === 'string' ? parseFloat(uptime) : uptime;
  if (isNaN(seconds)) return '--';

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts = [];
  if (days > 0) parts.push(`${days}天`);
  if (hours > 0) parts.push(`${hours}小时`);
  if (minutes > 0) parts.push(`${minutes}分钟`);
  if (parts.length === 0) parts.push(`${secs}秒`);

  return parts.join('');
}

export default function DashboardPage() {
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [poolStats, setPoolStats] = useState<PoolStats | null>(null);
  const [quotaSummary, setQuotaSummary] = useState<QuotaSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    fetchAllData();
  }, []);

  const fetchAllData = async () => {
    setRefreshing(true);
    try {
      const token = localStorage.getItem('authToken');

      // 并行获取系统信息、提供商池状态和用量数据
      const [systemRes, providersRes, usageRes] = await Promise.all([
        fetch('/api/system', { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch('/api/providers', { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch('/api/usage', { headers: { 'Authorization': `Bearer ${token}` } })
      ]);

      if (systemRes.ok) {
        const data = await systemRes.json();
        setSystemInfo(data);
      }

      if (providersRes.ok) {
        const data = await providersRes.json();
        if (data._accountPoolStats) {
          setPoolStats(data._accountPoolStats);
        }
      }

      if (usageRes.ok) {
        const data = await usageRes.json();
        // 计算总额度汇总
        const summary = calculateQuotaSummary(data);
        setQuotaSummary(summary);
      }
    } catch (error) {
      console.error('Failed to fetch data:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  // 计算额度汇总
  const calculateQuotaSummary = (usageData: any): QuotaSummary => {
    let totalQuota = 0;
    let usedQuota = 0;
    let healthyAccounts = 0;
    let totalAccounts = 0;
    let accountsWithQuota = 0;

    if (usageData?.providers) {
      for (const providerData of Object.values(usageData.providers) as any[]) {
        if (providerData.instances) {
          for (const instance of providerData.instances) {
            totalAccounts++;
            if (instance.isHealthy) healthyAccounts++;
            if (instance.limits && instance.limits.total) {
              accountsWithQuota++;
              totalQuota += instance.limits.total || 0;
              usedQuota += instance.limits.used || 0;
            }
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
      healthyAccounts,
      totalAccounts,
      accountsWithQuota
    };
  };

  const StatCard = ({ icon: Icon, title, value, color }: { icon: any; title: string; value: string; color: string }) => {
    return (
      <CardSpotlight className="group cursor-pointer hover:scale-[1.01] ease-smooth">
        <div className="flex items-center justify-between">
          <div className="flex-1">
            <p className="text-gray-500 text-xs font-medium tracking-wider uppercase mb-2 opacity-70">{title}</p>
            <h3 className="text-2xl font-bold text-white leading-tight mb-1">
              {loading ? (
                <span className="inline-block animate-pulse">--</span>
              ) : (
                value
              )}
            </h3>
            {/* Small unit indicator */}
            <p className="text-xs text-gray-600">实时数据</p>
          </div>

          {/* Icon with green accent */}
          <div className="relative">
            <div
              className="w-12 h-12 rounded-xl flex items-center justify-center ease-smooth transition-all duration-300 group-hover:scale-110"
              style={{
                backgroundColor: 'var(--fitness-accent-dim)',
              }}
            >
              {/* Glow effect */}
              <div
                className="absolute inset-0 rounded-xl blur-lg opacity-0 group-hover:opacity-60 ease-smooth transition-opacity duration-300"
                style={{ backgroundColor: 'var(--fitness-accent)' }}
              />
              <Icon
                className="w-6 h-6 relative z-10 ease-smooth transition-all duration-300"
                style={{ color: 'var(--fitness-accent)' }}
              />
            </div>
          </div>
        </div>
      </CardSpotlight>
    );
  };

  if (loading) {
    return <PageLoadingSkeleton />;
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between animate-fade-in-up mb-2">
        <div>
          <p className="text-sm text-gray-500 mb-1">早上好</p>
          <h1 className="text-3xl font-bold mb-1">欢迎回来！</h1>
          <p className="text-sm text-gray-600">Kiro2API 服务状态监控</p>
        </div>
        <button
          onClick={fetchAllData}
          disabled={refreshing}
          className="flex items-center gap-2 px-4 py-2 rounded-lg border border-white/10 hover:bg-white/5 transition-all disabled:opacity-50"
        >
          {refreshing ? (
            <IconLoader2 className="w-4 h-4 animate-spin" />
          ) : (
            <IconRefresh className="w-4 h-4" />
          )}
          <span>{refreshing ? '刷新中...' : '刷新'}</span>
        </button>
      </div>

      {/* Quota Summary - 大卡片显示总额度 */}
      {quotaSummary && quotaSummary.accountsWithQuota > 0 && (
        <div className="animate-fade-in-up">
          <CardSpotlight className="overflow-hidden">
            <div className="flex flex-col lg:flex-row lg:items-center gap-6">
              {/* 左侧：总额度信息 */}
              <div className="flex-1">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
                    <IconTrendingUp className="w-6 h-6" />
                  </div>
                  <div>
                    <h2 className="text-xl font-bold">总额度概览</h2>
                    <p className="text-sm text-gray-400">{quotaSummary.accountsWithQuota} 个账号有额度数据</p>
                  </div>
                </div>

                {/* 进度条 */}
                <div className="mb-3">
                  <div className="flex justify-between text-sm mb-2">
                    <span className="text-gray-400">已使用 / 总额度</span>
                    <span className="font-bold">
                      <span className={quotaSummary.percentUsed > 80 ? 'text-red-400' : quotaSummary.percentUsed > 50 ? 'text-orange-400' : 'text-green-400'}>
                        {quotaSummary.usedQuota.toFixed(1)}
                      </span>
                      <span className="text-gray-500"> / </span>
                      <span className="text-white">{quotaSummary.totalQuota.toFixed(1)}</span>
                    </span>
                  </div>
                  <div className="h-4 bg-white/10 rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all duration-500 ${
                        quotaSummary.percentUsed > 80
                          ? 'bg-gradient-to-r from-red-500 to-pink-600'
                          : quotaSummary.percentUsed > 50
                            ? 'bg-gradient-to-r from-orange-500 to-yellow-500'
                            : 'bg-gradient-to-r from-green-500 to-emerald-600'
                      }`}
                      style={{ width: `${Math.min(quotaSummary.percentUsed, 100)}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-xs text-gray-500 mt-1">
                    <span>{quotaSummary.percentUsed.toFixed(1)}% 已使用</span>
                    <span>剩余 {quotaSummary.remainingQuota.toFixed(1)}</span>
                  </div>
                </div>
              </div>

              {/* 右侧：账号池状态 */}
              {poolStats && (
                <div className="lg:w-80 lg:border-l lg:border-white/10 lg:pl-6">
                  <h3 className="text-sm font-medium text-gray-400 mb-3">账号池状态</h3>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="text-center p-3 rounded-lg bg-green-500/10 border border-green-500/20">
                      <div className="text-2xl font-bold text-green-400">{poolStats.healthy}</div>
                      <div className="text-xs text-gray-400">健康</div>
                    </div>
                    <div className="text-center p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
                      <div className="text-2xl font-bold text-yellow-400">{poolStats.checking}</div>
                      <div className="text-xs text-gray-400">检查中</div>
                    </div>
                    <div className="text-center p-3 rounded-lg bg-red-500/10 border border-red-500/20">
                      <div className="text-2xl font-bold text-red-400">{poolStats.banned}</div>
                      <div className="text-xs text-gray-400">异常</div>
                    </div>
                  </div>
                  <div className="mt-3 flex justify-between text-xs text-gray-500">
                    <span>总请求: {poolStats.totalUsageCount}</span>
                    <span>缓存命中: {poolStats.cacheHitRate}</span>
                  </div>
                </div>
              )}
            </div>
          </CardSpotlight>
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="animate-scale-in delay-100">
          <StatCard
            icon={IconBolt}
            title="运行时间"
            value={systemInfo?.uptime ? formatUptime(systemInfo.uptime) : '--'}
            color="fitness"
          />
        </div>
        <div className="animate-scale-in delay-200">
          <StatCard
            icon={IconClock}
            title="服务器时间"
            value={systemInfo?.serverTime ? new Date(systemInfo.serverTime).toLocaleTimeString('zh-CN') : '--'}
            color="fitness"
          />
        </div>
        <div className="animate-scale-in delay-300">
          <StatCard
            icon={IconCpu}
            title="Node.js 版本"
            value={systemInfo?.nodeVersion || '--'}
            color="fitness"
          />
        </div>
        <div className="animate-scale-in delay-400">
          <StatCard
            icon={IconChartLine}
            title="内存使用"
            value={systemInfo?.memoryUsage || '--'}
            color="fitness"
          />
        </div>
      </div>

      {/* Quick Actions */}
      <div className="animate-fade-in-up delay-500">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-4">快速入门</h2>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* OpenAI Protocol */}
          <CardSpotlight className="group">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: 'var(--fitness-accent)' }}
                  />
                  <h3 className="text-sm font-bold">OpenAI 协议</h3>
                </div>
                <span
                  className="text-xs px-2 py-1 rounded-md"
                  style={{ backgroundColor: 'var(--fitness-accent-dim)', color: 'var(--fitness-accent)' }}
                >
                  推荐
                </span>
              </div>

              <div
                className="rounded-lg p-3 border overflow-x-auto"
                style={{
                  backgroundColor: 'rgba(0, 0, 0, 0.3)',
                  borderColor: 'var(--fitness-border)',
                }}
              >
                <code className="text-xs font-mono" style={{ color: 'var(--fitness-accent)' }}>
                  <div className="text-gray-500">POST</div>
                  <div className="mt-1">/claude-kiro-oauth/v1/chat/completions</div>
                </code>
              </div>

              <p className="text-xs text-gray-600">
                兼容 OpenAI SDK，支持流式输出
              </p>
            </div>
          </CardSpotlight>

          {/* Claude Protocol */}
          <CardSpotlight className="group">
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-blue-500" />
                <h3 className="text-sm font-bold">Claude 协议</h3>
              </div>

              <div
                className="rounded-lg p-3 border overflow-x-auto"
                style={{
                  backgroundColor: 'rgba(0, 0, 0, 0.3)',
                  borderColor: 'var(--fitness-border)',
                }}
              >
                <code className="text-xs font-mono text-blue-400">
                  <div className="text-gray-500">POST</div>
                  <div className="mt-1">/claude-kiro-oauth/v1/messages</div>
                </code>
              </div>

              <p className="text-xs text-gray-600">
                原生 Claude API 格式，完整功能支持
              </p>
            </div>
          </CardSpotlight>
        </div>
      </div>
    </div>
  );
}
