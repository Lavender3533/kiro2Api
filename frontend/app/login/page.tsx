'use client';

import { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { IconBolt, IconEye, IconEyeOff, IconLogin, IconSparkles, IconShield, IconWorld, IconChartBar } from '@tabler/icons-react';
import dynamic from 'next/dynamic';

const Hyperspeed = dynamic(() => import('@/components/Hyperspeed'), { ssr: false });

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [glowPosition, setGlowPosition] = useState({ x: 50, y: 50 });
  const [isHovering, setIsHovering] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    setGlowPosition({ x, y });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ password }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        localStorage.setItem('authToken', data.token);
        router.push('/dashboard');
      } else {
        setError(data.message || '密码错误，请重试');
        setPassword('');
      }
    } catch (err) {
      setError('登录失败，请检查网络连接');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex relative overflow-hidden">
      {/* Unified background for both sides */}
      <div className="absolute inset-0" style={{
        background: 'radial-gradient(ellipse 120% 100% at 35% 50%, rgba(6, 95, 70, 0.3) 0%, rgba(10, 20, 16, 1) 100%)'
      }} />

      {/* Left Side - Animated Background (65%) */}
      <div className="hidden lg:flex lg:w-[65%] relative overflow-hidden">
        {/* 3D Hyperspeed Background */}
        <div className="absolute inset-0 opacity-25">
          <Hyperspeed />
        </div>

        {/* Gradient Overlay */}
        <div className="absolute inset-0 bg-gradient-to-br from-emerald-900/10 via-transparent to-transparent pointer-events-none" />

        {/* Content */}
        <div className="relative z-10 flex flex-col px-20 pt-16">
          <div className="animate-fade-in-up">
            <div className="flex items-center gap-4">
              <Image
                src="/logo.png"
                alt="Kiro2API Logo"
                width={56}
                height={56}
                className="drop-shadow-lg"
              />
              <h1 className="text-3xl font-bold text-white">Kiro2API</h1>
            </div>
          </div>

          {/* Floating particles */}
          <div className="absolute inset-0 overflow-hidden pointer-events-none">
            {[...Array(20)].map((_, i) => (
              <div
                key={i}
                className="absolute w-1 h-1 rounded-full"
                style={{
                  backgroundColor: i % 3 === 0 ? 'var(--g1)' : i % 3 === 1 ? 'var(--g2)' : 'var(--fitness-accent)',
                  left: `${Math.random() * 100}%`,
                  top: `${Math.random() * 100}%`,
                  animation: `float ${5 + Math.random() * 10}s ease-in-out infinite`,
                  animationDelay: `${Math.random() * 5}s`,
                  opacity: 0.3,
                }}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Right Side - Login Form (35%) */}
      <div className="w-full lg:w-[35%] flex items-center justify-center p-8 relative">
        {/* Mobile background */}
        <div className="lg:hidden absolute inset-0 bg-gradient-to-br from-emerald-900/10 via-emerald-700/10 to-[var(--fitness-accent)]/10" />

        <div className="w-full max-w-md relative z-10 animate-scale-in">
          {/* Login Card with border glow */}
          <div
            ref={cardRef}
            onMouseMove={handleMouseMove}
            onMouseEnter={() => setIsHovering(true)}
            onMouseLeave={() => setIsHovering(false)}
            className="rounded-2xl p-[1px] relative"
            style={{
              background: isHovering
                ? `radial-gradient(400px circle at ${glowPosition.x}% ${glowPosition.y}%, rgba(0, 217, 163, 0.4), transparent 40%)`
                : 'transparent',
            }}
          >
            {/* Inner card */}
            <div
              className="rounded-2xl border p-8 backdrop-blur-2xl relative"
              style={{
                backgroundColor: 'rgba(22, 22, 22, 0.8)',
                borderColor: 'rgba(255, 255, 255, 0.1)',
                boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
              }}
            >
            {/* Mobile Logo */}
            <div className="lg:hidden text-center mb-8">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-4"
                style={{ backgroundColor: 'var(--fitness-accent-dim)' }}>
                <IconBolt className="w-8 h-8" style={{ color: 'var(--fitness-accent)' }} />
              </div>
              <h1 className="text-2xl font-bold text-white">Kiro2API</h1>
            </div>

            <div className="mb-8">
              <h2 className="text-2xl font-bold text-white mb-2">登录</h2>
              <p className="text-sm text-gray-500">请输入密码以访问控制台</p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-6">
              {/* Password Input */}
              <div>
                <label htmlFor="password" className="block text-sm font-medium text-gray-400 mb-2">
                  密码
                </label>
                <div className="relative group">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    id="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full px-4 py-3 rounded-lg border bg-black/30 text-white placeholder-gray-600 focus:outline-none ease-smooth transition-all relative z-10"
                    style={{
                      borderColor: 'var(--fitness-border)',
                    }}
                    placeholder="请输入密码"
                    required
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 ease-smooth transition-colors z-20"
                  >
                    {showPassword ? <IconEyeOff className="w-5 h-5" /> : <IconEye className="w-5 h-5" />}
                  </button>

                  {/* Subtle focus glow */}
                  <div
                    className="absolute inset-0 rounded-lg opacity-0 group-focus-within:opacity-100 ease-smooth transition-opacity pointer-events-none"
                    style={{
                      boxShadow: '0 0 15px rgba(0, 217, 163, 0.3), 0 0 30px rgba(0, 217, 163, 0.1)',
                      border: '1px solid var(--fitness-accent)'
                    }}
                  />
                </div>

                {error && (
                  <div className="mt-2 flex items-center gap-2 text-sm text-red-400 animate-fade-in">
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                    </svg>
                    {error}
                  </div>
                )}
              </div>

              {/* Submit Button */}
              <button
                type="submit"
                disabled={loading}
                className="w-full py-3 px-4 rounded-lg font-semibold text-white flex items-center justify-center gap-2 ease-smooth transition-all duration-200 hover:scale-[1.02] active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100 relative overflow-hidden group"
                style={{
                  background: `linear-gradient(135deg, var(--fitness-accent), #10b981, var(--fitness-accent))`,
                  boxShadow: '0 4px 20px rgba(0, 217, 163, 0.2)',
                }}
              >
                {/* Shimmer effect */}
                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full group-hover:translate-x-full ease-smooth transition-transform duration-1000" />

                <span className="relative z-10 flex items-center gap-2">
                  {loading ? (
                    <>
                      <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      登录中...
                    </>
                  ) : (
                    <>
                      <IconLogin className="w-5 h-5" />
                      登录
                    </>
                  )}
                </span>

                {/* Glow effect */}
                <div className="absolute inset-0 rounded-lg opacity-0 group-hover:opacity-50 blur-xl ease-smooth transition-opacity -z-10"
                  style={{ background: `linear-gradient(135deg, var(--g1), var(--g2), var(--fitness-accent))` }} />
              </button>
            </form>

            {/* Divider */}
            <div className="relative my-6">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t" style={{ borderColor: 'var(--fitness-border)' }} />
              </div>
              <div className="relative flex justify-center text-xs">
                <span className="px-2 text-gray-600" style={{ backgroundColor: 'var(--fitness-card)' }}>
                  v1.0.0
                </span>
              </div>
            </div>

            {/* Footer */}
            <div className="text-center space-y-3">
              <div className="flex items-center justify-center gap-2 text-xs text-gray-600">
                <IconSparkles className="w-4 h-4" style={{ color: 'var(--fitness-accent)' }} />
                <span>支持 OpenAI & Claude 协议</span>
              </div>
              <p className="text-xs text-gray-700">© 2025 Kiro2API. All rights reserved.</p>
            </div>
          </div>
          </div>
        </div>
      </div>

      <style jsx global>{`
        @keyframes float {
          0%, 100% {
            transform: translateY(0) translateX(0);
          }
          25% {
            transform: translateY(-20px) translateX(10px);
          }
          50% {
            transform: translateY(-10px) translateX(-10px);
          }
          75% {
            transform: translateY(-30px) translateX(5px);
          }
        }
        @keyframes spin {
          from {
            transform: rotate(0deg);
          }
          to {
            transform: rotate(360deg);
          }
        }
      `}</style>
    </div>
  );
}
