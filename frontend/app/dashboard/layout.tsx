'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import {
  IconChartPie,
  IconSettings,
  IconServer,
  IconKey,
  IconChartLine,
  IconTerminal,
  IconLogout,
  IconBolt,
} from '@tabler/icons-react';
import { ToastProvider } from '@/components/ui/toast';

const navItems = [
  { href: '/dashboard', icon: IconChartPie, label: '仪表盘' },
  { href: '/dashboard/config', icon: IconSettings, label: '配置管理' },
  { href: '/dashboard/providers', icon: IconServer, label: '提供商池' },
  { href: '/dashboard/credentials', icon: IconKey, label: '凭据文件' },
  { href: '/dashboard/usage', icon: IconChartLine, label: '用量统计' },
  { href: '/dashboard/logs', icon: IconTerminal, label: '运行日志' },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem('authToken');
    if (!token) {
      window.location.href = '/login.html';
    } else {
      setIsAuthenticated(true);
    }
  }, []);

  const handleLogout = () => {
    localStorage.removeItem('authToken');
    window.location.href = '/login.html';
  };

  if (!isAuthenticated) {
    return null;
  }

  return (
    <ToastProvider>
      <div className="min-h-screen text-white" style={{ backgroundColor: 'var(--fitness-bg)' }}>
        {/* Header - 固定在顶部 */}
        <header className="border-b sticky top-0 z-50" style={{ borderColor: 'var(--fitness-border)', backgroundColor: 'var(--fitness-bg)' }}>
        <div className="px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Image
              src="/logo.png"
              alt="Kiro2API Logo"
              width={40}
              height={40}
              className="drop-shadow-md"
            />
            <div>
              <h1 className="text-lg font-bold tracking-tight text-white">
                Kiro2API
              </h1>
              <p className="text-xs text-gray-600">AI Proxy Dashboard</p>
            </div>
          </div>

          {/* Right side actions */}
          <div className="flex items-center gap-3">
            <button className="w-9 h-9 rounded-lg flex items-center justify-center text-gray-500 hover:text-gray-300 hover:bg-white/[0.05] ease-smooth transition-all duration-200">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
              </svg>
            </button>
            <button className="w-9 h-9 rounded-lg flex items-center justify-center text-gray-500 hover:text-gray-300 hover:bg-white/[0.05] ease-smooth transition-all duration-200">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      <div className="flex">
        {/* Sidebar - 固定不滚动 */}
        <aside className="w-64 border-r h-[calc(100vh-73px)] sticky top-[73px] flex flex-col overflow-y-auto" style={{ borderColor: 'var(--fitness-border)', backgroundColor: 'var(--fitness-bg)' }}>
          <div className="flex-1 p-5">
            {/* Main Menu Section */}
            <div className="mb-6">
              <div className="flex items-center justify-between mb-3 px-1 animate-slide-in-left delay-100">
                <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wider">主菜单</h3>
                <button className="w-5 h-5 text-gray-700 hover:text-gray-500 ease-smooth transition-colors">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                  </svg>
                </button>
              </div>
              <nav className="space-y-1">
                {navItems.map((item, index) => {
                  const Icon = item.icon;
                  const isActive = pathname === item.href;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={`group relative flex items-center gap-3 px-3 py-2.5 rounded-xl ease-smooth transition-all duration-200 animate-slide-in-left ${
                        isActive
                          ? 'text-white'
                          : 'text-gray-500 hover:text-gray-300'
                      }`}
                      style={{
                        animationDelay: `${(index + 2) * 50}ms`,
                      }}
                    >
                      {/* Active state with depth effect */}
                      {isActive && (
                        <>
                          {/* Outer shadow/glow */}
                          <div
                            className="absolute inset-0 rounded-xl blur-md opacity-30"
                            style={{ backgroundColor: 'var(--fitness-accent)' }}
                          />
                          {/* Main background with inset effect */}
                          <div
                            className="absolute inset-0 rounded-xl"
                            style={{
                              backgroundColor: 'rgba(255, 255, 255, 0.08)',
                              boxShadow: 'inset 0 2px 4px rgba(0, 0, 0, 0.3), inset 0 -1px 2px rgba(255, 255, 255, 0.05)',
                            }}
                          />
                          {/* Inner highlight */}
                          <div
                            className="absolute top-0 left-0 right-0 h-px rounded-t-xl opacity-30"
                            style={{ backgroundColor: 'rgba(255, 255, 255, 0.1)' }}
                          />
                        </>
                      )}

                      {/* Hover effect for inactive items */}
                      {!isActive && (
                        <div className="absolute inset-0 rounded-xl bg-white/0 group-hover:bg-white/[0.03] ease-smooth transition-all duration-200" />
                      )}

                      <Icon
                        className="w-5 h-5 relative z-10 ease-smooth transition-all duration-200 group-hover:scale-105"
                        style={isActive ? { strokeWidth: 2.5 } : { strokeWidth: 2 }}
                      />
                      <span className="relative z-10 font-medium text-sm">{item.label}</span>
                    </Link>
                  );
                })}
              </nav>
            </div>

            {/* Settings Section */}
            <div className="animate-slide-in-left delay-500">
              <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wider mb-3 px-1">设置与帮助</h3>
              <button
                onClick={handleLogout}
                className="w-full group flex items-center gap-3 px-3 py-2.5 rounded-lg text-gray-500 hover:text-gray-300 ease-smooth transition-all duration-200 hover:bg-white/[0.03] relative"
              >
                <div className="absolute inset-0 rounded-lg bg-white/0 group-hover:bg-white/[0.03] ease-smooth transition-all duration-200" />
                <IconLogout className="w-5 h-5 relative z-10 ease-smooth transition-transform duration-200 group-hover:rotate-12" style={{ strokeWidth: 2 }} />
                <span className="relative z-10 font-medium text-sm">登出</span>
              </button>
            </div>
          </div>
        </aside>

        {/* Main Content - 可滚动区域 */}
        <main className="flex-1 p-6 min-h-[calc(100vh-73px)]">{children}</main>
      </div>
    </div>
    </ToastProvider>
  );
}
