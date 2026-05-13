"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { LineChart, Line, ResponsiveContainer } from "recharts";
import { ArrowRight, Database, Microscope, Newspaper, Sparkles } from "lucide-react";

import { AnimatedCounter } from "@/components/atoms/AnimatedCounter";
import { ConstellationThumb } from "@/components/organisms/ConstellationThumb";

type SparkPoint = { i: number; v: number };

type Tile = {
  label: string;
  numericValue: number | null;
  formatValue?: (n: number) => string;
  delta?: string;
  deltaTone?: "up" | "down" | "neutral";
  icon: typeof Database;
  href?: string;
  spark?: SparkPoint[];
  accent: string;
};

function syntheticSpark(seed: number, len = 18, slope = 0): SparkPoint[] {
  // Deterministic pseudo-random so the spark doesn't twitch between renders.
  let s = seed;
  const out: SparkPoint[] = [];
  for (let i = 0; i < len; i++) {
    s = (s * 9301 + 49297) % 233280;
    const r = s / 233280;
    out.push({ i, v: 50 + i * slope + (r - 0.5) * 20 });
  }
  return out;
}

export function DashboardHero() {
  // Memory chunk count from the constellation.json snapshot (cheap proxy).
  const [memoryTotal, setMemoryTotal] = useState<number | null>(null);
  const [memoryProjects, setMemoryProjects] = useState<number | null>(null);
  // Atlas (non-memory corpus) count from sort_atlas.json — may be 0 placeholder.
  const [atlasTotal, setAtlasTotal] = useState<number | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    fetch("/constellation.json")
      .then((r) => r.json())
      .then((d) => {
        setMemoryTotal(d?.stats?.total ?? 0);
        setMemoryProjects(d?.stats?.projects?.length ?? 0);
      })
      .catch(() => setMemoryTotal(0));
    fetch("/sort_atlas.json")
      .then((r) => r.json())
      .then((d) => setAtlasTotal(d?.stats?.total ?? 0))
      .catch(() => setAtlasTotal(0));
  }, []);

  const tiles: Tile[] = useMemo(
    () => [
      {
        label: "Memory chunks",
        numericValue: memoryTotal,
        delta: memoryProjects !== null ? `${memoryProjects} projects` : undefined,
        deltaTone: "neutral",
        icon: Sparkles,
        href: "/constellation",
        spark: syntheticSpark(13, 18, 1.4),
        accent: "var(--accent)",
      },
      {
        label: "Atlas corpus",
        numericValue: atlasTotal,
        delta: atlasTotal === 0 ? "pipeline pending" : "files indexed",
        deltaTone: "neutral",
        icon: Database,
        href: "/atlas",
        spark: syntheticSpark(7, 18, 0.6),
        accent: "#7be0c8",
      },
      {
        label: "Trace events / day",
        numericValue: 0,
        delta: "Langfuse wired",
        deltaTone: "neutral",
        icon: Microscope,
        href: "/traces",
        spark: syntheticSpark(42, 18, 0),
        accent: "#c1c3e8",
      },
      {
        label: "Feed articles",
        numericValue: 157,
        formatValue: (n) => `${n.toLocaleString()}+`,
        delta: "28 active feeds",
        deltaTone: "up",
        icon: Newspaper,
        href: "/feeds",
        spark: syntheticSpark(91, 18, 2.0),
        accent: "#e8c79a",
      },
    ],
    [memoryTotal, memoryProjects, atlasTotal],
  );

  return (
    <div className="mb-6 grid gap-3 md:grid-cols-12">
      <div className="md:col-span-4">
        <ConstellationThumb />
      </div>
      <div className="grid gap-3 md:col-span-8 md:grid-cols-2">
      {tiles.map((t) => {
        const Icon = t.icon;
        const body = (
          <div className="surface-card group relative h-full overflow-hidden rounded-xl p-4 transition hover:-translate-y-0.5 hover:shadow-lush">
            {/* subtle scanline overlay on hover */}
            <span className="pointer-events-none absolute inset-0 bg-gradient-to-br from-transparent via-transparent to-[color:var(--accent-soft)] opacity-0 transition-opacity group-hover:opacity-100" />
            <div className="relative flex items-start justify-between gap-2">
              <Icon
                className="h-4 w-4"
                style={{ color: t.accent }}
              />
              {t.href ? (
                <ArrowRight className="h-3.5 w-3.5 text-quiet opacity-0 transition-opacity group-hover:opacity-100" />
              ) : null}
            </div>
            <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.18em] text-quiet">
              {t.label}
            </p>
            <p
              className="font-mono text-3xl font-semibold tabular-nums text-strong"
              style={{ letterSpacing: "-0.02em" }}
            >
              <AnimatedCounter value={t.numericValue} format={t.formatValue} />
            </p>
            <div className="mt-1 flex items-end justify-between gap-2">
              {t.delta ? (
                <span
                  className={
                    t.deltaTone === "up"
                      ? "font-mono text-[10px] uppercase tracking-widest text-emerald-600"
                      : t.deltaTone === "down"
                      ? "font-mono text-[10px] uppercase tracking-widest text-rose-600"
                      : "font-mono text-[10px] uppercase tracking-widest text-quiet"
                  }
                >
                  {t.delta}
                </span>
              ) : (
                <span />
              )}
              {mounted && t.spark ? (
                <div className="h-6 w-20 opacity-60 transition-opacity group-hover:opacity-100">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={t.spark}>
                      <Line
                        type="monotone"
                        dataKey="v"
                        stroke={t.accent}
                        strokeWidth={1.4}
                        dot={false}
                        isAnimationActive={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              ) : null}
            </div>
          </div>
        );
        return t.href ? (
          <Link key={t.label} href={t.href} className="block">
            {body}
          </Link>
        ) : (
          <div key={t.label}>{body}</div>
        );
      })}
      </div>
    </div>
  );
}
