"use client";

export const dynamic = "force-dynamic";

/**
 * /bots — central observability surface for every BAKHOUM·OS bot.
 *
 * Phase 1: read-only card grid. Each card surfaces container state,
 * uptime, last-activity, last-hour event count, memory chunk count, and
 * a clickable persona link. Cards are themselves links to the per-bot
 * detail page.
 *
 * Phase 2 will graft action buttons (restart, pause, exec) onto the
 * detail view. The "Restart bot" affordance already lives on the detail
 * page as a disabled tooltip — design tells the whole story even when
 * the wires aren't hot yet.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, Bot as BotIcon, FileText } from "lucide-react";

import { SignedIn, SignedOut, useAuth } from "@/auth/clerk";
import { customFetch, ApiError } from "@/api/mutator";
import { SignedOutPanel } from "@/components/auth/SignedOutPanel";
import { DashboardSidebar } from "@/components/organisms/DashboardSidebar";
import { DashboardShell } from "@/components/templates/DashboardShell";
import { ParticleBackdrop } from "@/components/atoms/ParticleBackdrop";

// --- Types ------------------------------------------------------------------

type BotInfo = {
  name: string;
  display_name: string;
  state: string;
  started_at: string | null;
  uptime_seconds: number | null;
  restart_count: number;
  image: string | null;
  health: string | null;
  primary_project_tag: string | null;
  last_event_at: string | null;
  events_last_hour: number;
  memory_chunks: number;
  persona_source_path: string | null;
  persona_exists: boolean;
};

type BotsResponse = {
  generated_at: string;
  bots: BotInfo[];
};

// --- Helpers ----------------------------------------------------------------

function formatUptime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 24) return `${hours}h ${remMinutes}m`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return `${days}d ${remHours}h`;
}

function relativeTime(iso: string | null, now: number): string {
  if (!iso) return "no activity";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "—";
  const delta = Math.max(0, now - then);
  if (delta < 1000) return "now";
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

// State indicator color. Matches the activity stream's emerald/rose palette.
function stateIndicator(state: string): {
  label: string;
  dot: string;
  ring: string;
  text: string;
} {
  const normalized = (state || "unknown").toLowerCase();
  switch (normalized) {
    case "running":
      return {
        label: "running",
        dot: "bg-emerald-400 animate-pulse shadow-[0_0_12px_rgba(52,211,153,0.7)]",
        ring: "ring-emerald-400/30",
        text: "text-emerald-300",
      };
    case "paused":
      return {
        label: "paused",
        dot: "bg-amber-300",
        ring: "ring-amber-400/30",
        text: "text-amber-300",
      };
    case "exited":
    case "dead":
      return {
        label: normalized,
        dot: "bg-rose-400 shadow-[0_0_12px_rgba(244,114,182,0.6)]",
        ring: "ring-rose-400/30",
        text: "text-rose-300",
      };
    case "missing":
      return {
        label: "missing",
        dot: "bg-rose-500",
        ring: "ring-rose-500/30",
        text: "text-rose-300",
      };
    default:
      return {
        label: normalized,
        dot: "bg-slate-500",
        ring: "ring-slate-500/30",
        text: "text-slate-400",
      };
  }
}

// --- Page -------------------------------------------------------------------

export default function BotsPage() {
  const { isSignedIn } = useAuth();
  const [data, setData] = useState<BotsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [now, setNow] = useState<number>(() => Date.now());

  // Tick once per second so "12s ago" stays honest. Lightweight: only
  // re-renders the cards, not the entire shell.
  useEffect(() => {
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, []);

  // Poll /api/v1/bots every 15s. Status changes are sluggish (container
  // restarts are seconds-scale), so a slower poll is plenty. The event
  // count + last-event-at fields update on the same cadence.
  useEffect(() => {
    if (!isSignedIn) return;
    let cancelled = false;
    let timer: number | null = null;

    const load = async () => {
      try {
        setIsLoading(true);
        const result = await customFetch<BotsResponse>("/api/v1/bots", {
          method: "GET",
        });
        if (cancelled) return;
        setData(result);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError) {
          setError(`Failed to load bots (${err.status}): ${err.message}`);
        } else if (err instanceof Error) {
          setError(err.message);
        } else {
          setError("Failed to load bots.");
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
      if (!cancelled) {
        timer = window.setTimeout(load, 15_000);
      }
    };
    void load();

    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [isSignedIn]);

  const bots = useMemo(() => data?.bots ?? [], [data]);

  return (
    <DashboardShell>
      <SignedOut>
        <SignedOutPanel
          message="Sign in to view bot control surface."
          forceRedirectUrl="/bots"
        />
      </SignedOut>
      <SignedIn>
        <DashboardSidebar />
        <main className="relative flex-1 overflow-y-auto bg-app">
          <ParticleBackdrop />
          <div className="relative p-4 md:p-8">
            <header className="mb-6 flex items-end justify-between gap-4">
              <div>
                <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-[color:var(--accent)]">
                  control · surface · phase 01
                </p>
                <h1 className="mt-1 font-heading text-3xl font-bold text-strong">
                  Bots
                </h1>
                <p className="mt-1 text-sm text-muted">
                  Live status of every container the bot-events-tap is watching.
                  Click a card to dive into a bot&apos;s persona and live feed.
                </p>
              </div>
              <div className="hidden text-right md:block">
                <p className="font-mono text-[10px] uppercase tracking-widest text-quiet">
                  snapshot
                </p>
                <p className="font-mono text-xs text-muted">
                  {data?.generated_at
                    ? relativeTime(data.generated_at, now)
                    : "—"}
                </p>
              </div>
            </header>

            {error ? (
              <div className="mb-4 rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-700/40 dark:bg-rose-950/40 dark:text-rose-200">
                {error}
              </div>
            ) : null}

            {!data && isLoading ? (
              <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-muted dark:border-slate-700/40 dark:bg-slate-900/40">
                Loading bot snapshot...
              </div>
            ) : bots.length === 0 ? (
              <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-muted dark:border-slate-700/40 dark:bg-slate-900/40">
                No bots visible yet. The bot-events-tap may not be running or
                no targets are configured.
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {bots.map((bot) => (
                  <BotCard key={bot.name} bot={bot} now={now} />
                ))}
              </div>
            )}
          </div>
        </main>
      </SignedIn>
    </DashboardShell>
  );
}

// --- Card -------------------------------------------------------------------

function BotCard({ bot, now }: { bot: BotInfo; now: number }) {
  const indicator = stateIndicator(bot.state);
  const href = `/bots/${encodeURIComponent(bot.name)}`;
  const lastActionLabel = relativeTime(bot.last_event_at, now);

  return (
    <Link
      href={href}
      className="group relative block overflow-hidden rounded-2xl border border-[color:var(--accent)]/25 bg-slate-950/80 p-5 font-mono text-slate-200 shadow-[0_0_30px_-12px_rgba(255,122,89,0.35)] backdrop-blur transition-transform hover:-translate-y-1 hover:border-[color:var(--accent)]/60"
      style={{
        backgroundImage:
          "radial-gradient(700px circle at 0% 0%, rgba(255,122,89,0.10), transparent 55%), radial-gradient(600px circle at 100% 100%, rgba(56,189,248,0.08), transparent 50%), linear-gradient(180deg, rgba(15,23,42,0.65) 0%, rgba(2,6,23,0.85) 100%)",
      }}
    >
      {/* Scanline overlay — only visible on hover so the resting state
          stays calm. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-200 group-hover:opacity-100"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, rgba(148,163,184,0.05) 0px, rgba(148,163,184,0.05) 1px, transparent 1px, transparent 3px)",
        }}
      />

      {/* Accent hairline at the top */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[color:var(--accent)]/60 to-transparent"
      />

      <div className="relative">
        <div className="flex items-center justify-between gap-3">
          <h2 className="truncate font-heading text-lg font-semibold text-strong">
            {bot.display_name}
          </h2>
          <span className="rounded-full border border-white/10 bg-black/40 px-2 py-0.5 text-[10px] uppercase tracking-widest text-quiet">
            {bot.primary_project_tag || "—"}
          </span>
        </div>

        <div className={`mt-3 flex items-center gap-2 ${indicator.text}`}>
          <span
            className={`h-2 w-2 rounded-full ring-2 ring-offset-0 ${indicator.dot} ${indicator.ring}`}
          />
          <span className="text-[11px] uppercase tracking-widest">
            {indicator.label}
          </span>
          <span className="text-slate-600">·</span>
          <span className="text-xs tabular-nums text-slate-300">
            {formatUptime(bot.uptime_seconds)}
          </span>
          {bot.health ? (
            <>
              <span className="text-slate-600">·</span>
              <span className="text-[11px] uppercase tracking-widest text-slate-400">
                health: {bot.health}
              </span>
            </>
          ) : null}
        </div>

        <p className="mt-2 font-mono text-[11px] text-slate-500">{bot.name}</p>
        {bot.image ? (
          <p className="mt-0.5 truncate font-mono text-[11px] text-slate-500">
            image: <span className="text-slate-400">{bot.image}</span>
          </p>
        ) : null}

        <div className="mt-4 space-y-1 border-t border-white/5 pt-3 text-[12.5px]">
          <Row label="last action" value={lastActionLabel} />
          <Row
            label="events last hour"
            value={String(bot.events_last_hour)}
          />
          <Row
            label="memory chunks"
            value={bot.memory_chunks.toLocaleString()}
          />
          <Row
            label="restarts"
            value={String(bot.restart_count)}
            tone={bot.restart_count > 0 ? "warn" : "default"}
          />
        </div>

        <div className="mt-4 flex items-center justify-between border-t border-white/5 pt-3">
          {bot.persona_exists && bot.persona_source_path ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-widest text-[color:var(--accent)]">
              <FileText className="h-3.5 w-3.5" />
              persona: SOUL.md
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-widest text-slate-600">
              <BotIcon className="h-3.5 w-3.5" />
              persona: —
            </span>
          )}

          <span className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-widest text-slate-400 transition-colors group-hover:text-[color:var(--accent)]">
            view detail
            <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
          </span>
        </div>
      </div>
    </Link>
  );
}

function Row({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "warn";
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[11px] uppercase tracking-widest text-slate-500">
        {label}
      </span>
      <span
        className={
          tone === "warn"
            ? "text-[12.5px] tabular-nums text-amber-300"
            : "text-[12.5px] tabular-nums text-slate-300"
        }
      >
        {value}
      </span>
    </div>
  );
}
