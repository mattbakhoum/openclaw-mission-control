"use client";

export const dynamic = "force-dynamic";

/**
 * /bots/[name] — single-bot detail view.
 *
 * Layout:
 *   - status strip (state, uptime, image) with a disabled "Restart bot"
 *     button. Phase 2 will turn the button live; the affordance lives
 *     here now so design tells the whole story.
 *   - 3-col body: persona markdown (1) + filtered live activity (2)
 *   - sparkline of events-per-minute over the last 60 minutes
 *
 * The persona panel uses the existing /api/v1/memory-search/file
 * endpoint, which already enforces the /opt/data/memory/ prefix. We
 * never write file paths constructed in the browser into that endpoint
 * without first validating they come from a trusted source (the bots
 * snapshot).
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  Power,
} from "lucide-react";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { SignedIn, SignedOut, useAuth } from "@/auth/clerk";
import { customFetch, ApiError } from "@/api/mutator";
import { getApiBaseUrl } from "@/lib/api-base";
import { getLocalAuthToken, isLocalAuthMode } from "@/auth/localAuth";
import { Markdown } from "@/components/atoms/Markdown";
import { SignedOutPanel } from "@/components/auth/SignedOutPanel";
import { BotActivityStream } from "@/components/organisms/BotActivityStream";
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

type BotsResponse = { generated_at: string; bots: BotInfo[] };
type FileResponse = { path: string; content: string; bytes: number };

type RawEvent = {
  ts: string;
  bot?: string;
  container?: string;
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

function stateBadge(state: string): { label: string; tone: string } {
  const normalized = (state || "unknown").toLowerCase();
  if (normalized === "running") {
    return { label: "running", tone: "text-emerald-300" };
  }
  if (normalized === "paused") {
    return { label: "paused", tone: "text-amber-300" };
  }
  if (normalized === "exited" || normalized === "dead" || normalized === "missing") {
    return { label: normalized, tone: "text-rose-300" };
  }
  return { label: normalized, tone: "text-slate-400" };
}

async function resolveAuthHeader(): Promise<string | null> {
  if (typeof window === "undefined") return null;
  if (isLocalAuthMode()) {
    const token = getLocalAuthToken();
    return token ? `Bearer ${token}` : null;
  }
  const clerk = (window as unknown as {
    Clerk?: { session?: { getToken: () => Promise<string> } };
  }).Clerk;
  if (!clerk?.session) return null;
  try {
    const token = await clerk.session.getToken();
    return token ? `Bearer ${token}` : null;
  } catch {
    return null;
  }
}

// --- Events-per-minute sparkline (last 60 min) ------------------------------

const SPARK_MINUTES = 60;

type SparkPoint = { minute: number; label: string; count: number };

function buildSparkSeries(events: RawEvent[], anchor: number, botKey: string): SparkPoint[] {
  // Build 60 buckets, one per minute, oldest first.
  const buckets: SparkPoint[] = [];
  for (let i = SPARK_MINUTES - 1; i >= 0; i -= 1) {
    const bucketEnd = anchor - i * 60_000;
    const date = new Date(bucketEnd);
    const label = `${date.getHours().toString().padStart(2, "0")}:${date
      .getMinutes()
      .toString()
      .padStart(2, "0")}`;
    buckets.push({ minute: bucketEnd, label, count: 0 });
  }
  const cutoff = anchor - SPARK_MINUTES * 60_000;
  for (const event of events) {
    if (event.bot !== botKey && event.container !== botKey) continue;
    const ts = Date.parse(event.ts);
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    const minutesAgo = Math.floor((anchor - ts) / 60_000);
    if (minutesAgo < 0 || minutesAgo >= SPARK_MINUTES) continue;
    const idx = SPARK_MINUTES - 1 - minutesAgo;
    buckets[idx]!.count += 1;
  }
  return buckets;
}

// --- Page -------------------------------------------------------------------

export default function BotDetailPage() {
  const params = useParams<{ name: string }>();
  const rawName = params?.name;
  const name = useMemo(() => {
    if (typeof rawName !== "string") return "";
    try {
      return decodeURIComponent(rawName);
    } catch {
      return rawName;
    }
  }, [rawName]);

  const { isSignedIn } = useAuth();
  const [bot, setBot] = useState<BotInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [personaText, setPersonaText] = useState<string | null>(null);
  const [personaError, setPersonaError] = useState<string | null>(null);
  const [isPersonaLoading, setIsPersonaLoading] = useState(false);
  const [sparkEvents, setSparkEvents] = useState<RawEvent[]>([]);
  const [sparkNow, setSparkNow] = useState<number>(() => Date.now());

  // Refresh the bot row every 15s like the index page.
  useEffect(() => {
    if (!isSignedIn || !name) return;
    let cancelled = false;
    let timer: number | null = null;

    const load = async () => {
      try {
        const result = await customFetch<BotsResponse>("/api/v1/bots", {
          method: "GET",
        });
        if (cancelled) return;
        const match = (result.bots ?? []).find((b) => b.name === name) ?? null;
        setBot(match);
        setLoadError(match ? null : `Bot "${name}" not found.`);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError) {
          setLoadError(`Failed to load bot (${err.status}): ${err.message}`);
        } else if (err instanceof Error) {
          setLoadError(err.message);
        } else {
          setLoadError("Failed to load bot.");
        }
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
  }, [isSignedIn, name]);

  // Load the persona file once we know which path to read.
  const personaPath = bot?.persona_source_path ?? null;
  useEffect(() => {
    if (!isSignedIn) return;
    if (!personaPath) {
      setPersonaText(null);
      setPersonaError(null);
      setIsPersonaLoading(false);
      return;
    }
    let cancelled = false;
    setIsPersonaLoading(true);
    setPersonaError(null);
    void (async () => {
      try {
        const params = new URLSearchParams({ path: personaPath });
        const result = await customFetch<FileResponse>(
          `/api/v1/memory-search/file?${params.toString()}`,
          { method: "GET" },
        );
        if (cancelled) return;
        setPersonaText(result?.content ?? "");
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError) {
          setPersonaError(`Persona load failed (${err.status}).`);
        } else if (err instanceof Error) {
          setPersonaError(err.message);
        } else {
          setPersonaError("Persona load failed.");
        }
        setPersonaText(null);
      } finally {
        if (!cancelled) setIsPersonaLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isSignedIn, personaPath]);

  // Subscribe to bot-events for the sparkline. We reuse the same SSE
  // stream the BotActivityStream component consumes, but keep the
  // events here as raw timestamps so we can bucket per minute.
  useEffect(() => {
    if (!isSignedIn || !name) return;
    const controller = new AbortController();
    let cancelled = false;
    let retryHandle: number | null = null;

    async function connect() {
      if (cancelled) return;
      try {
        const auth = await resolveAuthHeader();
        const headers: Record<string, string> = { Accept: "text/event-stream" };
        if (auth) headers.Authorization = auth;
        const response = await fetch(
          `${getApiBaseUrl()}/api/v1/bot-events/stream`,
          {
            method: "GET",
            headers,
            signal: controller.signal,
            credentials: "include",
            cache: "no-store",
          },
        );
        if (!response.ok || !response.body) return;
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lastBoundary = buffer.lastIndexOf("\n\n");
          if (lastBoundary === -1) continue;
          const completed = buffer.slice(0, lastBoundary + 2);
          buffer = buffer.slice(lastBoundary + 2);
          for (const block of completed.split(/\r?\n\r?\n/)) {
            if (!block) continue;
            for (const line of block.split(/\r?\n/)) {
              if (!line.startsWith("data:")) continue;
              const payload = line.slice(5).trimStart();
              try {
                const event = JSON.parse(payload) as RawEvent;
                if (event.bot === name || event.container === name) {
                  setSparkEvents((prev) => {
                    // Keep at most last ~90 minutes of data so this list
                    // never grows unbounded over a long-lived connection.
                    const cutoff = Date.now() - 90 * 60_000;
                    const filtered = prev.filter(
                      (e) => Date.parse(e.ts) >= cutoff,
                    );
                    filtered.push(event);
                    return filtered;
                  });
                }
              } catch {
                /* ignore malformed frames */
              }
            }
          }
        }
      } catch (err) {
        if (cancelled || (err as { name?: string })?.name === "AbortError") {
          return;
        }
      }
      if (cancelled) return;
      retryHandle = window.setTimeout(connect, 2000);
    }
    connect();

    return () => {
      cancelled = true;
      if (retryHandle !== null) window.clearTimeout(retryHandle);
      controller.abort();
    };
  }, [isSignedIn, name]);

  // Drive the sparkline "anchor" forward once a minute so empty buckets
  // age out of view. Granularity matches the bucket size.
  useEffect(() => {
    const handle = window.setInterval(() => setSparkNow(Date.now()), 60_000);
    return () => window.clearInterval(handle);
  }, []);

  const sparkSeries = useMemo(
    () => buildSparkSeries(sparkEvents, sparkNow, name),
    [sparkEvents, sparkNow, name],
  );
  const totalRecentEvents = useMemo(
    () => sparkSeries.reduce((sum, point) => sum + point.count, 0),
    [sparkSeries],
  );

  const indicator = stateBadge(bot?.state ?? "unknown");

  return (
    <DashboardShell>
      <SignedOut>
        <SignedOutPanel
          message="Sign in to view bot detail."
          forceRedirectUrl={`/bots/${encodeURIComponent(name)}`}
        />
      </SignedOut>
      <SignedIn>
        <DashboardSidebar />
        <main className="relative flex-1 overflow-y-auto bg-app">
          <ParticleBackdrop />
          <div className="relative p-4 md:p-8">
            <Link
              href="/bots"
              className="mb-4 inline-flex items-center gap-1.5 text-xs uppercase tracking-widest text-muted transition-colors hover:text-[color:var(--accent)]"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              All bots
            </Link>

            {loadError && !bot ? (
              <div className="rounded-xl border border-rose-300 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-700/40 dark:bg-rose-950/40 dark:text-rose-200">
                {loadError}
              </div>
            ) : !bot ? (
              <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-muted dark:border-slate-700/40 dark:bg-slate-900/40">
                Loading bot...
              </div>
            ) : (
              <>
                {/* Status strip */}
                <section
                  className="relative overflow-hidden rounded-2xl border border-[color:var(--accent)]/25 bg-slate-950/80 p-5 font-mono text-slate-200 shadow-[0_0_40px_-12px_rgba(255,122,89,0.35)] backdrop-blur"
                  style={{
                    backgroundImage:
                      "radial-gradient(900px circle at 0% 0%, rgba(255,122,89,0.10), transparent 55%), radial-gradient(700px circle at 100% 100%, rgba(56,189,248,0.08), transparent 50%), linear-gradient(180deg, rgba(15,23,42,0.65) 0%, rgba(2,6,23,0.85) 100%)",
                  }}
                >
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[color:var(--accent)]/60 to-transparent"
                  />
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-[color:var(--accent)]">
                        bot · detail
                      </p>
                      <h1 className="mt-1 font-heading text-2xl font-bold text-strong">
                        {bot.display_name}
                      </h1>
                      <div className={`mt-2 flex flex-wrap items-center gap-2 text-xs ${indicator.tone}`}>
                        <span className="rounded-sm border border-current/40 px-1.5 py-0.5 text-[10.5px] uppercase tracking-widest">
                          {indicator.label}
                        </span>
                        <span className="text-slate-500">·</span>
                        <span className="font-mono text-slate-300">
                          {formatUptime(bot.uptime_seconds)}
                        </span>
                        <span className="text-slate-500">·</span>
                        <span className="font-mono text-slate-400">
                          {bot.name}
                        </span>
                        {bot.health ? (
                          <>
                            <span className="text-slate-500">·</span>
                            <span className="font-mono text-slate-400">
                              health: {bot.health}
                            </span>
                          </>
                        ) : null}
                      </div>
                      {bot.image ? (
                        <p className="mt-2 truncate font-mono text-[11px] text-slate-500">
                          image: <span className="text-slate-400">{bot.image}</span>
                        </p>
                      ) : null}
                    </div>

                    <div className="flex flex-col items-end gap-2">
                      <button
                        type="button"
                        disabled
                        title="Phase 2 — coming soon"
                        aria-label="Restart bot (Phase 2 — coming soon)"
                        className="inline-flex cursor-not-allowed items-center gap-2 rounded-md border border-rose-400/40 bg-rose-500/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-rose-200 opacity-60"
                      >
                        <Power className="h-3.5 w-3.5" />
                        Restart bot
                      </button>
                      <p className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
                        phase 2 — coming soon
                      </p>
                    </div>
                  </div>

                  <div className="mt-4 grid grid-cols-2 gap-3 border-t border-white/5 pt-3 text-[12.5px] md:grid-cols-4">
                    <Stat
                      label="events / hour"
                      value={String(bot.events_last_hour)}
                    />
                    <Stat
                      label="memory chunks"
                      value={bot.memory_chunks.toLocaleString()}
                    />
                    <Stat
                      label="restarts"
                      value={String(bot.restart_count)}
                      tone={bot.restart_count > 0 ? "warn" : "default"}
                    />
                    <Stat
                      label="project tag"
                      value={bot.primary_project_tag || "—"}
                    />
                  </div>
                </section>

                {/* Body grid */}
                <div className="mt-6 grid grid-cols-1 gap-4 xl:grid-cols-3">
                  {/* Persona */}
                  <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white p-4 md:p-6 shadow-sm dark:border-slate-700/40 dark:bg-slate-900/60">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <h2 className="font-heading text-base font-semibold text-strong">
                        Persona
                      </h2>
                      <span className="font-mono text-[10px] uppercase tracking-widest text-quiet">
                        SOUL.md
                      </span>
                    </div>
                    {bot.persona_exists ? (
                      isPersonaLoading ? (
                        <p className="text-sm text-muted">Loading persona...</p>
                      ) : personaError ? (
                        <p className="text-sm text-rose-600 dark:text-rose-300">
                          {personaError}
                        </p>
                      ) : personaText ? (
                        <div className="max-h-[420px] overflow-y-auto pr-1 text-sm leading-6 text-strong">
                          <Markdown content={personaText} variant="description" />
                        </div>
                      ) : (
                        <p className="text-sm text-muted">
                          Persona file is empty.
                        </p>
                      )
                    ) : (
                      <p className="text-sm text-muted">
                        No persona document indexed for this bot yet.
                      </p>
                    )}
                    {bot.persona_source_path ? (
                      <p className="mt-3 truncate font-mono text-[11px] text-quiet">
                        {bot.persona_source_path}
                      </p>
                    ) : null}
                  </section>

                  {/* Live activity (2 col) */}
                  <section className="xl:col-span-2">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <h2 className="font-heading text-base font-semibold text-strong">
                        Live activity
                      </h2>
                      <span className="font-mono text-[10px] uppercase tracking-widest text-quiet">
                        filtered · {bot.name}
                      </span>
                    </div>
                    <BotActivityStream botFilter={bot.name} />
                  </section>
                </div>

                {/* Sparkline */}
                <section className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white p-4 md:p-6 shadow-sm dark:border-slate-700/40 dark:bg-slate-900/60">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <h2 className="font-heading text-base font-semibold text-strong">
                      Events per minute · last 60 min
                    </h2>
                    <span className="font-mono text-[10px] uppercase tracking-widest text-quiet">
                      {totalRecentEvents} total
                    </span>
                  </div>
                  <div style={{ width: "100%", height: 80 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart
                        data={sparkSeries}
                        margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
                      >
                        <defs>
                          <linearGradient
                            id="sparkFill"
                            x1="0"
                            y1="0"
                            x2="0"
                            y2="1"
                          >
                            <stop offset="0%" stopColor="#ff7a59" stopOpacity={0.5} />
                            <stop offset="100%" stopColor="#ff7a59" stopOpacity={0.02} />
                          </linearGradient>
                        </defs>
                        <XAxis
                          dataKey="label"
                          hide
                        />
                        <YAxis hide allowDecimals={false} />
                        <Tooltip
                          cursor={{ stroke: "rgba(255,122,89,0.35)" }}
                          contentStyle={{
                            background: "rgba(15,23,42,0.95)",
                            border: "1px solid rgba(255,122,89,0.35)",
                            borderRadius: 8,
                            fontFamily: "monospace",
                            fontSize: 11,
                            color: "#e2e8f0",
                          }}
                          formatter={(value) => [value as number, "events"] as [number, string]}
                          labelFormatter={(label) => `at ${label}`}
                        />
                        <Area
                          type="monotone"
                          dataKey="count"
                          stroke="#ff7a59"
                          strokeWidth={1.5}
                          fill="url(#sparkFill)"
                          isAnimationActive={false}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </section>
              </>
            )}
          </div>
        </main>
      </SignedIn>
    </DashboardShell>
  );
}

function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "warn";
}) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
        {label}
      </p>
      <p
        className={
          tone === "warn"
            ? "mt-0.5 font-heading text-lg font-semibold tabular-nums text-amber-300"
            : "mt-0.5 font-heading text-lg font-semibold tabular-nums text-strong"
        }
      >
        {value}
      </p>
    </div>
  );
}
