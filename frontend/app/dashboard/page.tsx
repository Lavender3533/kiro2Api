'use client';

import { useEffect, useState, useMemo } from 'react';
import {
  IconBolt,
  IconClock,
  IconCpu,
  IconChartLine,
  IconRefresh,
  IconLoader2,
  IconTrendingUp,
  IconRocket,
  IconCode,
  IconBrandOpenai,
  IconBrandAws
} from '@tabler/icons-react';
import { CardSpotlight } from '@/components/ui/card-spotlight';
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

  if (days > 0) return `${days}天 ${hours}时`;
  if (hours > 0) return `${hours}时 ${minutes}分`;
  return `${minutes}分钟`;
}

// 获取问候语
function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 6) return '夜深了';
  if (hour < 12) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

// 统计卡片组件
const StatCard = ({
  icon: Icon,
  title,
  value,
  subtitle,
  gradient,
  loading = false
}: {
  icon: any;
  title: string;
  value: string;
  subtitle?: string;
  gradient: string;
  loading?: boolean;
}) => (
  <div className="group relative bg-gradient-to-br from-white/[0.05] to-white/[0.02] rounded-2xl border border-white/10 p-5 hover:border-white/20 transition-all duration-300 overflow-hidden">
    {/* 背景装饰 */}
    <div className={`absolute -right-4 -top-4 w-24 h-24 rounded-full bg-gradient-to-br ${gradient} opacity-10 blur-2xl group-hover:opacity-20 transition-opacity`} />

    <div className="relative flex items-start justify-between">
      <div>
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">{title}</p>
        <h3 className="text-2xl font-bold text-white mb-1">
          {loading ? <span className="animate-pulse">--</span> : value}
        </h3>
        {subtitle && <p className="text-xs text-gray-600">{subtitle}</p>}
      </div>
      <div className={`p-2.5 rounded-xl bg-gradient-to-br ${gradient}`}>
        <Icon className="w-5 h-5 text-white" />
      </div>
    </div>
  </div>
);

// API 端点卡片
const EndpointCard = ({
  title,
  path,
  description,
  recommended = false,
  gradient
}: {
  title: string;
  path: string;
  description: string;
  recommended?: boolean;
  gradient: string;
}) => (
  <div className="group relative bg-gradient-to-br from-white/[0.05] to-white/[0.02] rounded-xl border border-white/10 p-4 hover:border-white/20 transition-all duration-300">
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-2">
        <div className={`w-2 h-2 rounded-full bg-gradient-to-r ${gradient}`} />
        <h3 className="text-sm font-semibold text-white">{title}</h3>
      </div>
      {recommended && (
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
          推荐
        </span>
      )}
    </div>
    <div className="bg-black/40 rounded-lg p-3 border border-white/5 mb-2 overflow-x-auto">
      <code className="text-xs font-mono">
        <span className="text-gray-500">POST</span>
        <span className={`ml-2 bg-gradient-to-r ${gradient} bg-clip-text text-transparent`}>{path}</span>
      </code>
    </div>
    <p className="text-xs text-gray-500">{description}</p>
  </div>
);

export default function DashboardPage() {
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [poolStats, setPoolStats] = useState<PoolStats | null>(null);
  const [quotaSummary, setQuotaSummary] = useState<QuotaSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const greeting = useMemo(() => getGreeting(), []);

  useEffect(() => {
    fetchAllData();
  }, []);

  const fetchAllData = async () => {
    setRefreshing(true);
    try {
      const token = localStorage.getItem('authToken');
      const [systemRes, providersRes, usageRes] = await Promise.all([
        fetch('/api/system', { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch('/api/providers', { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch('/api/usage', { headers: { 'Authorization': `Bearer ${token}` } })
      ]);

      if (systemRes.ok) setSystemInfo(await systemRes.json());
      if (providersRes.ok) {
        const data = await providersRes.json();
        if (data._accountPoolStats) setPoolStats(data._accountPoolStats);
      }
      if (usageRes.ok) {
        const data = await usageRes.json();
        setQuotaSummary(calculateQuotaSummary(data));
      }
    } catch (error) {
      console.error('Failed to fetch data:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const calculateQuotaSummary = (usageData: any): QuotaSummary => {
    let totalQuota = 0, usedQuota = 0, healthyAccounts = 0, totalAccounts = 0, accountsWithQuota = 0;

    if (usageData?.providers) {
      for (const providerData of Object.values(usageData.providers) as any[]) {
        if (providerData.instances) {
          for (const instance of providerData.instances) {
            totalAccounts++;
            if (instance.isHealthy) healthyAccounts++;
            if (instance.limits?.total) {
              accountsWithQuota++;
              totalQuota += instance.limits.total || 0;
              usedQuota += instance.limits.used || 0;
            }
          }
        }
      }
    }

    return {
      totalQuota,
      usedQuota,
      remainingQuota: totalQuota - usedQuota,
      percentUsed: totalQuota > 0 ? (usedQuota / totalQuota) * 100 : 0,
      healthyAccounts,
      totalAccounts,
      accountsWithQuota
    };
  };

  if (loading) return <PageLoadingSkeleton />;

  return (
    <div className="space-y-6 animate-fade-in">
      {/* 页面标题 */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-gradient-to-br from-blue-500/20 to-purple-500/20 border border-blue-500/30">
            <IconRocket className="w-6 h-6 text-blue-400" />
          </div>
          <div>
            <p className="text-sm text-gray-500">{greeting}</p>
            <h1 className="text-2xl font-bold bg-gradient-to-r from-white to-gray-400 bg-clip-text text-transparent">
              欢迎回来
            </h1>
          </div>
        </div>

        <button
          onClick={fetchAllData}
          disabled={refreshing}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium bg-white/5 border border-white/10 hover:bg-white/10 transition-all disabled:opacity-50"
        >
          {refreshing ? <IconLoader2 className="w-4 h-4 animate-spin" /> : <IconRefresh className="w-4 h-4" />}
          {refreshing ? '刷新中...' : '刷新'}
        </button>
      </div>

      {/* 额度概览 */}
      {quotaSummary && quotaSummary.accountsWithQuota > 0 && (
        <div className="bg-gradient-to-br from-white/[0.05] to-white/[0.02] rounded-2xl border border-white/10 p-5 overflow-hidden">
          <div className="flex flex-col lg:flex-row lg:items-center gap-6">
            {/* 左侧：总额度 */}
            <div className="flex-1">
              <div className="flex items-center gap-3 mb-4">
                <div className="p-2 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600">
                  <IconTrendingUp className="w-5 h-5 text-white" />
                </div>
                <div>
                  <h2 className="font-semibold text-white">额度概览</h2>
                  <p className="text-xs text-gray-500">{quotaSummary.accountsWithQuota} 个账号</p>
                </div>
              </div>

              {/* 进度条 */}
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">已使用</span>
                  <span className="font-medium">
                    <span className={quotaSummary.percentUsed > 80 ? 'text-red-400' : quotaSummary.percentUsed > 50 ? 'text-amber-400' : 'text-emerald-400'}>
                      {quotaSummary.usedQuota.toFixed(1)}
                    </span>
                    <span className="text-gray-600"> / {quotaSummary.totalQuota.toFixed(1)}</span>
                  </span>
                </div>
                <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all duration-700 ${
                      quotaSummary.percentUsed > 80 ? 'bg-gradient-to-r from-red-500 to-pink-500' :
                      quotaSummary.percentUsed > 50 ? 'bg-gradient-to-r from-amber-500 to-orange-500' :
                      'bg-gradient-to-r from-emerald-500 to-teal-500'
                    }`}
                    style={{ width: `${Math.min(quotaSummary.percentUsed, 100)}%` }}
                  />
                </div>
                <div className="flex justify-between text-xs text-gray-600">
                  <span>{quotaSummary.percentUsed.toFixed(1)}%</span>
                  <span>剩余 {quotaSummary.remainingQuota.toFixed(1)}</span>
                </div>
              </div>
            </div>

            {/* 右侧：账号池状态 */}
            {poolStats && (
              <div className="lg:w-72 lg:border-l lg:border-white/10 lg:pl-6">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">账号池</p>
                <div className="grid grid-cols-3 gap-2">
                  <div className="text-center p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                    <div className="text-xl font-bold text-emerald-400">{poolStats.healthy}</div>
                    <div className="text-[10px] text-gray-500">健康</div>
                  </div>
                  <div className="text-center p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
                    <div className="text-xl font-bold text-amber-400">{poolStats.checking}</div>
                    <div className="text-[10px] text-gray-500">检查</div>
                  </div>
                  <div className="text-center p-2.5 rounded-lg bg-red-500/10 border border-red-500/20">
                    <div className="text-xl font-bold text-red-400">{poolStats.banned}</div>
                    <div className="text-[10px] text-gray-500">异常</div>
                  </div>
                </div>
                <div className="mt-2 flex justify-between text-[10px] text-gray-600">
                  <span>请求: {poolStats.totalUsageCount}</span>
                  <span>缓存: {poolStats.cacheHitRate}</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 系统统计 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={IconBolt}
          title="运行时间"
          value={systemInfo?.uptime ? formatUptime(systemInfo.uptime) : '--'}
          gradient="from-amber-500 to-orange-500"
          loading={loading}
        />
        <StatCard
          icon={IconClock}
          title="服务器时间"
          value={systemInfo?.serverTime ? new Date(systemInfo.serverTime).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '--'}
          gradient="from-blue-500 to-cyan-500"
          loading={loading}
        />
        <StatCard
          icon={IconCpu}
          title="Node 版本"
          value={systemInfo?.nodeVersion || '--'}
          gradient="from-emerald-500 to-teal-500"
          loading={loading}
        />
        <StatCard
          icon={IconChartLine}
          title="内存使用"
          value={systemInfo?.memoryUsage || '--'}
          gradient="from-purple-500 to-pink-500"
          loading={loading}
        />
      </div>

      {/* API 端点 */}
      <div>
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">API 端点</p>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <EndpointCard
            title="OpenAI 协议"
            path="/claude-kiro-oauth/v1/chat/completions"
            description="兼容 OpenAI SDK，支持流式输出"
            recommended
            gradient="from-emerald-500 to-teal-500"
          />
          <EndpointCard
            title="Claude 协议"
            path="/claude-kiro-oauth/v1/messages"
            description="原生 Claude API 格式"
            gradient="from-blue-500 to-indigo-500"
          />
        </div>
      </div>
    </div>
  );
}
