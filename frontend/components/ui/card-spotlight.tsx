'use client';

import React, { useRef, useState, useEffect } from 'react';

export function CardSpotlight({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  const divRef = useRef<HTMLDivElement>(null);
  const [isFocused, setIsFocused] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [opacity, setOpacity] = useState(0);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!divRef.current || isFocused) return;

    const div = divRef.current;
    const rect = div.getBoundingClientRect();

    setPosition({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  const handleFocus = () => {
    setIsFocused(true);
    setOpacity(1);
  };

  const handleBlur = () => {
    setIsFocused(false);
    setOpacity(0);
  };

  const handleMouseEnter = () => {
    setOpacity(1);
  };

  const handleMouseLeave = () => {
    setOpacity(0);
  };

  return (
    <div
      ref={divRef}
      onMouseMove={handleMouseMove}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className={`group relative overflow-hidden rounded-xl border ease-smooth transition-all duration-300 p-6 ${className}`}
      style={{
        backgroundColor: 'var(--fitness-card)',
        borderColor: 'var(--fitness-border)',
        boxShadow: '0 4px 24px rgba(0, 0, 0, 0.4)',
      }}
    >
      {/* Hover state background change */}
      <div
        className="absolute inset-0 opacity-0 group-hover:opacity-100 ease-smooth transition-opacity duration-300 -z-10"
        style={{ backgroundColor: 'var(--fitness-card-hover)' }}
      />

      {/* Green accent glow on hover */}
      <div
        className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-500 blur-2xl -z-20"
        style={{ backgroundColor: 'var(--fitness-accent-dim)' }}
      />

      {/* Spotlight effect with green tint */}
      <div
        className="pointer-events-none absolute -inset-px opacity-0 ease-smooth transition-opacity duration-300 rounded-xl"
        style={{
          opacity,
          background: `radial-gradient(600px circle at ${position.x}px ${position.y}px, rgba(0, 217, 163, 0.08), rgba(0, 217, 163, 0.03), transparent 50%)`,
        }}
      />

      {/* Subtle top border highlight */}
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-white/[0.03] to-transparent" />

      {/* Green accent line on hover */}
      <div
        className="absolute left-0 top-0 bottom-0 w-[2px] rounded-full opacity-0 group-hover:opacity-100 ease-smooth transition-opacity duration-500"
        style={{
          background: `linear-gradient(to bottom, transparent, var(--fitness-accent), transparent)`,
        }}
      />

      <div className="relative z-10">{children}</div>
    </div>
  );
}
