'use client';

import { useEffect, useState } from 'react';
import {
  IconFile,
  IconTrash,
  IconEye,
  IconRefresh,
  IconSearch,
  IconCheck,
  IconX,
  IconKey,
  IconLock,
  IconFileText,
  IconLoader2
} from '@tabler/icons-react';
import { CardSpotlight } from '@/components/ui/card-spotlight';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/toast';
import { PageLoadingSkeleton } from '@/components/ui/skeleton';

interface CredentialFile {
  name: string;
  path: string;
  size: number;
  modified: string;
  type: string;
  isUsed: boolean;
  usedBy?: string[];
}

export default function CredentialsPage() {
  const toast = useToast();
  const [credentials, setCredentials] = useState<CredentialFile[]>([]);
  const [filteredCredentials, setFilteredCredentials] = useState<CredentialFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'used' | 'unused'>('all');
  const [selectedFile, setSelectedFile] = useState<CredentialFile | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    loadCredentials();
  }, []);

  useEffect(() => {
    filterCredentials();
  }, [credentials, searchTerm, statusFilter]);

  const loadCredentials = async () => {
    setRefreshing(true);
    const startTime = Date.now();
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch('/api/upload-configs', {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });
      if (response.ok) {
        const data = await response.json();
        setCredentials(data);
      }
    } catch (error) {
      console.error('Failed to load credentials:', error);
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

  const filterCredentials = () => {
    let filtered = credentials;

    if (searchTerm) {
      filtered = filtered.filter(cred =>
        cred.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        cred.path.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }

    if (statusFilter !== 'all') {
      filtered = filtered.filter(cred =>
        statusFilter === 'used' ? cred.isUsed : !cred.isUsed
      );
    }

    setFilteredCredentials(filtered);
  };

  const viewFile = async (file: CredentialFile) => {
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch(`/api/upload-configs/view/${encodeURIComponent(file.path)}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });
      if (response.ok) {
        const data = await response.json();
        setFileContent(data.content || JSON.stringify(data, null, 2));
        setSelectedFile(file);
        setShowModal(true);
      }
    } catch (error) {
      console.error('Failed to load file content:', error);
      toast.error('加载失败', '加载文件内容失败');
    }
  };

  const deleteFile = async (filePath: string) => {
    if (!confirm('确定要删除此文件吗？此操作不可撤销。')) {
      return;
    }

    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch(`/api/upload-configs/delete/${encodeURIComponent(filePath)}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (response.ok) {
        await loadCredentials();
        toast.success('删除成功', '文件已删除');
      }
    } catch (error) {
      console.error('Failed to delete file:', error);
      toast.error('删除失败');
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString('zh-CN');
  };

  const getFileTypeIcon = (type: string) => {
    switch (type) {
      case 'oauth':
        return <IconKey className="w-5 h-5 text-blue-400" />;
      case 'api-key':
        return <IconLock className="w-5 h-5 text-green-400" />;
      case 'system-prompt':
        return <IconFileText className="w-5 h-5 text-purple-400" />;
      default:
        return <IconFile className="w-5 h-5 text-gray-400" />;
    }
  };

  const totalFiles = credentials.length;
  const usedFiles = credentials.filter(c => c.isUsed).length;
  const unusedFiles = totalFiles - usedFiles;
  const totalSize = credentials.reduce((sum, c) => sum + c.size, 0);

  if (loading) {
    return <PageLoadingSkeleton />;
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between animate-fade-in-up">
        <div>
          <h1 className="text-3xl font-bold mb-2">凭据文件管理</h1>
          <p className="text-gray-400">管理 OAuth 凭据和配置文件</p>
        </div>
        <button
          onClick={loadCredentials}
          disabled={refreshing}
          className="flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 rounded-lg font-semibold transition-all duration-200 hover:shadow-lg hover:shadow-purple-500/50 disabled:opacity-50"
        >
          {refreshing ? (
            <IconLoader2 className="w-5 h-5 animate-spin" />
          ) : (
            <IconRefresh className="w-5 h-5" />
          )}
          <span>{refreshing ? '刷新中...' : '刷新列表'}</span>
        </button>
      </div>

      {/* Stats Overview */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <div className="animate-scale-in delay-100">
          <CardSpotlight>
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
                <IconFile className="w-6 h-6" />
              </div>
              <div>
                <p className="text-gray-400 text-sm">总文件数</p>
                <h3 className="text-2xl font-bold">{totalFiles}</h3>
              </div>
            </div>
          </CardSpotlight>
        </div>

        <div className="animate-scale-in delay-200">
          <CardSpotlight>
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-green-500 to-emerald-600 flex items-center justify-center">
                <IconCheck className="w-6 h-6" />
              </div>
              <div>
                <p className="text-gray-400 text-sm">已使用</p>
                <h3 className="text-2xl font-bold">{usedFiles}</h3>
              </div>
            </div>
          </CardSpotlight>
        </div>

        <div className="animate-scale-in delay-300">
          <CardSpotlight>
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-orange-500 to-red-600 flex items-center justify-center">
                <IconX className="w-6 h-6" />
              </div>
              <div>
                <p className="text-gray-400 text-sm">未使用</p>
                <h3 className="text-2xl font-bold">{unusedFiles}</h3>
              </div>
            </div>
          </CardSpotlight>
        </div>

        <div className="animate-scale-in delay-400">
          <CardSpotlight>
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-pink-500 to-purple-600 flex items-center justify-center">
                <IconFile className="w-6 h-6" />
              </div>
              <div>
                <p className="text-gray-400 text-sm">总大小</p>
                <h3 className="text-2xl font-bold">{formatFileSize(totalSize)}</h3>
              </div>
            </div>
          </CardSpotlight>
        </div>
      </div>

      {/* Search and Filter */}
      <CardSpotlight>
        <div className="flex flex-col md:flex-row gap-4">
          <div className="flex-1 relative">
            <IconSearch className="w-5 h-5 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="搜索文件名或路径..."
              className="w-full pl-10 pr-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setStatusFilter('all')}
              className={`px-4 py-2 rounded-lg transition-all ${
                statusFilter === 'all'
                  ? 'bg-blue-500 text-white'
                  : 'bg-white/5 hover:bg-white/10'
              }`}
            >
              全部
            </button>
            <button
              onClick={() => setStatusFilter('used')}
              className={`px-4 py-2 rounded-lg transition-all ${
                statusFilter === 'used'
                  ? 'bg-green-500 text-white'
                  : 'bg-white/5 hover:bg-white/10'
              }`}
            >
              已使用
            </button>
            <button
              onClick={() => setStatusFilter('unused')}
              className={`px-4 py-2 rounded-lg transition-all ${
                statusFilter === 'unused'
                  ? 'bg-orange-500 text-white'
                  : 'bg-white/5 hover:bg-white/10'
              }`}
            >
              未使用
            </button>
          </div>
        </div>
      </CardSpotlight>

      {/* Files List */}
      <div className="grid grid-cols-1 gap-4">
        {filteredCredentials.length === 0 ? (
          <CardSpotlight>
            <div className="text-center py-12">
              <p className="text-gray-400 text-lg">暂无凭据文件</p>
              <p className="text-gray-500 text-sm mt-2">请上传 OAuth 凭据文件</p>
            </div>
          </CardSpotlight>
        ) : (
          filteredCredentials.map((file) => (
            <CardSpotlight key={file.path}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4 flex-1">
                  {getFileTypeIcon(file.type)}
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold">{file.name}</h3>
                      {file.isUsed ? (
                        <Badge variant="default" className="bg-green-500">
                          <IconCheck className="w-3 h-3 mr-1" />
                          已使用
                        </Badge>
                      ) : (
                        <Badge variant="outline">
                          未使用
                        </Badge>
                      )}
                    </div>
                    <p className="text-sm text-gray-400 truncate max-w-lg" title={file.path}>
                      {file.path}
                    </p>
                    <div className="flex items-center gap-4 text-xs text-gray-500 mt-1">
                      <span>{formatFileSize(file.size)}</span>
                      <span>{formatDate(file.modified)}</span>
                      {file.usedBy && file.usedBy.length > 0 && (
                        <span className="text-blue-400">
                          关联: {file.usedBy.join(', ')}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => viewFile(file)}
                    className="px-3 py-1.5 text-sm rounded-lg border border-white/10 hover:bg-white/5 transition-colors flex items-center gap-1"
                  >
                    <IconEye className="w-4 h-4" />
                    查看
                  </button>
                  <button
                    onClick={() => deleteFile(file.path)}
                    className="px-3 py-1.5 text-sm rounded-lg border border-red-500/50 text-red-400 hover:bg-red-500/10 transition-colors flex items-center gap-1"
                  >
                    <IconTrash className="w-4 h-4" />
                    删除
                  </button>
                </div>
              </div>
            </CardSpotlight>
          ))
        )}
      </div>

      {/* View Modal */}
      {showModal && selectedFile && (
        <div
          className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4"
          onClick={() => setShowModal(false)}
        >
          <div
            className="bg-gray-900 rounded-xl border border-white/10 max-w-4xl w-full max-h-[80vh] overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6 border-b border-white/10">
              <div className="flex items-center justify-between">
                <h3 className="text-xl font-bold">{selectedFile.name}</h3>
                <button
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 rounded-lg border border-white/10 hover:bg-white/5 transition-colors"
                >
                  关闭
                </button>
              </div>
              <p className="text-sm text-gray-400 mt-1">{selectedFile.path}</p>
            </div>
            <div className="p-6 overflow-y-auto max-h-[calc(80vh-120px)]">
              <pre className="bg-black/50 p-4 rounded-lg border border-white/10 overflow-x-auto">
                <code className="text-sm text-green-400 font-mono">
                  {fileContent}
                </code>
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
