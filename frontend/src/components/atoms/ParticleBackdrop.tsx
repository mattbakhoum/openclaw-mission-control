"use client";

import { useEffect, useRef } from "react";

/**
 * Canvas particle drift behind the dashboard. ~80 dots, mouse-influence-free,
 * accent-coral hue. Resizes to viewport. Pauses when document hidden so we
 * don't burn CPU when the tab is in background.
 */
export function ParticleBackdrop() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let running = true;
    let particles: { x: number; y: number; vx: number; vy: number; r: number; a: number }[] = [];

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = canvas.offsetWidth * dpr;
      canvas.height = canvas.offsetHeight * dpr;
      ctx.scale(dpr, dpr);
      ctx.scale(1, 1);
    };

    const seed = () => {
      const n = 80;
      particles = Array.from({ length: n }, () => ({
        x: Math.random() * canvas.offsetWidth,
        y: Math.random() * canvas.offsetHeight,
        vx: (Math.random() - 0.5) * 0.18,
        vy: (Math.random() - 0.5) * 0.12 - 0.04,
        r: Math.random() * 1.2 + 0.4,
        a: Math.random() * 0.4 + 0.15,
      }));
    };

    const draw = () => {
      if (!running) return;
      const w = canvas.offsetWidth;
      const h = canvas.offsetHeight;
      ctx.clearRect(0, 0, w, h);
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < -5) p.x = w + 5;
        if (p.x > w + 5) p.x = -5;
        if (p.y < -5) p.y = h + 5;
        if (p.y > h + 5) p.y = -5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(224, 133, 96, ${p.a})`;
        ctx.fill();
      }
      raf = requestAnimationFrame(draw);
    };

    const onVisibility = () => {
      running = !document.hidden;
      if (running) raf = requestAnimationFrame(draw);
    };

    resize();
    seed();
    raf = requestAnimationFrame(draw);
    window.addEventListener("resize", () => {
      resize();
      seed();
    });
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full opacity-50"
      style={{ mixBlendMode: "screen" }}
    />
  );
}
