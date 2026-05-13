"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  value: number | null;
  duration?: number; // ms
  format?: (n: number) => string;
  className?: string;
};

const defaultFormat = (n: number) => n.toLocaleString();

/**
 * Counts up from 0 → value on mount, and tweens to new values on changes.
 * Uses easeOutCubic so the last 20% feels luxurious instead of linear.
 */
export function AnimatedCounter({ value, duration = 900, format = defaultFormat, className }: Props) {
  const [display, setDisplay] = useState(0);
  const fromRef = useRef(0);
  const startedRef = useRef<number | null>(null);

  useEffect(() => {
    if (value === null) return;
    fromRef.current = display;
    startedRef.current = null;

    let raf: number;
    const step = (t: number) => {
      if (startedRef.current === null) startedRef.current = t;
      const elapsed = t - startedRef.current;
      const p = Math.min(1, elapsed / duration);
      // easeOutCubic
      const eased = 1 - Math.pow(1 - p, 3);
      const next = Math.round(fromRef.current + (value - fromRef.current) * eased);
      setDisplay(next);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, duration]);

  if (value === null) return <span className={className}>…</span>;
  return <span className={className}>{format(display)}</span>;
}
