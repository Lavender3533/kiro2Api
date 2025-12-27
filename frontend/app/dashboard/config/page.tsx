'use client';

import { useEffect, useState } from 'react';
import {
  IconCheck,
  IconRefresh,
  IconSettings,
  IconLoader2,
  IconServer,
  IconKey,
  IconBrain,
  IconClock,
  IconFileText,
  IconDatabase,
  IconShieldCheck,
  IconSparkles,
  IconAdjustments
} from '@tabler/icons-react';
import { Badge } from '@/components/ui/badge';
import { PageLoadingSkeleton } from '@/components/ui/skeleton';

interface ConfigData {
  REQUIRED_API_KEY: string;
  HOST: string;
  SERVER_PORT: number;
  MODEL_PROVIDER: string;
  systemPrompt: string;
  KIRO_OAUTH_CREDS_BASE64?: string;
  KIRO_OAUTH_CREDS_FILE_PATH?: string;
  SYSTEM_PROMPT_FILE_PATH?: string;
  SYSTEM_PROMPT_MODE?: string;
  PROMPT_LOG_BASE_NAME?: string;
  PROMPT_LOG_MODE?: string;
  REQUEST_MAX_RETRIES?: number;
  REQUEST_BASE_DELAY?: number;
  CRON_NEAR_MINUTES?: number;
  CRON_REFRESH_TOKEN?: boolean;
  PROVIDER_POOLS_FILE_PATH?: string;
  MAX_ERROR_COUNT?: number;
  ENABLE_THINKING_BY_DEFAULT?: boolean;
  // SQLite 配置
  USE_SQLITE_POOL?: boolean;
  SQLITE_DB_PATH?: string;
  USAGE_CACHE_TTL?: number;
  HEALTH_CHECK_CONCURRENCY?: number;
  USAGE_QUERY_CONCURRENCY?: number;
}

// 配置项组件
const ConfigCard = ({
  icon: Icon,
  title,
  description,
  children,
  gradient
}: {
  icon: any;
  title: string;
  description?: string;
  children: React.ReactNode;
  gradient: string;
}) => (
  <div className="group relative bg-gradient-to-br from-white/[0.05] to-white/[0.02] rounded-2xl border border-white/10 overflow-hidden hover:border-white/20 transition-all duration-300">
    {/* 顶部渐变条 */}
    <div className={`h-1 bg-gradient-to-r ${gradient}`} />

    <div className="p-5">
      {/* 标题区 */}
      <div className="flex items-start gap-3 mb-4">
        <div className={`p-2 rounded-xl bg-gradient-to-br ${gradient} bg-opacity-20`}>
          <Icon className="w-5 h-5 text-white" />
        </div>
        <div className="flex-1">
          <h3 className="font-semibold text-white">{title}</h3>
          {description && (
            <p className="text-xs text-gray-500 mt-0.5">{description}</p>
          )}
        </div>
      </div>

      {/* 内容区 */}
      <div className="space-y-4">
        {children}
      </div>
    </div>
  </div>
);

// 输入框组件
const Input = ({
  label,
  value,
  onChange,
  type = 'text',
  placeholder = '',
  hint = ''
}: {
  label: string;
  value: any;
  onChange: (v: any) => void;
  type?: string;
  placeholder?: string;
  hint?: string;
}) => (
  <div className="space-y-1.5">
    <label className="text-sm font-medium text-gray-300">{label}</label>
    {type === 'textarea' ? (
      <textarea
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 bg-black/30 border border-white/10 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50 transition-all resize-none placeholder:text-gray-600"
        rows={3}
      />
    ) : type === 'checkbox' ? (
      <label className="flex items-center gap-3 p-3 bg-black/20 rounded-lg border border-white/5 cursor-pointer hover:bg-black/30 transition-colors">
        <div className="relative">
          <input
            type="checkbox"
            checked={value || false}
            onChange={(e) => onChange(e.target.checked)}
            className="sr-only"
          />
          <div className={`w-10 h-6 rounded-full transition-colors ${value ? 'bg-blue-500' : 'bg-gray-700'}`}>
            <div className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow-md transition-transform ${value ? 'translate-x-5' : 'translate-x-1'}`} />
          </div>
        </div>
        <span className="text-sm text-gray-300">{hint || label}</span>
      </label>
    ) : (
      <input
        type={type}
        value={value ?? ''}
        onChange={(e) => onChange(type === 'number' ? (e.target.value ? parseInt(e.target.value) : '') : e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 bg-black/30 border border-white/10 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50 transition-all placeholder:text-gray-600"
      />
    )}
    {hint && type !== 'checkbox' && (
      <p className="text-xs text-gray-600">{hint}</p>
    )}
  </div>
);

// 选择框组件
const Select = ({
  label,
  value,
  onChange,
  options
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) => (
  <div className="space-y-1.5">
    <label className="text-sm font-medium text-gray-300">{label}</label>
    <select
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-3 py-2 bg-black/30 border border-white/10 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50 transition-all appearance-none cursor-pointer"
      style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%236b7280'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 0.75rem center', backgroundSize: '1rem' }}
    >
      {options.map(opt => (
        <option key={opt.value} value={opt.value} className="bg-gray-900">
          {opt.label}
        </option>
      ))}
    </select>
  </div>
);

export default function ConfigPage() {
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [kiroCredsType, setKiroCredsType] = useState<'base64' | 'file'>('file');

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    setRefreshing(true);
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch('/api/config', {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (response.ok) {
        const data = await response.json();
        setConfig(data);
        if (data.KIRO_OAUTH_CREDS_BASE64) setKiroCredsType('base64');
      }
    } catch (error) {
      console.error('Failed to load config:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const saveConfig = async () => {
    if (!config) return;
    setSaving(true);
    try {
      const saveData = { ...config };
      if (config.MODEL_PROVIDER === 'claude-kiro-oauth') {
        if (kiroCredsType === 'base64') {
          saveData.KIRO_OAUTH_CREDS_FILE_PATH = undefined;
        } else {
          saveData.KIRO_OAUTH_CREDS_BASE64 = undefined;
        }
      }

      const token = localStorage.getItem('authToken');
      const response = await fetch('/api/config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(saveData),
      });

      if (response.ok) {
        await fetch('/api/reload-config', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
        });
        alert('配置已保存！');
      }
    } catch (error) {
      console.error('Failed to save config:', error);
      alert('保存配置失败');
    } finally {
      setSaving(false);
    }
  };

  const updateConfig = (key: string, value: any) => {
    setConfig(prev => prev ? { ...prev, [key]: value } : null);
  };

  if (loading || !config) {
    return <PageLoadingSkeleton />;
  }

  return (
    <div className="space-y-6 animate-fade-in">
      {/* 页面标题 */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-gradient-to-br from-violet-500/20 to-purple-500/20 border border-violet-500/30">
            <IconSettings className="w-6 h-6 text-violet-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold bg-gradient-to-r from-white to-gray-400 bg-clip-text text-transparent">
              配置管理
            </h1>
            <p className="text-sm text-gray-500">系统设置与提供商配置</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={loadConfig}
            disabled={refreshing}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium bg-white/5 border border-white/10 hover:bg-white/10 transition-all disabled:opacity-50"
          >
            {refreshing ? (
              <IconLoader2 className="w-4 h-4 animate-spin" />
            ) : (
              <IconRefresh className="w-4 h-4" />
            )}
            刷新
          </button>
          <button
            onClick={saveConfig}
            disabled={saving}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 transition-all shadow-lg shadow-blue-500/25 disabled:opacity-50"
          >
            {saving ? (
              <IconLoader2 className="w-4 h-4 animate-spin" />
            ) : (
              <IconCheck className="w-4 h-4" />
            )}
            保存配置
          </button>
        </div>
      </div>

      {/* 配置网格 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* 服务器设置 */}
        <ConfigCard
          icon={IconServer}
          title="服务器设置"
          description="API 端口和主机配置"
          gradient="from-blue-500 to-cyan-500"
        >
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="端口"
              value={config.SERVER_PORT}
              onChange={(v) => updateConfig('SERVER_PORT', v)}
              type="number"
              placeholder="8045"
            />
            <Input
              label="主机"
              value={config.HOST}
              onChange={(v) => updateConfig('HOST', v)}
              placeholder="localhost"
            />
          </div>
          <Select
            label="模型提供商"
            value={config.MODEL_PROVIDER}
            onChange={(v) => updateConfig('MODEL_PROVIDER', v)}
            options={[
              { value: 'claude-kiro-oauth', label: 'Claude Kiro OAuth' },
            ]}
          />
        </ConfigCard>

        {/* 认证设置 */}
        <ConfigCard
          icon={IconKey}
          title="认证设置"
          description="API 密钥与凭据"
          gradient="from-amber-500 to-orange-500"
        >
          <Input
            label="API Key"
            value={config.REQUIRED_API_KEY}
            onChange={(v) => updateConfig('REQUIRED_API_KEY', v)}
            placeholder="your-api-key"
            hint="用于验证 API 请求"
          />
          {config.MODEL_PROVIDER === 'claude-kiro-oauth' && (
            <>
              <div className="flex gap-2 p-1 bg-black/20 rounded-lg">
                <button
                  onClick={() => setKiroCredsType('file')}
                  className={`flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                    kiroCredsType === 'file'
                      ? 'bg-white/10 text-white'
                      : 'text-gray-400 hover:text-white'
                  }`}
                >
                  文件路径
                </button>
                <button
                  onClick={() => setKiroCredsType('base64')}
                  className={`flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                    kiroCredsType === 'base64'
                      ? 'bg-white/10 text-white'
                      : 'text-gray-400 hover:text-white'
                  }`}
                >
                  Base64
                </button>
              </div>
              {kiroCredsType === 'file' ? (
                <Input
                  label="凭据文件"
                  value={config.KIRO_OAUTH_CREDS_FILE_PATH}
                  onChange={(v) => updateConfig('KIRO_OAUTH_CREDS_FILE_PATH', v)}
                  placeholder="configs/kiro-oauth/creds.json"
                />
              ) : (
                <Input
                  label="凭据 (Base64)"
                  value={config.KIRO_OAUTH_CREDS_BASE64}
                  onChange={(v) => updateConfig('KIRO_OAUTH_CREDS_BASE64', v)}
                  type="textarea"
                  placeholder="Base64 编码的凭据..."
                />
              )}
            </>
          )}
        </ConfigCard>

        {/* AI 功能 */}
        <ConfigCard
          icon={IconSparkles}
          title="AI 功能"
          description="模型行为设置"
          gradient="from-pink-500 to-rose-500"
        >
          <Input
            label="默认启用 Thinking"
            value={config.ENABLE_THINKING_BY_DEFAULT}
            onChange={(v) => updateConfig('ENABLE_THINKING_BY_DEFAULT', v)}
            type="checkbox"
            hint="为支持的模型启用思考模式"
          />
          <Input
            label="系统提示词"
            value={config.systemPrompt}
            onChange={(v) => updateConfig('systemPrompt', v)}
            type="textarea"
            placeholder="可选的系统提示词..."
          />
        </ConfigCard>

        {/* 提示词设置 */}
        <ConfigCard
          icon={IconFileText}
          title="提示词设置"
          description="系统提示词文件配置"
          gradient="from-emerald-500 to-teal-500"
        >
          <Input
            label="提示词文件路径"
            value={config.SYSTEM_PROMPT_FILE_PATH}
            onChange={(v) => updateConfig('SYSTEM_PROMPT_FILE_PATH', v)}
            placeholder="input_system_prompt.txt"
          />
          <Select
            label="提示词模式"
            value={config.SYSTEM_PROMPT_MODE || 'append'}
            onChange={(v) => updateConfig('SYSTEM_PROMPT_MODE', v)}
            options={[
              { value: 'append', label: '追加模式' },
              { value: 'overwrite', label: '覆盖模式' },
            ]}
          />
        </ConfigCard>

        {/* 请求设置 */}
        <ConfigCard
          icon={IconAdjustments}
          title="请求设置"
          description="重试与延迟配置"
          gradient="from-indigo-500 to-violet-500"
        >
          <div className="grid grid-cols-3 gap-3">
            <Input
              label="最大重试"
              value={config.REQUEST_MAX_RETRIES}
              onChange={(v) => updateConfig('REQUEST_MAX_RETRIES', v)}
              type="number"
              placeholder="3"
            />
            <Input
              label="延迟 (ms)"
              value={config.REQUEST_BASE_DELAY}
              onChange={(v) => updateConfig('REQUEST_BASE_DELAY', v)}
              type="number"
              placeholder="1000"
            />
            <Input
              label="最大错误"
              value={config.MAX_ERROR_COUNT}
              onChange={(v) => updateConfig('MAX_ERROR_COUNT', v)}
              type="number"
              placeholder="3"
            />
          </div>
        </ConfigCard>

        {/* 定时任务 */}
        <ConfigCard
          icon={IconClock}
          title="定时任务"
          description="Token 刷新设置"
          gradient="from-sky-500 to-blue-500"
        >
          <Input
            label="临近时间 (分钟)"
            value={config.CRON_NEAR_MINUTES}
            onChange={(v) => updateConfig('CRON_NEAR_MINUTES', v)}
            type="number"
            placeholder="15"
            hint="Token 过期前多少分钟刷新"
          />
          <Input
            label="自动刷新 Token"
            value={config.CRON_REFRESH_TOKEN}
            onChange={(v) => updateConfig('CRON_REFRESH_TOKEN', v)}
            type="checkbox"
            hint="定时刷新 OAuth Token"
          />
        </ConfigCard>

        {/* 日志设置 */}
        <ConfigCard
          icon={IconDatabase}
          title="日志设置"
          description="请求日志记录"
          gradient="from-gray-500 to-slate-500"
        >
          <Input
            label="日志文件名"
            value={config.PROMPT_LOG_BASE_NAME}
            onChange={(v) => updateConfig('PROMPT_LOG_BASE_NAME', v)}
            placeholder="prompt_log"
          />
          <Select
            label="日志模式"
            value={config.PROMPT_LOG_MODE || 'none'}
            onChange={(v) => updateConfig('PROMPT_LOG_MODE', v)}
            options={[
              { value: 'none', label: '禁用' },
              { value: 'console', label: '控制台' },
              { value: 'file', label: '文件' },
            ]}
          />
        </ConfigCard>

        {/* 提供商池 */}
        <ConfigCard
          icon={IconShieldCheck}
          title="提供商池"
          description="多账号池配置"
          gradient="from-fuchsia-500 to-pink-500"
        >
          <Input
            label="配置文件路径"
            value={config.PROVIDER_POOLS_FILE_PATH}
            onChange={(v) => updateConfig('PROVIDER_POOLS_FILE_PATH', v)}
            placeholder="provider_pools.json"
            hint="多账号负载均衡配置"
          />
        </ConfigCard>

        {/* SQLite 高性能模式 */}
        <ConfigCard
          icon={IconDatabase}
          title="高性能模式"
          description="SQLite 缓存加速"
          gradient="from-cyan-500 to-blue-500"
        >
          <Input
            label="启用 SQLite 模式"
            value={config.USE_SQLITE_POOL}
            onChange={(v) => updateConfig('USE_SQLITE_POOL', v)}
            type="checkbox"
            hint="账号多时建议开启，保存后需重启服务器生效"
          />
          {config.USE_SQLITE_POOL && (
            <>
              <div className="p-2 mb-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
                <p className="text-xs text-amber-400">修改后需重启服务器生效</p>
              </div>
              <Input
                label="数据库路径"
                value={config.SQLITE_DB_PATH}
                onChange={(v) => updateConfig('SQLITE_DB_PATH', v)}
                placeholder="data/provider_pool.db"
              />
              <div className="grid grid-cols-3 gap-3">
                <Input
                  label="缓存时长(秒)"
                  value={config.USAGE_CACHE_TTL}
                  onChange={(v) => updateConfig('USAGE_CACHE_TTL', v)}
                  type="number"
                  placeholder="300"
                />
                <Input
                  label="检查并发"
                  value={config.HEALTH_CHECK_CONCURRENCY}
                  onChange={(v) => updateConfig('HEALTH_CHECK_CONCURRENCY', v)}
                  type="number"
                  placeholder="5"
                />
                <Input
                  label="查询并发"
                  value={config.USAGE_QUERY_CONCURRENCY}
                  onChange={(v) => updateConfig('USAGE_QUERY_CONCURRENCY', v)}
                  type="number"
                  placeholder="10"
                />
              </div>
            </>
          )}
        </ConfigCard>
      </div>
    </div>
  );
}
