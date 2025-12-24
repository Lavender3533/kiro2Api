'use client';

import { useEffect, useState } from 'react';
import { IconCheck, IconX, IconRefresh, IconSettings, IconLoader2 } from '@tabler/icons-react';
import { CardSpotlight } from '@/components/ui/card-spotlight';
import { Badge } from '@/components/ui/badge';
import { PageLoadingSkeleton } from '@/components/ui/skeleton';

interface ConfigData {
  REQUIRED_API_KEY: string;
  HOST: string;
  SERVER_PORT: number;
  MODEL_PROVIDER: string;
  systemPrompt: string;

  // Kiro OAuth only
  KIRO_OAUTH_CREDS_BASE64?: string;
  KIRO_OAUTH_CREDS_FILE_PATH?: string;

  // Advanced
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
}

export default function ConfigPage() {
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<'basic' | 'advanced'>('basic');
  const [kiroCredsType, setKiroCredsType] = useState<'base64' | 'file'>('file');

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    setRefreshing(true);
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch('/api/config', {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });
      if (response.ok) {
        const data = await response.json();
        setConfig(data);

        // Set Kiro creds type
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
      // Prepare config based on Kiro creds type
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
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        });
        alert('配置已保存！');
      }
    } catch (error) {
      console.error('Failed to save config:', error);
      alert('保存配置失败: ' + (error instanceof Error ? error.message : String(error)));
    } finally {
      setSaving(false);
    }
  };

  const updateConfig = (key: string, value: any) => {
    setConfig(prev => prev ? { ...prev, [key]: value } : null);
  };

  const InputField = ({
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
    <div className="space-y-2">
      <label className="block text-sm font-medium text-gray-300">{label}</label>
      {type === 'textarea' ? (
        <textarea
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all resize-none"
          rows={4}
        />
      ) : type === 'checkbox' ? (
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={value || false}
            onChange={(e) => onChange(e.target.checked)}
            className="w-4 h-4 rounded bg-white/5 border-white/10 text-blue-500 focus:ring-blue-500"
          />
          <span className="text-sm text-gray-400">{hint}</span>
        </label>
      ) : (
        <input
          type={type}
          value={value || ''}
          onChange={(e) => onChange(type === 'number' ? parseInt(e.target.value) : e.target.value)}
          placeholder={placeholder}
          className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
        />
      )}
      {hint && type !== 'checkbox' && <p className="text-xs text-gray-500">{hint}</p>}
    </div>
  );

  const SelectField = ({
    label,
    value,
    onChange,
    options
  }: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    options: { value: string; label: string }[]
  }) => (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-gray-300">{label}</label>
      <select
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
      >
        {options.map(opt => (
          <option key={opt.value} value={opt.value} className="bg-gray-900">
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );

  if (loading || !config) {
    return <PageLoadingSkeleton />;
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between animate-fade-in-up">
        <div>
          <h1 className="text-3xl font-bold mb-2">配置管理</h1>
          <p className="text-gray-400">管理系统配置和提供商设置</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={loadConfig}
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
          <button
            onClick={saveConfig}
            disabled={saving}
            className="flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 rounded-lg font-semibold transition-all duration-200 hover:shadow-lg hover:shadow-purple-500/50 disabled:opacity-50"
          >
            {saving ? (
              <>
                <IconLoader2 className="w-5 h-5 animate-spin" />
                <span>保存中...</span>
              </>
            ) : (
              <>
                <IconCheck className="w-5 h-5" />
                <span>保存配置</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-4 border-b border-white/10">
        <button
          onClick={() => setActiveTab('basic')}
          className={`px-4 py-2 font-medium transition-all ${
            activeTab === 'basic'
              ? 'text-blue-400 border-b-2 border-blue-400'
              : 'text-gray-400 hover:text-white'
          }`}
        >
          基础配置
        </button>
        <button
          onClick={() => setActiveTab('advanced')}
          className={`px-4 py-2 font-medium transition-all ${
            activeTab === 'advanced'
              ? 'text-blue-400 border-b-2 border-blue-400'
              : 'text-gray-400 hover:text-white'
          }`}
        >
          高级配置
        </button>
      </div>

      {/* Basic Config Tab */}
      {activeTab === 'basic' && (
        <div className="space-y-6">
          {/* Server Settings */}
          <CardSpotlight>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-xl font-bold">服务器设置</h3>
                <Badge variant="secondary">基础</Badge>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <InputField
                  label="API Key"
                  value={config.REQUIRED_API_KEY}
                  onChange={(v) => updateConfig('REQUIRED_API_KEY', v)}
                  placeholder="123456"
                  hint="用于验证API请求的密钥"
                />
                <InputField
                  label="服务器端口"
                  value={config.SERVER_PORT}
                  onChange={(v) => updateConfig('SERVER_PORT', v)}
                  type="number"
                  placeholder="8045"
                />
                <InputField
                  label="主机地址"
                  value={config.HOST}
                  onChange={(v) => updateConfig('HOST', v)}
                  placeholder="localhost"
                />
                <SelectField
                  label="模型提供商"
                  value={config.MODEL_PROVIDER}
                  onChange={(v) => updateConfig('MODEL_PROVIDER', v)}
                  options={[
                    { value: 'claude-kiro-oauth', label: 'Claude Kiro OAuth' },
                  ]}
                />
              </div>

              <InputField
                label="系统提示词"
                value={config.systemPrompt}
                onChange={(v) => updateConfig('systemPrompt', v)}
                type="textarea"
                placeholder="可选的系统提示词..."
              />
            </div>
          </CardSpotlight>

          {/* Provider-specific Config */}
          {config.MODEL_PROVIDER === 'claude-kiro-oauth' && (
            <CardSpotlight>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-xl font-bold">Claude Kiro OAuth 配置</h3>
                  <Badge>当前提供商</Badge>
                </div>

                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-2">凭据类型</label>
                    <div className="flex gap-4">
                      <label className="flex items-center gap-2">
                        <input
                          type="radio"
                          checked={kiroCredsType === 'base64'}
                          onChange={() => setKiroCredsType('base64')}
                          className="w-4 h-4"
                        />
                        <span className="text-sm">Base64 编码</span>
                      </label>
                      <label className="flex items-center gap-2">
                        <input
                          type="radio"
                          checked={kiroCredsType === 'file'}
                          onChange={() => setKiroCredsType('file')}
                          className="w-4 h-4"
                        />
                        <span className="text-sm">文件路径</span>
                      </label>
                    </div>
                  </div>

                  {kiroCredsType === 'base64' ? (
                    <InputField
                      label="OAuth 凭据 (Base64)"
                      value={config.KIRO_OAUTH_CREDS_BASE64}
                      onChange={(v) => updateConfig('KIRO_OAUTH_CREDS_BASE64', v)}
                      type="textarea"
                      placeholder="Base64 编码的凭据..."
                    />
                  ) : (
                    <InputField
                      label="OAuth 凭据文件路径"
                      value={config.KIRO_OAUTH_CREDS_FILE_PATH}
                      onChange={(v) => updateConfig('KIRO_OAUTH_CREDS_FILE_PATH', v)}
                      placeholder="kiro_oauth_creds.json"
                    />
                  )}
                </div>
              </div>
            </CardSpotlight>
          )}

        </div>
      )}

      {/* Advanced Config Tab */}
      {activeTab === 'advanced' && (
        <div className="space-y-6">
          {/* System Prompt Settings */}
          <CardSpotlight>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-xl font-bold">系统提示词设置</h3>
                <Badge variant="secondary">高级</Badge>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <InputField
                  label="系统提示词文件路径"
                  value={config.SYSTEM_PROMPT_FILE_PATH}
                  onChange={(v) => updateConfig('SYSTEM_PROMPT_FILE_PATH', v)}
                  placeholder="input_system_prompt.txt"
                />
                <SelectField
                  label="系统提示词模式"
                  value={config.SYSTEM_PROMPT_MODE || 'append'}
                  onChange={(v) => updateConfig('SYSTEM_PROMPT_MODE', v)}
                  options={[
                    { value: 'append', label: '追加模式' },
                    { value: 'overwrite', label: '覆盖模式' },
                  ]}
                />
              </div>
            </div>
          </CardSpotlight>

          {/* Logging Settings */}
          <CardSpotlight>
            <div className="space-y-4">
              <h3 className="text-xl font-bold">日志设置</h3>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <InputField
                  label="日志文件基础名称"
                  value={config.PROMPT_LOG_BASE_NAME}
                  onChange={(v) => updateConfig('PROMPT_LOG_BASE_NAME', v)}
                  placeholder="prompt_log"
                />
                <SelectField
                  label="日志模式"
                  value={config.PROMPT_LOG_MODE || 'none'}
                  onChange={(v) => updateConfig('PROMPT_LOG_MODE', v)}
                  options={[
                    { value: 'none', label: '禁用' },
                    { value: 'console', label: '控制台' },
                    { value: 'file', label: '文件' },
                  ]}
                />
              </div>
            </div>
          </CardSpotlight>

          {/* Request Settings */}
          <CardSpotlight>
            <div className="space-y-4">
              <h3 className="text-xl font-bold">请求设置</h3>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <InputField
                  label="最大重试次数"
                  value={config.REQUEST_MAX_RETRIES}
                  onChange={(v) => updateConfig('REQUEST_MAX_RETRIES', v)}
                  type="number"
                  placeholder="3"
                />
                <InputField
                  label="基础延迟 (ms)"
                  value={config.REQUEST_BASE_DELAY}
                  onChange={(v) => updateConfig('REQUEST_BASE_DELAY', v)}
                  type="number"
                  placeholder="1000"
                />
                <InputField
                  label="最大错误计数"
                  value={config.MAX_ERROR_COUNT}
                  onChange={(v) => updateConfig('MAX_ERROR_COUNT', v)}
                  type="number"
                  placeholder="3"
                />
              </div>
            </div>
          </CardSpotlight>

          {/* Cron Settings */}
          <CardSpotlight>
            <div className="space-y-4">
              <h3 className="text-xl font-bold">定时任务设置</h3>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <InputField
                  label="临近分钟数"
                  value={config.CRON_NEAR_MINUTES}
                  onChange={(v) => updateConfig('CRON_NEAR_MINUTES', v)}
                  type="number"
                  placeholder="15"
                  hint="Token刷新临近时间（分钟）"
                />
                <InputField
                  label="启用Token自动刷新"
                  value={config.CRON_REFRESH_TOKEN}
                  onChange={(v) => updateConfig('CRON_REFRESH_TOKEN', v)}
                  type="checkbox"
                  hint="定时刷新OAuth Token"
                />
              </div>
            </div>
          </CardSpotlight>

          {/* Provider Pools */}
          <CardSpotlight>
            <div className="space-y-4">
              <h3 className="text-xl font-bold">提供商池设置</h3>

              <InputField
                label="提供商池文件路径"
                value={config.PROVIDER_POOLS_FILE_PATH}
                onChange={(v) => updateConfig('PROVIDER_POOLS_FILE_PATH', v)}
                placeholder="provider_pools.json"
                hint="多账号池配置文件路径"
              />
            </div>
          </CardSpotlight>

          {/* AI Features */}
          <CardSpotlight>
            <div className="space-y-4">
              <h3 className="text-xl font-bold">AI 功能设置</h3>

              <InputField
                label="默认启用 Thinking"
                value={config.ENABLE_THINKING_BY_DEFAULT}
                onChange={(v) => updateConfig('ENABLE_THINKING_BY_DEFAULT', v)}
                type="checkbox"
                hint="为支持的模型默认启用思考模式"
              />
            </div>
          </CardSpotlight>
        </div>
      )}
    </div>
  );
}
