'use client';

import Link from 'next/link';
import Image from 'next/image';
import { IconBolt, IconArrowRight } from '@tabler/icons-react';

export default function Home() {
  return (
    <div className="min-h-screen text-white flex items-center justify-center relative overflow-hidden" style={{ backgroundColor: 'var(--fitness-bg)' }}>
      {/* Background Effects */}
      <div className="absolute inset-0 bg-gradient-to-br from-emerald-900/10 via-emerald-700/10 to-[var(--fitness-accent)]/10" />
      <div className="absolute top-20 right-20 w-96 h-96 rounded-full blur-3xl opacity-20 animate-pulse-glow" style={{ backgroundColor: 'var(--fitness-accent)' }} />
      <div className="absolute bottom-20 left-20 w-72 h-72 rounded-full blur-3xl opacity-15 animate-pulse-glow" style={{ backgroundColor: '#10b981', animationDelay: '1s' }} />

      <div className="max-w-4xl mx-auto px-4 text-center space-y-8 relative z-10 animate-fade-in-up">
        {/* Logo */}
        <div className="inline-flex items-center justify-center mb-8">
          <Image
            src="/logo.png"
            alt="Kiro2API Logo"
            width={100}
            height={100}
            className="drop-shadow-2xl"
          />
        </div>

        {/* Title */}
        <h1 className="text-5xl md:text-7xl font-bold tracking-tight">
          Kiro2API
        </h1>

        {/* Description */}
        <p className="text-xl md:text-2xl text-gray-400 max-w-2xl mx-auto">
          现代化的 Kiro OAuth API 服务管理平台
        </p>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-8 max-w-2xl mx-auto mt-16">
          <div className="space-y-2 group cursor-default">
            <div className="text-3xl md:text-4xl font-bold transition-colors group-hover:text-[var(--fitness-accent)]">10+</div>
            <div className="text-sm text-gray-400">AI 模型</div>
          </div>
          <div className="space-y-2 group cursor-default">
            <div className="text-3xl md:text-4xl font-bold transition-colors group-hover:text-[var(--fitness-accent)]">99.9%</div>
            <div className="text-sm text-gray-400">可用性</div>
          </div>
          <div className="space-y-2 group cursor-default">
            <div className="text-3xl md:text-4xl font-bold transition-colors group-hover:text-[var(--fitness-accent)]">24/7</div>
            <div className="text-sm text-gray-400">在线支持</div>
          </div>
        </div>

        {/* CTA Button */}
        <div className="flex flex-col sm:flex-row gap-4 justify-center mt-16">
          <Link
            href="/dashboard"
            className="group relative inline-flex items-center justify-center px-8 py-3 rounded-lg font-semibold ease-smooth transition-all duration-200 hover:scale-105 active:scale-95 overflow-hidden"
            style={{
              background: `linear-gradient(135deg, var(--fitness-accent), #10b981, var(--fitness-accent))`,
              boxShadow: '0 4px 20px rgba(0, 217, 163, 0.3)',
            }}
          >
            {/* Shimmer effect */}
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full group-hover:translate-x-full ease-smooth transition-transform duration-1000" />

            <span className="relative z-10 flex items-center gap-2">
              进入控制台
              <IconArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
            </span>
          </Link>
        </div>

        {/* Footer */}
        <div className="mt-24 text-sm text-gray-500">
          © 2025 Kiro2API. All rights reserved.
        </div>
      </div>
    </div>
  );
}
