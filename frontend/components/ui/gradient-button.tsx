'use client';

import { ButtonHTMLAttributes } from 'react';

interface GradientButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'success' | 'danger';
  children: React.ReactNode;
}

export function GradientButton({
  variant = 'primary',
  className = '',
  children,
  ...props
}: GradientButtonProps) {
  const variants = {
    primary: 'from-[var(--g1)] via-[var(--g2)] to-[var(--g1)] hover:from-[var(--g1)]/90 hover:via-[var(--g2)]/90 hover:to-[var(--g1)]/90',
    secondary: 'from-gray-600 via-gray-700 to-gray-800 hover:from-gray-500 hover:via-gray-600 hover:to-gray-700',
    success: 'from-[var(--fitness-accent)] via-emerald-500 to-teal-500 hover:from-[var(--fitness-accent)]/90 hover:via-emerald-600 hover:to-teal-600',
    danger: 'from-red-500 via-pink-500 to-rose-500 hover:from-red-600 hover:via-pink-600 hover:to-rose-600',
  };

  return (
    <button
      className={`
        group relative overflow-hidden rounded-full px-8 py-3.5 font-bold text-white tracking-tight
        bg-gradient-to-r ${variants[variant]}
        ease-smooth transition-all duration-200
        hover:scale-105 hover:shadow-2xl
        active:scale-95
        disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100
        ${className}
      `}
      {...props}
    >
      {/* Shimmer effect */}
      <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent -translate-x-full group-hover:translate-x-full ease-smooth transition-transform duration-1000" />

      {/* Button content */}
      <span className="relative z-10 flex items-center gap-2 justify-center">
        {children}
      </span>

      {/* Glow effect */}
      <div className={`absolute inset-0 bg-gradient-to-r ${variants[variant]} blur-xl opacity-0 group-hover:opacity-60 ease-smooth transition-opacity duration-200 -z-10`} />

      {/* Subtle border highlight */}
      <div className="absolute inset-0 rounded-full border border-white/10 group-hover:border-white/20 ease-smooth transition-all duration-200" />
    </button>
  );
}
