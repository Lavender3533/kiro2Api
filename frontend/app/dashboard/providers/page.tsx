'use client';

import { useEffect, useState } from 'react';
import {
  IconCheck,
  IconX,
  IconRefresh,
  IconTrash,
  IconEye,
  IconEyeOff,
  IconUser,
  IconMail,
  IconClock,
  IconAlertTriangle,
  IconHeartbeat,
  IconLink,
  IconPlayerPlay,
  IconLoader2,
  IconKey,
  IconChevronRight,
  IconClipboard,
  IconExternalLink,
  IconCopy
} from '@tabler/icons-react';
import { CardSpotlight } from '@/components/ui/card-spotlight';
import { Badge } from '@/components/ui/badge';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { useToast } from '@/components/ui/toast';
import { PageLoadingSkeleton } from '@/components/ui/skeleton';

interface ErrorStatus {
  status: string;
  message: string;
  statusType: 'ok' | 'banned' | 'quota_exceeded' | 'expired' | 'rate_limit' | 'server_error' | 'network_error' | 'unknown';
}

interface ProviderAccount {
  KIRO_OAUTH_CREDS_FILE_PATH?: string;
  uuid: string;
  checkModelName?: string;
  checkHealth?: boolean;
  isHealthy: boolean;
  isDisabled: boolean;
  lastUsed?: string;
  usageCount: number;
  errorCount: number;
  lastErrorTime?: string;
  lastHealthCheckTime?: string;
  lastHealthCheckModel?: string;
  lastErrorMessage?: string | null;
  cachedUserId?: string;
  cachedEmail?: string;
  cachedAt?: string;
  errorStatus?: ErrorStatus;
  poolType?: 'healthy' | 'checking' | 'banned' | 'disabled';
}

interface ProviderPools {
  [providerType: string]: ProviderAccount[];
}

interface AccountPoolStats {
  healthy: number;
  checking: number;
  banned: number;
  total: number;
  totalUsageCount: number;
  totalErrorCount: number;
  cacheHitRate: string;
}

export default function ProvidersPage() {
  const toast = useToast();
  const [providers, setProviders] = useState<ProviderPools>({});
  const [poolStats, setPoolStats] = useState<AccountPoolStats | null>(null);
  const [activePool, setActivePool] = useState<'all' | 'healthy' | 'checking' | 'banned'>('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeProvider, setActiveProvider] = useState<string>('claude-kiro-oauth');
  const [healthChecking, setHealthChecking] = useState(false);
  const [bannedHealthChecking, setBannedHealthChecking] = useState(false);
  const [resettingHealth, setResettingHealth] = useState(false);
  const [generatingAuth, setGeneratingAuth] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  // 社交登录结果模态框
  const [showSocialAuthModal, setShowSocialAuthModal] = useState(false);
  const [socialAuthProvider, setSocialAuthProvider] = useState<string>('');
  const [authState, setAuthState] = useState<string>('');  // 保存 state 用于轮询

  // 轮询检测社交登录授权完成
  useEffect(() => {
    if (!showSocialAuthModal || !authState) return;

    const pollInterval = setInterval(async () => {
      try {
        const token = localStorage.getItem('authToken');
        const response = await fetch(`/api/kiro/oauth/check-state?state=${authState}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (response.ok) {
          const result = await response.json();
          if (result.completed) {
            clearInterval(pollInterval);
            setShowSocialAuthModal(false);
            toast.success('授权成功！', `账号 #${result.accountNumber || ''} 已添加`);
            await loadProviders();
          }
        }
      } catch (e) {
        // 忽略错误，继续轮询
      }
    }, 2000);  // 每2秒检查一次

    return () => clearInterval(pollInterval);
  }, [showSocialAuthModal, authState]);

  // 单个账号操作状态
  const [accountHealthChecking, setAccountHealthChecking] = useState<string | null>(null);
  const [accountTesting, setAccountTesting] = useState<string | null>(null);
  const [accountResetting, setAccountResetting] = useState<string | null>(null);
  const [accountDeleting, setAccountDeleting] = useState<string | null>(null);

  // 批量选择和删除状态
  const [selectedAccounts, setSelectedAccounts] = useState<Set<string>>(new Set());
  const [batchDeleting, setBatchDeleting] = useState(false);

  // 检查 401 错误并跳转到登录页
  const handleApiError = (response: Response) => {
    if (response.status === 401) {
      localStorage.removeItem('authToken');
      toast.error('登录已过期', '请重新登录');
      setTimeout(() => {
        window.location.href = '/login.html';
      }, 1000);
      return true;
    }
    return false;
  };

  useEffect(() => {
    loadProviders();
  }, []);

  const loadProviders = async () => {
    setRefreshing(true);
    const startTime = Date.now();
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch('/api/providers', {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });
      if (handleApiError(response)) return;
      if (response.ok) {
        const data = await response.json();
        // 提取池统计信息
        if (data._accountPoolStats) {
          setPoolStats(data._accountPoolStats);
        }
        // 过滤掉不需要显示的提供商类型和内部字段
        const hiddenProviders = ['gemini-cli-oauth', 'openai-qwen-oauth', 'gemini-antigravity'];
        const filteredData: ProviderPools = {};
        for (const [key, value] of Object.entries(data)) {
          // 跳过以 _ 开头的内部字段（如 _accountPoolStats）和隐藏的提供商
          if (!key.startsWith('_') && !hiddenProviders.includes(key) && Array.isArray(value)) {
            filteredData[key] = value as ProviderAccount[];
          }
        }
        setProviders(filteredData);
      }
    } catch (error) {
      console.error('Failed to load providers:', error);
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

  // 批量健康检查
  const runBatchHealthCheck = async (poolFilter?: 'healthy' | 'checking' | 'banned') => {
    if (poolFilter === 'banned') {
      setBannedHealthChecking(true);
    } else {
      setHealthChecking(true);
    }
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch(`/api/providers/${activeProvider}/health-check`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: poolFilter ? JSON.stringify({ pool: poolFilter }) : undefined,
      });

      if (response.ok) {
        const result = await response.json();
        await loadProviders();
        const poolName = poolFilter === 'banned' ? '异常池' : poolFilter === 'checking' ? '检查池' : '';
        toast.success(`${poolName}健康检查完成`, `${result.successCount} 个恢复健康, ${result.failCount} 个仍异常`);
      } else {
        const error = await response.json();
        toast.error('健康检查失败', error.error?.message);
      }
    } catch (error) {
      console.error('Batch health check failed:', error);
      toast.error('健康检查失败');
    } finally {
      setHealthChecking(false);
      setBannedHealthChecking(false);
    }
  };

  // 重置所有健康状态
  const resetAllHealth = async () => {
    if (!confirm('确定要重置所有账号的健康状态吗？')) return;

    setResettingHealth(true);
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch(`/api/providers/${activeProvider}/reset-health`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (response.ok) {
        const result = await response.json();
        await loadProviders();
        toast.success('重置成功', result.message || '健康状态已重置');
      } else {
        toast.error('重置失败');
      }
    } catch (error) {
      console.error('Reset health failed:', error);
      toast.error('重置失败');
    } finally {
      setResettingHealth(false);
    }
  };

  // 授权方式选择模态框状态
  const [showAuthMethodModal, setShowAuthMethodModal] = useState(false);
  const [showManualImportModal, setShowManualImportModal] = useState(false);
  const [showAWSAuthModal, setShowAWSAuthModal] = useState(false);
  const [accountNumber, setAccountNumber] = useState(1);
  const [manualRefreshToken, setManualRefreshToken] = useState('');
  const [manualProfileArn, setManualProfileArn] = useState('');
  const [awsStartUrl, setAwsStartUrl] = useState('https://view.awsapps.com/start');
  const [deviceAuthResult, setDeviceAuthResult] = useState<any>(null);
  // 网页模式开关（无需 AntiHook）
  const [webMode, setWebMode] = useState(true);

  // SSE 监听 OAuth 成功事件（用于 AWS SSO 等后台轮询的场景）
  useEffect(() => {
    if (!showAWSAuthModal || !deviceAuthResult) return;

    const eventSource = new EventSource('/api/events');

    eventSource.addEventListener('oauth_success', (event) => {
      try {
        const data = JSON.parse(event.data);
        // 检查是否是 AWS Builder ID 授权成功
        if (data.provider === 'claude-kiro-oauth-builderid') {
          setShowAWSAuthModal(false);
          setDeviceAuthResult(null);
          toast.success('AWS 授权成功！', `Token 已保存: ${data.credPath}`);
          loadProviders();
        }
      } catch (e) {
        console.error('Failed to parse oauth_success event:', e);
      }
    });

    eventSource.addEventListener('oauth_error', (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.provider === 'claude-kiro-oauth-builderid') {
          toast.error('AWS 授权失败', data.error || '未知错误');
          setDeviceAuthResult(null);
        }
      } catch (e) {
        console.error('Failed to parse oauth_error event:', e);
      }
    });

    eventSource.onerror = () => {
      // SSE 连接错误，静默处理
      console.warn('SSE connection error');
    };

    return () => {
      eventSource.close();
    };
  }, [showAWSAuthModal, deviceAuthResult]);

  // 打开授权方式选择
  const generateAuthUrl = async () => {
    // 建议的账号编号 = 现有最大文件编号 + 1
    const accounts = providers[activeProvider] || [];
    let maxNumber = 0;
    for (const account of accounts) {
      const filePath = account.KIRO_OAUTH_CREDS_FILE_PATH || '';
      // 匹配 kiro-auth-token-{number}.json
      const match = filePath.match(/kiro-auth-token-(\d+)\.json/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxNumber) {
          maxNumber = num;
        }
      }
    }
    const suggestedNumber = maxNumber + 1;
    setAccountNumber(suggestedNumber);
    setShowAuthMethodModal(true);
  };

  // 手动导入 RefreshToken
  const handleManualImport = async () => {
    if (!manualRefreshToken.trim()) {
      toast.error('请输入 RefreshToken');
      return;
    }
    if (!manualRefreshToken.startsWith('aorAAAAAG')) {
      toast.error('RefreshToken 格式不正确，应该以 aorAAAAAG 开头');
      return;
    }

    setGeneratingAuth(true);
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch('/api/kiro/oauth/manual-import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          refreshToken: manualRefreshToken,
          profileArn: manualProfileArn,
          accountNumber
        }),
      });

      if (response.ok) {
        toast.success('导入成功', 'RefreshToken 已保存');
        setShowManualImportModal(false);
        setManualRefreshToken('');
        setManualProfileArn('');
        await loadProviders();
      } else {
        const error = await response.json();
        toast.error('导入失败', error.message || '未知错误');
      }
    } catch (error) {
      console.error('Manual import failed:', error);
      toast.error('导入失败');
    } finally {
      setGeneratingAuth(false);
    }
  };

  // AWS Builder ID 设备授权
  const handleAWSDeviceAuth = async () => {
    setGeneratingAuth(true);
    setDeviceAuthResult(null);
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch('/api/kiro/oauth/aws-sso/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          accountNumber,
          startUrl: awsStartUrl
        }),
      });

      if (response.ok) {
        const result = await response.json();
        if (result.success) {
          setDeviceAuthResult(result);
          toast.success('设备授权已启动', '请在浏览器中完成授权');
        } else {
          toast.error('启动失败', result.error || '未知错误');
        }
      } else {
        const error = await response.json();
        toast.error('启动失败', error.error?.message || '未知错误');
      }
    } catch (error) {
      console.error('AWS device auth failed:', error);
      toast.error('启动设备授权失败');
    } finally {
      setGeneratingAuth(false);
    }
  };

  // 社交登录（GitHub/Google）
  const handleSocialAuth = async (provider: string) => {
    setGeneratingAuth(true);
    setShowAuthMethodModal(false);
    setSocialAuthProvider(provider);
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch('/api/kiro/oauth/generate-url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          provider,
          accountNumber,
          webMode  // 网页模式：直接回调到后端，无需 AntiHook
        }),
      });

      if (response.ok) {
        const result = await response.json();
        if (result.success && result.auth_url) {
          if (webMode) {
            // 网页模式：直接打开授权链接，OAuth 会回调到后端
            toast.success('正在打开授权页面', '请在弹出的页面中完成登录');
            window.open(result.auth_url, '_blank');
            setShowSocialAuthModal(false);
            // 延迟刷新提供商列表
            setTimeout(() => loadProviders(), 5000);
          } else {
            // AntiHook 模式：显示模态框让用户复制链接
            setAuthUrl(result.auth_url);
            setAuthState(result.state);  // 保存 state 用于轮询
            setShowSocialAuthModal(true);
          }
        } else {
          toast.error('生成授权链接失败');
        }
      } else {
        const error = await response.json();
        toast.error('生成失败', error.error?.message || '生成授权链接失败');
      }
    } catch (error) {
      console.error('Generate auth URL failed:', error);
      toast.error('生成授权链接失败');
    } finally {
      setGeneratingAuth(false);
    }
  };

  // 复制授权链接
  const copyAuthUrl = () => {
    if (authUrl) {
      navigator.clipboard.writeText(authUrl);
      toast.success('已复制', '请在无痕模式中打开此链接');
    }
  };

  // 在浏览器中打开授权链接
  const openAuthUrl = () => {
    if (authUrl) {
      window.open(authUrl, '_blank');
    }
  };

  // 一键复制并提示打开无痕模式
  const copyAndPromptIncognito = () => {
    if (authUrl) {
      navigator.clipboard.writeText(authUrl);
      toast.success('链接已复制！', '请打开无痕模式 (Ctrl+Shift+N) 粘贴访问');
    }
  };

  const toggleAccountStatus = async (providerType: string, uuid: string, currentStatus: boolean) => {
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch(`/api/providers/${providerType}/${uuid}/toggle`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ isDisabled: !currentStatus })
      });

      if (response.ok) {
        await loadProviders();
        toast.success('状态已更新', currentStatus ? '账号已启用' : '账号已禁用');
      }
    } catch (error) {
      console.error('Failed to toggle account:', error);
      toast.error('更新失败');
    }
  };

  const runHealthCheck = async (providerType: string, uuid: string) => {
    setAccountHealthChecking(uuid);
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch(`/api/providers/${providerType}/${uuid}/health-check`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (response.ok) {
        const result = await response.json();
        await loadProviders();
        if (result.isHealthy) {
          toast.success('账号健康', result.modelName ? `模型: ${result.modelName}` : undefined);
        } else {
          toast.warning('账号异常', result.error || undefined);
        }
      } else {
        toast.error('健康检查失败');
      }
    } catch (error) {
      console.error('Health check failed:', error);
      toast.error('健康检查失败');
    } finally {
      setAccountHealthChecking(null);
    }
  };

  // 单个账号测试
  const testAccount = async (providerType: string, uuid: string) => {
    setAccountTesting(uuid);
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch(`/api/providers/${providerType}/${uuid}/test`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (response.ok) {
        const result = await response.json();
        await loadProviders();
        if (result.success) {
          toast.success('测试成功', result.message || '账号正常');
        } else {
          toast.error('测试失败', result.error || '未知错误');
        }
      } else {
        const error = await response.json();
        toast.error('测试失败', error.error?.message || '未知错误');
      }
    } catch (error) {
      console.error('Test failed:', error);
      toast.error('测试失败');
    } finally {
      setAccountTesting(null);
    }
  };

  // 单个账号重置健康状态
  const resetAccountHealth = async (providerType: string, uuid: string) => {
    setAccountResetting(uuid);
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch(`/api/providers/${providerType}/${uuid}/reset-health`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (handleApiError(response)) return;
      if (response.ok) {
        await loadProviders();
        toast.success('重置成功', '健康状态已重置');
      } else {
        toast.error('重置失败');
      }
    } catch (error) {
      console.error('Reset failed:', error);
      toast.error('重置失败');
    } finally {
      setAccountResetting(null);
    }
  };

  // 删除账号
  const deleteAccount = async (providerType: string, uuid: string, accountIndex: number) => {
    if (!confirm(`确定要删除账号 #${accountIndex + 1} 吗？\n\n该操作将同时删除对应的 token 文件，且不可恢复！`)) return;

    setAccountDeleting(uuid);
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch(`/api/providers/${providerType}/${uuid}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (handleApiError(response)) return;
      if (response.ok) {
        await loadProviders();
        toast.success('删除成功', `账号 #${accountIndex + 1} 已删除`);
      } else {
        const error = await response.json();
        toast.error('删除失败', error.error?.message || '未知错误');
      }
    } catch (error) {
      console.error('Delete failed:', error);
      toast.error('删除失败');
    } finally {
      setAccountDeleting(null);
    }
  };

  // 批量删除选中的账号
  const batchDeleteAccounts = async () => {
    if (selectedAccounts.size === 0) {
      toast.warning('请先选择账号');
      return;
    }

    const selectedCount = selectedAccounts.size;
    if (!confirm(`确定要删除选中的 ${selectedCount} 个账号吗？\n\n该操作将同时删除对应的 token 文件，且不可恢复！`)) return;

    setBatchDeleting(true);
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch('/api/providers/batch-delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          providerType: activeProvider,
          uuids: Array.from(selectedAccounts)
        }),
      });

      if (handleApiError(response)) return;
      if (response.ok) {
        const result = await response.json();
        setSelectedAccounts(new Set());
        await loadProviders();
        toast.success('批量删除成功', result.message);
      } else {
        const error = await response.json();
        toast.error('批量删除失败', error.error?.message || '未知错误');
      }
    } catch (error) {
      console.error('Batch delete failed:', error);
      toast.error('批量删除失败');
    } finally {
      setBatchDeleting(false);
    }
  };

  // 按状态批量删除（如删除所有封禁/额度用尽的账号）
  const batchDeleteByStatus = async (statusTypes: string[]) => {
    const statusNames = statusTypes.map(s => {
      switch(s) {
        case 'banned': return '封禁';
        case 'quota_exceeded': return '额度用尽';
        case 'expired': return '过期';
        default: return s;
      }
    }).join('/');

    if (!confirm(`确定要删除所有 ${statusNames} 的账号吗？\n\n该操作将同时删除对应的 token 文件，且不可恢复！`)) return;

    setBatchDeleting(true);
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch('/api/providers/batch-delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          providerType: activeProvider,
          deleteByStatus: statusTypes
        }),
      });

      if (handleApiError(response)) return;
      if (response.ok) {
        const result = await response.json();
        setSelectedAccounts(new Set());
        await loadProviders();
        toast.success('批量删除成功', result.message);
      } else {
        const error = await response.json();
        toast.error('批量删除失败', error.error?.message || '未知错误');
      }
    } catch (error) {
      console.error('Batch delete by status failed:', error);
      toast.error('批量删除失败');
    } finally {
      setBatchDeleting(false);
    }
  };

  // 全选/取消全选当前筛选的账号
  const toggleSelectAll = () => {
    if (selectedAccounts.size === filteredAccounts.length) {
      setSelectedAccounts(new Set());
    } else {
      setSelectedAccounts(new Set(filteredAccounts.map(a => a.uuid)));
    }
  };

  // 切换单个账号选中状态
  const toggleAccountSelection = (uuid: string) => {
    const newSet = new Set(selectedAccounts);
    if (newSet.has(uuid)) {
      newSet.delete(uuid);
    } else {
      newSet.add(uuid);
    }
    setSelectedAccounts(newSet);
  };

  // 获取错误状态样式
  const getErrorStatusBadge = (errorStatus?: ErrorStatus) => {
    if (!errorStatus || errorStatus.statusType === 'ok') return null;

    const styles: Record<string, { bg: string; text: string; border: string }> = {
      banned: { bg: 'bg-red-500/20', text: 'text-red-400', border: 'border-red-500/30' },
      quota_exceeded: { bg: 'bg-orange-500/20', text: 'text-orange-400', border: 'border-orange-500/30' },
      expired: { bg: 'bg-yellow-500/20', text: 'text-yellow-400', border: 'border-yellow-500/30' },
      rate_limit: { bg: 'bg-blue-500/20', text: 'text-blue-400', border: 'border-blue-500/30' },
      server_error: { bg: 'bg-purple-500/20', text: 'text-purple-400', border: 'border-purple-500/30' },
      network_error: { bg: 'bg-gray-500/20', text: 'text-gray-400', border: 'border-gray-500/30' },
      unknown: { bg: 'bg-gray-500/20', text: 'text-gray-400', border: 'border-gray-500/30' },
    };

    const style = styles[errorStatus.statusType] || styles.unknown;
    return { ...style, status: errorStatus.status, message: errorStatus.message };
  };

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '--';
    return new Date(dateStr).toLocaleString('zh-CN');
  };

  const formatRelativeTime = (dateStr?: string) => {
    if (!dateStr) return '--';
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}天前`;
    if (hours > 0) return `${hours}小时前`;
    if (minutes > 0) return `${minutes}分钟前`;
    return `${seconds}秒前`;
  };

  const providerTypes = Object.keys(providers);
  const activeAccounts = providers[activeProvider] || [];

  const totalAccounts = activeAccounts.length;
  const healthyAccounts = activeAccounts.filter(a => a.isHealthy).length;
  const totalUsage = activeAccounts.reduce((sum, a) => sum + a.usageCount, 0);
  const totalErrors = activeAccounts.reduce((sum, a) => sum + a.errorCount, 0);

  // 判断账号属于哪个池
  const getAccountPool = (account: ProviderAccount): 'healthy' | 'checking' | 'banned' => {
    if (account.isDisabled || !account.isHealthy) {
      return 'banned';
    }
    if (account.errorCount > 0 && account.isHealthy) {
      return 'checking';
    }
    return 'healthy';
  };

  // 获取池标签样式
  const getPoolBadge = (pool: 'healthy' | 'checking' | 'banned') => {
    switch (pool) {
      case 'healthy':
        return { text: '健康池', className: 'bg-green-500/20 text-green-400 border-green-500/30' };
      case 'checking':
        return { text: '检查池', className: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30' };
      case 'banned':
        return { text: '异常池', className: 'bg-red-500/20 text-red-400 border-red-500/30' };
    }
  };

  // 根据池筛选账号
  const filteredAccounts = activePool === 'all'
    ? activeAccounts
    : activeAccounts.filter(a => getAccountPool(a) === activePool);

  if (loading) {
    return <PageLoadingSkeleton />;
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between animate-fade-in-up">
        <div>
          <h1 className="text-3xl font-bold mb-2">提供商池管理</h1>
          <p className="text-gray-400">管理和监控多账号池</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={loadProviders}
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
      </div>

      {/* Action Buttons */}
      <CardSpotlight>
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => runBatchHealthCheck()}
            disabled={healthChecking}
            className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 rounded-lg font-medium transition-all disabled:opacity-50"
          >
            {healthChecking ? (
              <IconLoader2 className="w-4 h-4 animate-spin" />
            ) : (
              <IconHeartbeat className="w-4 h-4" />
            )}
            <span>{healthChecking ? '检测中...' : '批量健康检测'}</span>
          </button>
          <button
            onClick={() => runBatchHealthCheck('banned')}
            disabled={bannedHealthChecking}
            className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-yellow-500 to-orange-600 hover:from-yellow-600 hover:to-orange-700 rounded-lg font-medium transition-all disabled:opacity-50"
            title="重新检测异常池中的账号，看是否有误判或已恢复的账号"
          >
            {bannedHealthChecking ? (
              <IconLoader2 className="w-4 h-4 animate-spin" />
            ) : (
              <IconAlertTriangle className="w-4 h-4" />
            )}
            <span>{bannedHealthChecking ? '检测中...' : '检查异常池'}</span>
          </button>
          <button
            onClick={resetAllHealth}
            disabled={resettingHealth}
            className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-orange-500 to-red-600 hover:from-orange-600 hover:to-red-700 rounded-lg font-medium transition-all disabled:opacity-50"
          >
            {resettingHealth ? (
              <IconLoader2 className="w-4 h-4 animate-spin" />
            ) : (
              <IconRefresh className="w-4 h-4" />
            )}
            <span>{resettingHealth ? '重置中...' : '重置健康状态'}</span>
          </button>
          <button
            onClick={generateAuthUrl}
            disabled={generatingAuth}
            className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 rounded-lg font-medium transition-all disabled:opacity-50"
          >
            {generatingAuth ? (
              <IconLoader2 className="w-4 h-4 animate-spin" />
            ) : (
              <IconLink className="w-4 h-4" />
            )}
            <span>{generatingAuth ? '生成中...' : '生成授权'}</span>
          </button>

          {/* 分隔线 */}
          <div className="w-px h-8 bg-white/10" />

          {/* 批量删除按钮 */}
          <button
            onClick={batchDeleteAccounts}
            disabled={batchDeleting || selectedAccounts.size === 0}
            className="flex items-center gap-2 px-4 py-2 bg-red-500/20 border border-red-500/30 hover:bg-red-500/30 text-red-400 rounded-lg font-medium transition-all disabled:opacity-50"
          >
            {batchDeleting ? (
              <IconLoader2 className="w-4 h-4 animate-spin" />
            ) : (
              <IconTrash className="w-4 h-4" />
            )}
            <span>删除选中 ({selectedAccounts.size})</span>
          </button>

          {/* 快捷删除：删除所有封禁/额度用尽的 */}
          <button
            onClick={() => batchDeleteByStatus(['banned', 'quota_exceeded'])}
            disabled={batchDeleting}
            className="flex items-center gap-2 px-4 py-2 bg-orange-500/20 border border-orange-500/30 hover:bg-orange-500/30 text-orange-400 rounded-lg font-medium transition-all disabled:opacity-50"
            title="删除所有封禁和额度用尽的账号"
          >
            {batchDeleting ? (
              <IconLoader2 className="w-4 h-4 animate-spin" />
            ) : (
              <IconTrash className="w-4 h-4" />
            )}
            <span>清理异常账号</span>
          </button>
        </div>
      </CardSpotlight>

      {/* Stats Overview */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {/* 健康池 */}
        <div className="animate-scale-in delay-100">
          <div
            onClick={() => setActivePool(activePool === 'healthy' ? 'all' : 'healthy')}
            className={`cursor-pointer transition-all ${activePool === 'healthy' ? 'ring-2 ring-green-500 rounded-xl' : ''}`}
          >
            <CardSpotlight>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-green-500 to-emerald-600 flex items-center justify-center">
                  <IconCheck className="w-5 h-5" />
                </div>
                <div>
                  <p className="text-gray-400 text-xs">健康池</p>
                  <h3 className="text-xl font-bold text-green-400">{poolStats?.healthy ?? healthyAccounts}</h3>
                </div>
              </div>
            </CardSpotlight>
          </div>
        </div>

        {/* 检查池 */}
        <div className="animate-scale-in delay-150">
          <div
            onClick={() => setActivePool(activePool === 'checking' ? 'all' : 'checking')}
            className={`cursor-pointer transition-all ${activePool === 'checking' ? 'ring-2 ring-yellow-500 rounded-xl' : ''}`}
          >
            <CardSpotlight>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-yellow-500 to-orange-600 flex items-center justify-center">
                  <IconHeartbeat className="w-5 h-5" />
                </div>
                <div>
                  <p className="text-gray-400 text-xs">检查池</p>
                  <h3 className="text-xl font-bold text-yellow-400">{poolStats?.checking ?? 0}</h3>
                </div>
              </div>
            </CardSpotlight>
          </div>
        </div>

        {/* 异常池 */}
        <div className="animate-scale-in delay-200">
          <div
            onClick={() => setActivePool(activePool === 'banned' ? 'all' : 'banned')}
            className={`cursor-pointer transition-all ${activePool === 'banned' ? 'ring-2 ring-red-500 rounded-xl' : ''}`}
          >
            <CardSpotlight>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-red-500 to-pink-600 flex items-center justify-center">
                  <IconX className="w-5 h-5" />
                </div>
                <div>
                  <p className="text-gray-400 text-xs">异常池</p>
                  <h3 className="text-xl font-bold text-red-400">{poolStats?.banned ?? 0}</h3>
                </div>
              </div>
            </CardSpotlight>
          </div>
        </div>

        {/* 总账户数 */}
        <div className="animate-scale-in delay-250">
          <div
            onClick={() => setActivePool('all')}
            className={`cursor-pointer transition-all ${activePool === 'all' ? 'ring-2 ring-blue-500 rounded-xl' : ''}`}
          >
            <CardSpotlight>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
                  <IconUser className="w-5 h-5" />
                </div>
                <div>
                  <p className="text-gray-400 text-xs">总账户</p>
                  <h3 className="text-xl font-bold">{poolStats?.total ?? totalAccounts}</h3>
                </div>
              </div>
            </CardSpotlight>
          </div>
        </div>

        {/* 缓存命中率 */}
        <div className="animate-scale-in delay-300">
          <CardSpotlight>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center">
                <IconRefresh className="w-5 h-5" />
              </div>
              <div>
                <p className="text-gray-400 text-xs">缓存命中</p>
                <h3 className="text-xl font-bold text-cyan-400">{poolStats?.cacheHitRate ?? '0%'}</h3>
              </div>
            </div>
          </CardSpotlight>
        </div>

        {/* 总使用/错误 */}
        <div className="animate-scale-in delay-350">
          <CardSpotlight>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
                <IconClock className="w-5 h-5" />
              </div>
              <div>
                <p className="text-gray-400 text-xs">使用/错误</p>
                <h3 className="text-lg font-bold">
                  <span className="text-green-400">{poolStats?.totalUsageCount ?? totalUsage}</span>
                  <span className="text-gray-500">/</span>
                  <span className="text-red-400">{poolStats?.totalErrorCount ?? totalErrors}</span>
                </h3>
              </div>
            </div>
          </CardSpotlight>
        </div>
      </div>

      {/* Provider Type Tabs */}
      <div className="flex gap-4 border-b border-white/10 overflow-x-auto">
        {providerTypes.map(type => {
          const accounts = providers[type] || [];
          const healthy = accounts.filter(a => a.isHealthy).length;
          return (
            <button
              key={type}
              onClick={() => setActiveProvider(type)}
              className={`px-4 py-3 font-medium transition-all whitespace-nowrap ${
                activeProvider === type
                  ? 'text-blue-400 border-b-2 border-blue-400'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              {type}
              <span className="ml-2 px-2 py-0.5 text-xs rounded-full bg-white/10">
                {healthy}/{accounts.length}
              </span>
            </button>
          );
        })}
      </div>

      {/* Accounts Grid */}
      <div className="grid grid-cols-1 gap-6">
        {/* 全选控制栏 */}
        {filteredAccounts.length > 0 && (
          <div className="flex items-center gap-4 px-4 py-2 bg-white/5 rounded-lg border border-white/10">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={selectedAccounts.size === filteredAccounts.length && filteredAccounts.length > 0}
                onChange={toggleSelectAll}
                className="w-4 h-4 rounded border-white/20 bg-white/5 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
              />
              <span className="text-sm text-gray-400">
                全选 ({selectedAccounts.size}/{filteredAccounts.length})
              </span>
            </label>
            {selectedAccounts.size > 0 && (
              <span className="text-sm text-blue-400">
                已选中 {selectedAccounts.size} 个账号
              </span>
            )}
          </div>
        )}

        {filteredAccounts.length === 0 ? (
          <CardSpotlight>
            <div className="text-center py-12">
              <p className="text-gray-400 text-lg">
                {activePool === 'all' ? '暂无账号' : `${activePool === 'healthy' ? '健康池' : activePool === 'checking' ? '检查池' : '异常池'}暂无账号`}
              </p>
              <p className="text-gray-500 text-sm mt-2">
                {activePool !== 'all' && <button onClick={() => setActivePool('all')} className="text-blue-400 hover:underline">查看全部账号</button>}
              </p>
            </div>
          </CardSpotlight>
        ) : (
          filteredAccounts.map((account, index) => {
            const pool = getAccountPool(account);
            const poolBadge = getPoolBadge(pool);
            const originalIndex = activeAccounts.findIndex(a => a.uuid === account.uuid);
            const errorBadge = getErrorStatusBadge(account.errorStatus);
            const isSelected = selectedAccounts.has(account.uuid);
            return (
            <CardSpotlight key={account.uuid} className={isSelected ? 'ring-2 ring-blue-500' : ''}>
              <div className="space-y-4">
                {/* Account Header */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {/* 选择框 */}
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleAccountSelection(account.uuid)}
                      className="w-5 h-5 rounded border-white/20 bg-white/5 text-blue-500 focus:ring-blue-500 focus:ring-offset-0 cursor-pointer"
                    />
                    <h3 className="text-xl font-bold">账号 #{originalIndex + 1}</h3>
                    {/* 池标签 */}
                    <span className={`px-2 py-0.5 text-xs rounded-full border ${poolBadge.className}`}>
                      {poolBadge.text}
                    </span>
                    {/* 错误状态标签（友好提示） */}
                    {errorBadge && (
                      <span className={`px-2 py-0.5 text-xs rounded-full border ${errorBadge.bg} ${errorBadge.text} ${errorBadge.border}`}
                        title={errorBadge.message}>
                        {errorBadge.status}
                      </span>
                    )}
                    {account.isDisabled && (
                      <Badge variant="outline">
                        <IconEyeOff className="w-3 h-3 mr-1" />
                        已禁用
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {/* 测试按钮 */}
                    <button
                      onClick={() => testAccount(activeProvider, account.uuid)}
                      disabled={accountTesting === account.uuid}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 transition-all disabled:opacity-50"
                      title="测试账号"
                    >
                      {accountTesting === account.uuid ? (
                        <IconLoader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <IconPlayerPlay className="w-4 h-4" />
                      )}
                      <span>测试</span>
                    </button>
                    {/* 健康检查按钮 */}
                    <button
                      onClick={() => runHealthCheck(activeProvider, account.uuid)}
                      disabled={accountHealthChecking === account.uuid}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 transition-all disabled:opacity-50"
                      title="健康检查"
                    >
                      {accountHealthChecking === account.uuid ? (
                        <IconLoader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <IconHeartbeat className="w-4 h-4" />
                      )}
                      <span>检测</span>
                    </button>
                    {/* 重置健康状态按钮 */}
                    <button
                      onClick={() => resetAccountHealth(activeProvider, account.uuid)}
                      disabled={accountResetting === account.uuid}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-gradient-to-r from-orange-500 to-red-600 hover:from-orange-600 hover:to-red-700 transition-all disabled:opacity-50"
                      title="重置健康状态"
                    >
                      {accountResetting === account.uuid ? (
                        <IconLoader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <IconRefresh className="w-4 h-4" />
                      )}
                      <span>重置</span>
                    </button>
                    {/* 启用/禁用按钮 */}
                    <button
                      onClick={() => toggleAccountStatus(activeProvider, account.uuid, account.isDisabled)}
                      className="px-3 py-1.5 text-sm rounded-lg border border-white/10 hover:bg-white/5 transition-colors"
                      title={account.isDisabled ? '启用账号' : '禁用账号'}
                    >
                      {account.isDisabled ? <IconEye className="w-4 h-4" /> : <IconEyeOff className="w-4 h-4" />}
                    </button>
                    {/* 删除按钮 */}
                    <button
                      onClick={() => deleteAccount(activeProvider, account.uuid, index)}
                      disabled={accountDeleting === account.uuid}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-red-500/20 border border-red-500/30 hover:bg-red-500/30 text-red-400 transition-all disabled:opacity-50"
                      title="删除账号"
                    >
                      {accountDeleting === account.uuid ? (
                        <IconLoader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <IconTrash className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </div>

                {/* Account Info Grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                  {account.cachedEmail && (
                    <div className="flex items-center gap-3 p-3 rounded-lg bg-white/5">
                      <IconMail className="w-5 h-5 text-blue-400" />
                      <div>
                        <p className="text-xs text-gray-400">邮箱</p>
                        <p className="text-sm font-medium">{account.cachedEmail}</p>
                      </div>
                    </div>
                  )}


                  <div className="flex items-center gap-3 p-3 rounded-lg bg-white/5">
                    <IconClock className="w-5 h-5 text-green-400" />
                    <div>
                      <p className="text-xs text-gray-400">使用次数</p>
                      <p className="text-sm font-medium">{account.usageCount}</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 p-3 rounded-lg bg-white/5">
                    <IconAlertTriangle className="w-5 h-5 text-red-400" />
                    <div>
                      <p className="text-xs text-gray-400">错误次数</p>
                      <p className="text-sm font-medium">{account.errorCount}</p>
                    </div>
                  </div>
                </div>

                {/* Timeline */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                  {account.lastUsed && (
                    <div>
                      <p className="text-gray-400">最后使用</p>
                      <p className="font-medium">{formatRelativeTime(account.lastUsed)}</p>
                      <p className="text-xs text-gray-500">{formatDate(account.lastUsed)}</p>
                    </div>
                  )}

                  {account.lastHealthCheckTime && (
                    <div>
                      <p className="text-gray-400">最后健康检查</p>
                      <p className="font-medium">{formatRelativeTime(account.lastHealthCheckTime)}</p>
                      <p className="text-xs text-gray-500">{formatDate(account.lastHealthCheckTime)}</p>
                    </div>
                  )}

                  {account.lastErrorTime && (
                    <div>
                      <p className="text-gray-400">最后错误</p>
                      <p className="font-medium text-red-400">{formatRelativeTime(account.lastErrorTime)}</p>
                      <p className="text-xs text-gray-500">{formatDate(account.lastErrorTime)}</p>
                    </div>
                  )}
                </div>

                {/* Error Message - 友好显示 */}
                {account.lastErrorMessage && (
                  <div className={`p-3 rounded-lg border ${errorBadge ? `${errorBadge.bg} ${errorBadge.border}` : 'bg-red-500/10 border-red-500/20'}`}>
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-xs text-gray-400">错误信息</p>
                      {errorBadge && (
                        <span className={`px-2 py-0.5 text-xs rounded-full ${errorBadge.bg} ${errorBadge.text} ${errorBadge.border}`}>
                          {errorBadge.status}
                        </span>
                      )}
                    </div>
                    <p className={`text-sm font-medium ${errorBadge?.text || 'text-red-400'}`}>
                      {errorBadge?.message || account.lastErrorMessage}
                    </p>
                    {errorBadge && (
                      <p className="text-xs text-gray-500 mt-1 font-mono">{account.lastErrorMessage}</p>
                    )}
                  </div>
                )}

                {/* File Path */}
                {account.KIRO_OAUTH_CREDS_FILE_PATH && (
                  <div className="p-3 rounded-lg bg-white/5 border border-white/10">
                    <p className="text-xs text-gray-400 mb-1">凭据文件路径</p>
                    <p className="text-sm font-mono text-gray-300">{account.KIRO_OAUTH_CREDS_FILE_PATH}</p>
                  </div>
                )}

                {/* Additional Info */}
                <div className="flex flex-wrap gap-4 text-xs text-gray-400">
                  <div>UUID: <span className="text-gray-300 font-mono">{account.uuid}</span></div>
                  {account.checkModelName && (
                    <div>检查模型: <span className="text-gray-300">{account.checkModelName}</span></div>
                  )}
                  {account.lastHealthCheckModel && (
                    <div>最后检查模型: <span className="text-gray-300">{account.lastHealthCheckModel}</span></div>
                  )}
                </div>
              </div>
            </CardSpotlight>
          )})
        )}
      </div>

      {/* 授权方式选择模态框 */}
      {showAuthMethodModal && (
        <div
          className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 animate-[fadeIn_0.2s_ease-out]"
          onClick={() => setShowAuthMethodModal(false)}
        >
          <div
            className="bg-gray-900 rounded-xl border border-white/10 max-w-lg w-full overflow-hidden animate-[slideUp_0.3s_ease-out]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6 border-b border-white/10">
              <div className="flex items-center justify-between">
                <h3 className="text-xl font-bold flex items-center gap-2">
                  <IconKey className="w-5 h-5 text-blue-400" />
                  Kiro OAuth 授权
                </h3>
                <button
                  onClick={() => setShowAuthMethodModal(false)}
                  className="text-gray-400 hover:text-white"
                >
                  <IconX className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="p-6 space-y-4">
              <h4 className="text-sm font-medium text-gray-300 mb-3">请选择登录方式：</h4>

              {/* GitHub 登录 */}
              <button
                onClick={() => handleSocialAuth('Github')}
                disabled={generatingAuth}
                className="w-full p-4 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 transition-all flex items-center gap-4 text-left group"
              >
                <div className="w-10 h-10 rounded-lg bg-gray-800 flex items-center justify-center">
                  <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                  </svg>
                </div>
                <div className="flex-1">
                  <div className="font-semibold">GitHub 登录</div>
                  <div className="text-sm text-gray-400">使用 GitHub 账号授权登录（需AntiHook）</div>
                </div>
                <IconChevronRight className="w-5 h-5 text-gray-500 group-hover:text-white transition-colors" />
              </button>

              {/* Google 登录 */}
              <button
                onClick={() => handleSocialAuth('Google')}
                disabled={generatingAuth}
                className="w-full p-4 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 transition-all flex items-center gap-4 text-left group"
              >
                <div className="w-10 h-10 rounded-lg bg-white flex items-center justify-center">
                  <svg className="w-5 h-5" viewBox="0 0 24 24">
                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                  </svg>
                </div>
                <div className="flex-1">
                  <div className="font-semibold">Google 登录</div>
                  <div className="text-sm text-gray-400">使用 Google 账号授权登录（需AntiHook）</div>
                </div>
                <IconChevronRight className="w-5 h-5 text-gray-500 group-hover:text-white transition-colors" />
              </button>

              {/* AWS Builder ID 登录 */}
              <button
                onClick={() => {
                  setShowAuthMethodModal(false);
                  setShowAWSAuthModal(true);
                }}
                disabled={generatingAuth}
                className="w-full p-4 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 transition-all flex items-center gap-4 text-left group"
              >
                <div className="w-10 h-10 rounded-lg bg-[#232f3e] flex items-center justify-center">
                  <svg className="w-6 h-6 text-[#FF9900]" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M6.763 10.036c0 .296.032.535.088.71.064.176.144.368.256.576.04.063.056.127.056.183 0 .08-.048.16-.152.24l-.503.335a.383.383 0 0 1-.208.072c-.08 0-.16-.04-.239-.112a2.47 2.47 0 0 1-.287-.375 6.18 6.18 0 0 1-.248-.471c-.622.734-1.405 1.101-2.347 1.101-.67 0-1.205-.191-1.596-.574-.391-.384-.59-.894-.59-1.533 0-.678.239-1.23.726-1.644.487-.415 1.133-.623 1.955-.623.272 0 .551.024.846.064.296.04.6.104.918.176v-.583c0-.607-.127-1.03-.375-1.277-.255-.248-.686-.367-1.3-.367-.28 0-.568.031-.863.103-.295.072-.583.16-.862.272a2.287 2.287 0 0 1-.28.104.488.488 0 0 1-.127.023c-.112 0-.168-.08-.168-.247v-.391c0-.128.016-.224.056-.28a.597.597 0 0 1 .224-.167c.279-.144.614-.264 1.005-.36a4.84 4.84 0 0 1 1.246-.151c.95 0 1.644.216 2.091.647.439.43.662 1.085.662 1.963v2.586zm-3.24 1.214c.263 0 .534-.048.822-.144.287-.096.543-.271.758-.51.128-.152.224-.32.272-.512.047-.191.08-.423.08-.694v-.335a6.66 6.66 0 0 0-.735-.136 6.02 6.02 0 0 0-.75-.048c-.535 0-.926.104-1.19.32-.263.215-.39.518-.39.917 0 .375.095.655.295.846.191.2.47.296.838.296zm6.41.862c-.144 0-.24-.024-.304-.08-.064-.048-.12-.16-.168-.311L7.586 5.55a1.398 1.398 0 0 1-.072-.32c0-.128.064-.2.191-.2h.783c.151 0 .255.025.31.08.065.048.113.16.16.312l1.342 5.284 1.245-5.284c.04-.16.088-.264.151-.312a.549.549 0 0 1 .32-.08h.638c.152 0 .256.025.32.08.063.048.12.16.151.312l1.261 5.348 1.381-5.348c.048-.16.104-.264.16-.312a.52.52 0 0 1 .311-.08h.743c.127 0 .2.065.2.2 0 .04-.009.08-.017.128a1.137 1.137 0 0 1-.056.2l-1.923 6.17c-.048.16-.104.264-.168.312a.52.52 0 0 1-.303.08h-.687c-.151 0-.255-.024-.32-.08-.063-.056-.119-.16-.15-.32l-1.238-5.148-1.23 5.14c-.04.16-.087.264-.15.32-.065.056-.177.08-.32.08zm10.256.215c-.415 0-.83-.048-1.229-.143-.399-.096-.71-.2-.918-.32-.128-.071-.215-.151-.247-.223a.563.563 0 0 1-.048-.224v-.407c0-.167.064-.247.183-.247.048 0 .096.008.144.024.048.016.12.048.2.08.271.12.566.215.878.279.319.064.63.096.95.096.502 0 .894-.088 1.165-.264a.86.86 0 0 0 .415-.758.777.777 0 0 0-.215-.559c-.144-.151-.415-.287-.806-.415l-1.157-.36c-.583-.183-1.013-.454-1.277-.813a1.902 1.902 0 0 1-.4-1.158c0-.335.073-.63.216-.886.144-.255.335-.479.575-.654.24-.184.51-.32.83-.415.32-.096.655-.136 1.006-.136.175 0 .359.008.535.032.183.024.35.056.518.088.16.04.312.08.455.127.144.048.256.096.336.144a.69.69 0 0 1 .24.2.43.43 0 0 1 .071.263v.375c0 .168-.064.256-.184.256a.83.83 0 0 1-.303-.096 3.652 3.652 0 0 0-1.532-.311c-.455 0-.815.071-1.062.223-.248.152-.375.383-.375.71 0 .224.08.416.24.567.159.152.454.304.877.44l1.134.358c.574.184.99.44 1.237.767.247.327.367.702.367 1.117 0 .343-.072.655-.207.926-.144.272-.336.511-.583.703-.248.2-.543.343-.886.447-.36.111-.734.167-1.142.167z"/>
                  </svg>
                </div>
                <div className="flex-1">
                  <div className="font-semibold">AWS Builder ID 登录</div>
                  <div className="text-sm text-gray-400">使用 AWS IAM Identity Center（自动注册Client）</div>
                </div>
                <IconChevronRight className="w-5 h-5 text-gray-500 group-hover:text-white transition-colors" />
              </button>

              {/* 手动导入 */}
              <button
                onClick={() => {
                  setShowAuthMethodModal(false);
                  setShowManualImportModal(true);
                }}
                disabled={generatingAuth}
                className="w-full p-4 rounded-lg border-2 border-green-500/50 bg-gradient-to-r from-green-500/10 to-emerald-500/10 hover:from-green-500/20 hover:to-emerald-500/20 transition-all flex items-center gap-4 text-left group"
              >
                <div className="w-10 h-10 rounded-lg bg-green-500/20 flex items-center justify-center">
                  <IconClipboard className="w-5 h-5 text-green-400" />
                </div>
                <div className="flex-1">
                  <div className="font-semibold text-green-400">手动导入 RefreshToken</div>
                  <div className="text-sm text-gray-400">直接粘贴 refreshToken，无需 OAuth 授权（推荐）</div>
                </div>
                <IconChevronRight className="w-5 h-5 text-gray-500 group-hover:text-green-400 transition-colors" />
              </button>

              {/* 网页模式开关 */}
              <div className="mt-4 p-4 rounded-lg bg-gradient-to-r from-blue-500/10 to-purple-500/10 border border-blue-500/30">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-semibold text-blue-400 flex items-center gap-2">
                      <IconLink className="w-4 h-4" />
                      网页模式（推荐）
                    </div>
                    <p className="text-xs text-gray-400 mt-1">
                      OAuth 直接回调到后端，无需 AntiHook，点击即可完成授权
                    </p>
                  </div>
                  <button
                    onClick={() => setWebMode(!webMode)}
                    className={`relative w-12 h-6 rounded-full transition-colors ${
                      webMode ? 'bg-blue-500' : 'bg-gray-600'
                    }`}
                  >
                    <span
                      className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${
                        webMode ? 'left-7' : 'left-1'
                      }`}
                    />
                  </button>
                </div>
                {!webMode && (
                  <div className="mt-2 p-2 rounded bg-yellow-500/10 border border-yellow-500/30">
                    <p className="text-xs text-yellow-400">
                      AntiHook 模式：需要安装 AntiHook 拦截 kiro:// 协议
                    </p>
                  </div>
                )}
              </div>

              {/* 账号编号输入 */}
              <div className="mt-4 p-4 rounded-lg bg-white/5 border border-white/10">
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  账号编号：
                </label>
                <input
                  type="number"
                  min="1"
                  value={accountNumber}
                  onChange={(e) => setAccountNumber(parseInt(e.target.value) || 1)}
                  className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p className="text-xs text-gray-500 mt-2">
                  Token 文件名: kiro-auth-token-{accountNumber}.json
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 手动导入 RefreshToken 模态框 */}
      {showManualImportModal && (
        <div
          className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 animate-[fadeIn_0.2s_ease-out]"
          onClick={() => setShowManualImportModal(false)}
        >
          <div
            className="bg-gray-900 rounded-xl border border-white/10 max-w-xl w-full overflow-hidden animate-[slideUp_0.3s_ease-out]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6 border-b border-white/10">
              <div className="flex items-center justify-between">
                <h3 className="text-xl font-bold flex items-center gap-2">
                  <IconClipboard className="w-5 h-5 text-green-400" />
                  手动导入 RefreshToken
                </h3>
                <button onClick={() => setShowManualImportModal(false)} className="text-gray-400 hover:text-white">
                  <IconX className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="p-6 space-y-4">
              {/* 信息提示 */}
              <div className="p-4 rounded-lg bg-gradient-to-r from-green-500/10 to-emerald-500/10 border border-green-500/30">
                <div className="flex items-start gap-3">
                  <IconCheck className="w-5 h-5 text-green-400 mt-0.5" />
                  <div>
                    <div className="font-semibold text-green-400">推荐方式 - 无需 OAuth 授权</div>
                    <ul className="text-sm text-gray-400 mt-2 space-y-1">
                      <li>• 直接粘贴 refreshToken，系统自动保存</li>
                      <li>• 永久有效，后端自动刷新 accessToken</li>
                      <li>• 无需每次浏览器授权，无需无痕模式</li>
                    </ul>
                  </div>
                </div>
              </div>

              {/* RefreshToken 输入 */}
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  RefreshToken <span className="text-red-400">*</span>
                </label>
                <textarea
                  value={manualRefreshToken}
                  onChange={(e) => setManualRefreshToken(e.target.value)}
                  placeholder="粘贴 refreshToken (以 aorAAAAAG 开头...)"
                  rows={4}
                  className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 font-mono text-sm resize-none"
                />
                <p className="text-xs text-gray-500 mt-1">从 Kiro IDE 流量拦截或朋友处获取</p>
              </div>

              {/* ProfileArn 输入 */}
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  ProfileArn <span className="text-gray-500">(可选)</span>
                </label>
                <input
                  type="text"
                  value={manualProfileArn}
                  onChange={(e) => setManualProfileArn(e.target.value)}
                  placeholder="arn:aws:codewhisperer:us-east-1:..."
                  className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 font-mono text-sm"
                />
                <p className="text-xs text-gray-500 mt-1">可选，系统会自动获取</p>
              </div>

              {/* 账号编号 */}
              <div className="p-3 rounded-lg bg-white/5 border border-white/10">
                <span className="text-gray-400">账号编号: </span>
                <span className="font-bold text-lg">{accountNumber}</span>
                <p className="text-xs text-gray-500 mt-1">Token 文件: kiro-auth-token-{accountNumber}.json</p>
              </div>

              {/* 获取说明 */}
              <div className="p-4 rounded-lg bg-gradient-to-r from-green-500/5 to-emerald-500/5 border border-green-500/20">
                <div className="font-medium text-green-400 mb-2">如何获取 RefreshToken？</div>
                <div className="text-sm text-gray-400">
                  <div className="font-medium text-white mb-1">最简单：从已有账号复制</div>
                  <p>如果你或朋友已有 Kiro 账号，直接打开 token 文件</p>
                  <p className="mt-1">文件位置: <code className="bg-white/10 px-1.5 py-0.5 rounded text-xs">configs/kiro/kiro-auth-token-*.json</code></p>
                  <p className="mt-1">复制其中的 <code className="bg-white/10 px-1.5 py-0.5 rounded text-xs">refreshToken</code> 字段即可！</p>
                </div>
              </div>
            </div>
            <div className="p-6 border-t border-white/10 flex justify-end gap-3">
              <button
                onClick={() => setShowManualImportModal(false)}
                className="px-4 py-2 rounded-lg border border-white/10 hover:bg-white/5 transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleManualImport}
                disabled={generatingAuth}
                className="px-6 py-2 rounded-lg bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 font-semibold transition-all disabled:opacity-50 flex items-center gap-2"
              >
                {generatingAuth ? (
                  <IconLoader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <IconCheck className="w-4 h-4" />
                )}
                导入并保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* AWS Builder ID 授权模态框 */}
      {showAWSAuthModal && (
        <div
          className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 animate-[fadeIn_0.2s_ease-out]"
          onClick={() => setShowAWSAuthModal(false)}
        >
          <div
            className="bg-gray-900 rounded-xl border border-white/10 max-w-xl w-full overflow-hidden animate-[slideUp_0.3s_ease-out]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6 border-b border-white/10">
              <div className="flex items-center justify-between">
                <h3 className="text-xl font-bold flex items-center gap-2">
                  <svg className="w-5 h-5 text-[#FF9900]" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M6.763 10.036c0 .296.032.535.088.71.064.176.144.368.256.576.04.063.056.127.056.183 0 .08-.048.16-.152.24l-.503.335a.383.383 0 0 1-.208.072c-.08 0-.16-.04-.239-.112a2.47 2.47 0 0 1-.287-.375 6.18 6.18 0 0 1-.248-.471c-.622.734-1.405 1.101-2.347 1.101-.67 0-1.205-.191-1.596-.574-.391-.384-.59-.894-.59-1.533 0-.678.239-1.23.726-1.644.487-.415 1.133-.623 1.955-.623.272 0 .551.024.846.064.296.04.6.104.918.176v-.583c0-.607-.127-1.03-.375-1.277-.255-.248-.686-.367-1.3-.367-.28 0-.568.031-.863.103-.295.072-.583.16-.862.272a2.287 2.287 0 0 1-.28.104.488.488 0 0 1-.127.023c-.112 0-.168-.08-.168-.247v-.391c0-.128.016-.224.056-.28a.597.597 0 0 1 .224-.167c.279-.144.614-.264 1.005-.36a4.84 4.84 0 0 1 1.246-.151c.95 0 1.644.216 2.091.647.439.43.662 1.085.662 1.963v2.586z"/>
                  </svg>
                  AWS Builder ID 授权
                </h3>
                <button onClick={() => setShowAWSAuthModal(false)} className="text-gray-400 hover:text-white">
                  <IconX className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="p-6 space-y-4">
              {/* 授权信息 */}
              <div className="p-4 rounded-lg bg-[#232f3e] border border-[#FF9900]/30">
                <div className="text-sm space-y-1">
                  <div><span className="text-gray-400">账号编号:</span> <span className="font-bold">{accountNumber}</span></div>
                  <div><span className="text-gray-400">Token文件:</span> <code className="text-xs bg-white/10 px-1.5 py-0.5 rounded">kiro-auth-token-{accountNumber}.json</code></div>
                  <div><span className="text-gray-400">认证方式:</span> <span className="font-bold">AWS IAM Identity Center (BuilderId)</span></div>
                </div>
              </div>

              {/* 自动注册提示 */}
              <div className="p-3 rounded-lg bg-gradient-to-r from-[#FF9900]/10 to-[#ec7211]/10 border border-[#FF9900]/30">
                <div className="flex items-center gap-2 text-sm">
                  <IconPlayerPlay className="w-4 h-4 text-[#FF9900]" />
                  <span className="text-[#FF9900] font-medium">自动注册模式</span>
                </div>
                <p className="text-xs text-gray-400 mt-1">系统会自动调用 AWS SSO OIDC API 注册客户端，无需手动输入 Client ID 和 Client Secret！</p>
              </div>

              {/* Start URL 输入 */}
              {!deviceAuthResult && (
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    Start URL <span className="text-gray-500">(可选，通常使用默认值即可)</span>
                  </label>
                  <input
                    type="text"
                    value={awsStartUrl}
                    onChange={(e) => setAwsStartUrl(e.target.value)}
                    placeholder="默认: https://view.awsapps.com/start"
                    className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#FF9900]"
                  />
                </div>
              )}

              {/* 设备授权结果 */}
              {deviceAuthResult && (
                <div className="p-4 rounded-lg bg-green-500/10 border border-green-500/30 space-y-4">
                  <div className="flex items-center gap-2 text-green-400 font-medium">
                    <IconCheck className="w-5 h-5" />
                    设备授权已启动
                  </div>

                  <div>
                    <div className="text-sm text-gray-400 mb-2">用户码:</div>
                    <div className="text-3xl font-bold text-center text-[#FF9900] tracking-widest font-mono p-4 rounded-lg bg-white/5">
                      {deviceAuthResult.userCode}
                    </div>
                  </div>

                  <a
                    href={deviceAuthResult.verificationUriComplete}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block w-full py-3 px-4 rounded-lg bg-gradient-to-r from-[#FF9900] to-[#ec7211] text-white text-center font-semibold hover:opacity-90 transition-opacity"
                  >
                    <IconLink className="w-4 h-4 inline mr-2" />
                    点击打开授权页面
                  </a>

                  <div className="text-sm text-gray-400">
                    <IconClock className="w-4 h-4 inline mr-1" />
                    请在 <span className="font-bold text-white">{Math.floor(deviceAuthResult.expiresIn / 60)} 分钟</span>内完成授权
                  </div>

                  <div className="p-3 rounded-lg bg-white/5 flex items-center gap-2 text-sm text-gray-400">
                    <IconLoader2 className="w-4 h-4 animate-spin text-green-400" />
                    系统正在后台轮询授权状态，完成授权后将自动保存 token...
                  </div>
                </div>
              )}

              {/* 授权步骤 */}
              {!deviceAuthResult && (
                <div>
                  <div className="text-sm font-medium text-gray-300 mb-2">授权步骤：</div>
                  <ol className="text-sm text-gray-400 space-y-1 list-decimal list-inside">
                    <li>点击下方"开始设备授权"按钮</li>
                    <li>系统自动注册客户端并获取用户码</li>
                    <li>在弹出的验证链接中输入用户码</li>
                    <li>使用您的 AWS Builder ID 登录</li>
                    <li>授权成功后 token 自动保存</li>
                  </ol>
                </div>
              )}
            </div>
            <div className="p-6 border-t border-white/10 flex justify-end gap-3">
              <button
                onClick={() => {
                  setShowAWSAuthModal(false);
                  setDeviceAuthResult(null);
                }}
                className="px-4 py-2 rounded-lg border border-white/10 hover:bg-white/5 transition-colors"
              >
                关闭
              </button>
              {!deviceAuthResult && (
                <button
                  onClick={handleAWSDeviceAuth}
                  disabled={generatingAuth}
                  className="px-6 py-2 rounded-lg bg-[#FF9900] hover:bg-[#ec7211] font-semibold transition-all disabled:opacity-50 flex items-center gap-2"
                >
                  {generatingAuth ? (
                    <IconLoader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <IconPlayerPlay className="w-4 h-4" />
                  )}
                  开始设备授权
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 社交登录授权结果模态框 - 紧凑版 */}
      {showSocialAuthModal && authUrl && (
        <div
          className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 animate-[fadeIn_0.2s_ease-out]"
          onClick={() => setShowSocialAuthModal(false)}
        >
          <div
            className="bg-gray-900 rounded-xl border border-white/10 max-w-lg w-full overflow-hidden animate-[slideUp_0.3s_ease-out] max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-4 border-b border-white/10">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-bold flex items-center gap-2">
                  <IconKey className="w-4 h-4 text-blue-400" />
                  {socialAuthProvider} 授权 · 账号 #{accountNumber}
                </h3>
                <button
                  onClick={() => setShowSocialAuthModal(false)}
                  className="text-gray-400 hover:text-white"
                >
                  <IconX className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="p-4 space-y-3">
              {/* 提示信息 */}
              <div className="p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30 text-sm">
                <div className="flex items-center gap-2 text-yellow-400 font-medium mb-1">
                  <IconAlertTriangle className="w-4 h-4" />
                  使用无痕模式登录不同账号
                </div>
                <p className="text-gray-400 text-xs">
                  Chrome/Edge: <kbd className="bg-white/10 px-1 rounded">Ctrl+Shift+N</kbd> ·
                  Firefox: <kbd className="bg-white/10 px-1 rounded">Ctrl+Shift+P</kbd>
                </p>
              </div>

              {/* 授权链接 */}
              <div>
                <label className="block text-xs text-gray-400 mb-1">授权链接：</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    readOnly
                    value={authUrl}
                    className="flex-1 px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-xs font-mono text-green-400 truncate"
                  />
                  <button
                    onClick={copyAuthUrl}
                    className="px-3 py-2 bg-blue-500 hover:bg-blue-600 rounded-lg transition-colors"
                    title="复制链接"
                  >
                    <IconCopy className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* 轮询状态 */}
              <div className="p-2 rounded-lg bg-green-500/10 border border-green-500/30 flex items-center gap-2 text-sm">
                <IconLoader2 className="w-4 h-4 animate-spin text-green-400" />
                <span className="text-green-400">正在自动检测授权完成状态...</span>
              </div>
            </div>
            <div className="p-4 border-t border-white/10 flex gap-2">
              <button
                onClick={copyAndPromptIncognito}
                className="flex-1 px-4 py-2 rounded-lg bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 font-medium transition-all flex items-center justify-center gap-2"
              >
                <IconCopy className="w-4 h-4" />
                复制到无痕
              </button>
              <button
                onClick={openAuthUrl}
                className="px-4 py-2 rounded-lg border border-white/10 hover:bg-white/5 transition-colors flex items-center gap-2"
              >
                <IconExternalLink className="w-4 h-4" />
                打开
              </button>
              <button
                onClick={() => setShowSocialAuthModal(false)}
                className="px-4 py-2 rounded-lg border border-white/10 hover:bg-white/5 transition-colors"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
