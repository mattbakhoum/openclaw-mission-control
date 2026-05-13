"use client";

/**
 * BotActivityStream — live bot activity widget for /dashboard.
 *
 * Subscribes to `GET /api/v1/bot-events/stream` (Server-Sent Events) and
 * renders the newest events at the top with a slide+fade animation. The
 * goal is to make it visceral that bots are doing things RIGHT NOW —
 * Vercel deployment logs meet a Tailscale admin feed.
 *
 * Why fetch+ReadableStream instead of native EventSource:
 *   EventSource cannot send a Bearer token, and the MC backend's auth
 *   dep requires one. fetch lets us set Authorization while still
 *   consuming an SSE-shaped response.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getLocalAuthToken, isLocalAuthMode } from "@/auth/localAuth";
import { getApiBaseUrl } from "@/lib/api-base";

type BotEvent = {
  id: string;
  ts: string;
  container: string;
  bot: string;
  event_type: string;
  verb: string;
  level: "info" | "warn" | "error" | string;
  payload: string;
};

type ConnectionStatus = "connecting" | "open" | "idle" | "closed" | "error";

const MAX_VISIBLE = 12;
const MAX_RETAINED = 60;
// "Idle" threshold — when no event has arrived for this long, the
// indicator shifts from "open" to "idle" and the empty state shows a
// breathing scanline.
const IDLE_AFTER_MS = 60_000;
// Mark events younger than this as "fresh" — pulsing dot.
const FRESH_FOR_MS = 5_000;

// Stable color identities per bot. Tailwind-friendly tokens so they
// can be tweaked once the theme system catches up.
const BOT_PALETTE: Record<string, { chip: string; ring: string; glow: string }> = {
  bakhoum_ops: {
    chip: "bg-[#ff7a59]/15 text-[#ff7a59] border-[#ff7a59]/40",
    ring: "ring-[#ff7a59]/30",
    glow: "shadow-[0_0_18px_-6px_rgba(255,122,89,0.55)]",
  },
  household: {
    chip: "bg-teal-400/15 text-teal-300 border-teal-400/40",
    ring: "ring-teal-400/30",
    glow: "shadow-[0_0_18px_-6px_rgba(45,212,191,0.45)]",
  },
  trips: {
    chip: "bg-sky-400/15 text-sky-300 border-sky-400/40",
    ring: "ring-sky-400/30",
    glow: "shadow-[0_0_18px_-6px_rgba(56,189,248,0.45)]",
  },
  system: {
    chip: "bg-violet-400/15 text-violet-300 border-violet-400/40",
    ring: "ring-violet-400/30",
    glow: "shadow-[0_0_18px_-6px_rgba(167,139,250,0.45)]",
  },
};

const DEFAULT_PALETTE = {
  chip: "bg-slate-400/15 text-slate-300 border-slate-400/40",
  ring: "ring-slate-400/30",
  glow: "shadow-[0_0_18px_-6px_rgba(148,163,184,0.4)]",
};

const VERB_TONE: Record<string, string> = {
  sent: "text-[#ff7a59]",
  send: "text-[#ff7a59]",
  posted: "text-[#ff7a59]",
  received: "text-cyan-300",
  incoming: "text-cyan-300",
  ready: "text-emerald-300",
  started: "text-emerald-300",
  completed: "text-emerald-300",
  error: "text-rose-400",
  warning: "text-amber-300",
};

const LEVEL_TONE: Record<string, string> = {
  error: "text-rose-400",
  warn: "text-amber-300",
  info: "text-slate-300",
};

function paletteFor(bot: string) {
  return BOT_PALETTE[bot] ?? DEFAULT_PALETTE;
}

function verbToneFor(verb: string, level: string): string {
  return VERB_TONE[verb.toLowerCase()] ?? LEVEL_TONE[level] ?? "text-slate-300";
}

function relativeTime(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "—";
  const delta = Math.max(0, now - then);
  if (delta < 1000) return "now";
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

function resolveAuthHeader(): Promise<string | null> {
  if (isLocalAuthMode()) {
    const token = getLocalAuthToken();
    return Promise.resolve(token ? `Bearer ${token}` : null);
  }
  const clerk = (window as unknown as {
    Clerk?: { session?: { getToken: () => Promise<string> } };
  }).Clerk;
  if (!clerk?.session) return Promise.resolve(null);
  return clerk.session
    .getToken()
    .then((token) => (token ? `Bearer ${token}` : null))
    .catch(() => null);
}

/**
 * Parse SSE-framed chunks. We only care about `data:` lines; `event:` and
 * heartbeat comments are ignored.
 */
function* iterFrames(buffer: string): Generator<string, void, void> {
  const blocks = buffer.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    if (!block) continue;
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length) yield dataLines.join("\n");
  }
}

export function BotActivityStream() {
  const [events, setEvents] = useState<BotEvent[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [now, setNow] = useState<number>(() => Date.now());
  const [autoScroll, setAutoScroll] = useState(true);

  const listRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastEventAtRef = useRef<number>(Date.now());
  const eventCounterRef = useRef(0);

  // Tick `now` once a second so relative times stay live and the
  // pulsing-dot heuristic stays accurate without re-rendering on every
  // unrelated update.
  useEffect(() => {
    const handle = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(handle);
  }, []);

  // Mark "idle" when no event has been seen for IDLE_AFTER_MS. Computed
  // here (not in state) to avoid an extra re-render path.
  const isIdle = status === "open" && now - lastEventAtRef.current > IDLE_AFTER_MS;

  const pushEvent = useCallback((event: BotEvent) => {
    lastEventAtRef.current = Date.now();
    setEvents((prev) => {
      const next = [event, ...prev];
      if (next.length > MAX_RETAINED) next.length = MAX_RETAINED;
      return next;
    });
  }, []);

  // Subscribe. fetch+ReadableStream lets us send Authorization, which
  // the native EventSource constructor refuses to do.
  useEffect(() => {
    let cancelled = false;
    let retryHandle: number | null = null;

    async function connect() {
      if (cancelled) return;
      setStatus("connecting");
      const controller = new AbortController();
      abortRef.current = controller;
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
        if (!response.ok || !response.body) {
          setStatus("error");
          throw new Error(`SSE handshake failed: ${response.status}`);
        }
        setStatus("open");
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        // Stream loop. Each "block" of SSE frames terminates in a blank
        // line; we keep the trailing partial in `buffer` for next read.
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lastBoundary = buffer.lastIndexOf("\n\n");
          if (lastBoundary === -1) continue;
          const completed = buffer.slice(0, lastBoundary + 2);
          buffer = buffer.slice(lastBoundary + 2);
          for (const payload of iterFrames(completed)) {
            try {
              const parsed = JSON.parse(payload) as Omit<BotEvent, "id">;
              const id = `${parsed.ts}-${eventCounterRef.current++}`;
              pushEvent({ id, ...parsed });
            } catch {
              // Ignore malformed frames; the next one will come along.
            }
          }
        }
        setStatus("closed");
      } catch (error) {
        if (cancelled) return;
        if ((error as { name?: string }).name === "AbortError") return;
        setStatus("error");
      }
      if (cancelled) return;
      // Exponential-ish backoff capped at 8s. We deliberately reconnect
      // forever — this is a dashboard widget, not a critical path.
      retryHandle = window.setTimeout(connect, 2000);
    }

    connect();

    return () => {
      cancelled = true;
      if (retryHandle !== null) window.clearTimeout(retryHandle);
      abortRef.current?.abort();
    };
  }, [pushEvent]);

  // Track user scroll position. If the user scrolls away from the top,
  // pause auto-scroll so we don't yank them back when a new event
  // arrives. Resume the moment they return to the top.
  const handleScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    setAutoScroll(el.scrollTop <= 4);
  }, []);

  // When new events arrive and auto-scroll is enabled, snap to top.
  useEffect(() => {
    if (!autoScroll) return;
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = 0;
  }, [events, autoScroll]);

  const visible = useMemo(() => events.slice(0, MAX_VISIBLE), [events]);

  const statusBadge = useMemo(() => {
    if (status === "open" && !isIdle) {
      return { label: "live", tone: "text-emerald-300", dot: "bg-emerald-400 animate-pulse" };
    }
    if (status === "open" && isIdle) {
      return { label: "listening", tone: "text-slate-400", dot: "bg-slate-400" };
    }
    if (status === "connecting") {
      return { label: "connecting", tone: "text-amber-300", dot: "bg-amber-300 animate-pulse" };
    }
    if (status === "error") {
      return { label: "reconnecting", tone: "text-rose-400", dot: "bg-rose-400 animate-pulse" };
    }
    return { label: "offline", tone: "text-slate-500", dot: "bg-slate-500" };
  }, [status, isIdle]);

  return (
    <section
      className="relative overflow-hidden rounded-2xl border border-[#ff7a59]/25 bg-slate-950/80 p-0 font-mono text-slate-200 shadow-[0_0_40px_-12px_rgba(255,122,89,0.35)] backdrop-blur"
      style={{
        backgroundImage:
          "radial-gradient(900px circle at 0% 0%, rgba(255,122,89,0.08), transparent 55%), radial-gradient(700px circle at 100% 100%, rgba(56,189,248,0.07), transparent 50%), linear-gradient(180deg, rgba(15,23,42,0.65) 0%, rgba(2,6,23,0.85) 100%)",
        height: 280,
      }}
      aria-label="Live bot activity stream"
    >
      {/* keyframes scoped to this widget */}
      <style jsx>{`
        @keyframes botRowIn {
          from {
            opacity: 0;
            transform: translateX(12px);
          }
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }
        @keyframes botBreathe {
          0%, 100% { opacity: 0.35; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.15); }
        }
        .bot-row {
          animation: botRowIn 220ms ease-out both;
        }
        .bot-breathe {
          animation: botBreathe 2.4s ease-in-out infinite;
        }
        .scanline {
          background-image: repeating-linear-gradient(
            0deg,
            rgba(148, 163, 184, 0.05) 0px,
            rgba(148, 163, 184, 0.05) 1px,
            transparent 1px,
            transparent 3px
          );
        }
      `}</style>

      {/* Header strip */}
      <div className="flex items-center justify-between gap-3 border-b border-white/5 bg-black/30 px-4 py-2 text-[11px] uppercase tracking-[0.18em]">
        <div className="flex items-center gap-2 text-slate-300">
          <span className="h-1.5 w-1.5 rounded-full bg-[#ff7a59] shadow-[0_0_10px_rgba(255,122,89,0.8)]" />
          <span className="font-semibold">bot · activity · stream</span>
          <span className="text-slate-600">/</span>
          <span className="text-slate-500">openclaw · tap</span>
        </div>
        <div className={`flex items-center gap-1.5 ${statusBadge.tone}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${statusBadge.dot}`} />
          <span>{statusBadge.label}</span>
          {!autoScroll && status === "open" ? (
            <span className="ml-2 rounded border border-amber-300/40 px-1.5 py-0.5 text-[10px] text-amber-300">
              paused
            </span>
          ) : null}
        </div>
      </div>

      {/* Body */}
      <div
        ref={listRef}
        onScroll={handleScroll}
        className="relative h-[240px] overflow-y-auto px-3 py-2"
      >
        {visible.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {visible.map((event, index) => {
              const palette = paletteFor(event.bot);
              const tone = verbToneFor(event.verb, event.level);
              const ts = Date.parse(event.ts);
              const fresh = Number.isFinite(ts) && now - ts < FRESH_FOR_MS;
              const fade = index >= MAX_VISIBLE - 2 ? "opacity-70" : "";
              return (
                <li
                  key={event.id}
                  className={`bot-row group flex items-start gap-3 rounded-md border border-white/5 bg-white/[0.02] px-3 py-1.5 text-[12.5px] leading-tight transition-colors hover:border-white/10 hover:bg-white/[0.04] ${fade}`}
                >
                  {/* Pulsing freshness dot */}
                  <span className="mt-1.5 flex w-2 shrink-0 items-center">
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        fresh
                          ? "bg-[#ff7a59] bot-breathe shadow-[0_0_8px_rgba(255,122,89,0.9)]"
                          : "bg-slate-700"
                      }`}
                    />
                  </span>

                  {/* Relative timestamp */}
                  <span className="w-14 shrink-0 text-right text-[11px] tabular-nums text-slate-500">
                    {relativeTime(event.ts, now)}
                  </span>

                  {/* Bot chip */}
                  <span
                    className={`shrink-0 rounded-sm border px-1.5 py-[1px] text-[10.5px] font-semibold uppercase tracking-wider ${palette.chip}`}
                  >
                    {event.bot}
                  </span>

                  {/* Verb */}
                  <span className={`shrink-0 text-[11.5px] uppercase tracking-wider ${tone}`}>
                    {event.verb}
                  </span>

                  {/* Payload preview — only field rendered in non-mono so it
                      reads more like a sentence than a log frame. */}
                  <span className="min-w-0 flex-1 truncate font-sans text-[12px] text-slate-300/90">
                    {event.payload}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

function EmptyState() {
  return (
    <div className="scanline flex h-full w-full items-center justify-center">
      <div className="flex items-center gap-3 text-[11px] uppercase tracking-[0.25em] text-slate-500">
        <span className="bot-breathe h-2 w-2 rounded-full bg-[#ff7a59] shadow-[0_0_10px_rgba(255,122,89,0.9)]" />
        <span>no recent events · listening</span>
      </div>
    </div>
  );
}

export default BotActivityStream;
