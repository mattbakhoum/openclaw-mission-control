"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { Copy, ExternalLink, Search, Sparkles } from "lucide-react";

import { SignedIn, SignedOut, useAuth } from "@/auth/clerk";
import { customFetch } from "@/api/mutator";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Markdown } from "@/components/atoms/Markdown";
import { SignedOutPanel } from "@/components/auth/SignedOutPanel";
import { DashboardSidebar } from "@/components/organisms/DashboardSidebar";
import { DashboardShell } from "@/components/templates/DashboardShell";
import { cn } from "@/lib/utils";

/**
 * /search — work-mode semantic search across the Qdrant memory corpus.
 *
 * Sister page to /constellation. Constellation is the wow-demo (3D PCA);
 * this is the page Matt actually uses while working. Type → ranked hits
 * with snippets, click → full markdown on the right.
 */

// --- Types ------------------------------------------------------------------

type SearchScope = "memory" | "atlas" | "both";

type Hit = {
  id: string;
  score: number;
  collection: string;
  project: string | null;
  section_heading: string | null;
  source_path: string | null;
  preview: string;
  user_id: string | null;
  agent_id: string | null;
  tag: string | null;
};

type SearchResponse = { hits: Hit[] };

type FileResponse = { path: string; content: string; bytes: number };

type ConstellationStats = {
  stats?: { projects?: string[] };
};

// --- Constants --------------------------------------------------------------

// Per-project palette — synced with components/constellation/Constellation.tsx.
// Duplicated here so the page stays self-contained.
const PROJECT_COLORS: Record<string, string> = {
  bakhoum_ops: "#e08560",
  hermes: "#5fc7a5",
  cortez: "#c95fa5",
  household: "#e0c85f",
  salty: "#5f8ee0",
  "home-vault": "#e8a25e",
  "work-vault": "#7be0c8",
  "private-vault": "#d68fb5",
  _root: "#a89ec8",
  _obsidian: "#9bb55f",
  _notion: "#c1c3e8",
  _sort: "#c4b08a",
  _omi: "#9bb8e0",
  "archive-vault": "#8a8a8a",
  "_notion-export": "#b3b1d6",
  _fireflies: "#e0bf5f",
  _plaud: "#d6a55f",
  "_claude-code-history": "#7ec0c6",
  _backtrack: "#a8c5a0",
  _eldab: "#7a8eb8",
  _unscoped: "#6f5da8",
};

const colorForProject = (project: string | null | undefined): string =>
  (project && PROJECT_COLORS[project]) || "#9d8fb8";

const SCOPE_TO_COLLECTIONS: Record<SearchScope, string[]> = {
  memory: ["bakhoum_ops_memory"],
  atlas: ["sort_atlas"],
  both: ["bakhoum_ops_memory", "sort_atlas"],
};

const DEBOUNCE_MS = 200;
const RESULT_LIMIT = 30;
const SNIPPET_LINES = 3;

const SUGGESTED_QUERIES = [
  // Voice + style: high-recall canonical doc Matt re-uses often.
  "voice corrections em dashes",
  // bakhoum_ops bot wiring: the most-edited corner of the repo right now.
  "hubspot scraper bakhoum ops",
  // The salty room: cross-cuts household + cortex + chat-room memory.
  "salty room rules",
];

// --- Small helpers ----------------------------------------------------------

const formatScore = (score: number): string => {
  // Cosine scores are 0..1 in practice; show two-digit percent like Linear.
  const pct = Math.round(Math.min(1, Math.max(0, score)) * 100);
  return `${pct}%`;
};

const truncatePathLeft = (path: string, max = 64): string => {
  if (path.length <= max) return path;
  return "…" + path.slice(-(max - 1));
};

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const highlightSnippet = (
  text: string,
  query: string,
  keyPrefix: string,
): ReactNode => {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;
  const tokens = query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return trimmed;
  const pattern = new RegExp(`(${tokens.map(escapeRegex).join("|")})`, "gi");
  const parts = trimmed.split(pattern);
  return parts.map((part, idx) =>
    pattern.test(part) ? (
      <mark
        key={`${keyPrefix}-${idx}`}
        className="rounded-sm bg-[color:var(--accent-soft)] px-0.5 text-[color:var(--accent-strong)]"
      >
        {part}
      </mark>
    ) : (
      <span key={`${keyPrefix}-${idx}`}>{part}</span>
    ),
  );
};

// --- Page -------------------------------------------------------------------

export default function SearchPage() {
  const [isMounted, setIsMounted] = useState(false);
  useEffect(() => {
    setIsMounted(true);
  }, []);

  const { isSignedIn } = useAuth();

  // Input + debounced "live" query.
  const [input, setInput] = useState("");
  const [liveQuery, setLiveQuery] = useState("");

  // Toggles + filters.
  const [scope, setScope] = useState<SearchScope>("both");
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(
    () => new Set(),
  );

  // Result state.
  const [hits, setHits] = useState<Hit[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Project list comes from the same JSON that powers /constellation.
  const [knownProjects, setKnownProjects] = useState<string[]>([]);

  // Detail-pane state.
  const [selectedHitId, setSelectedHitId] = useState<string | null>(null);
  const [fileText, setFileText] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [isFileLoading, setIsFileLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const detailScrollRef = useRef<HTMLDivElement | null>(null);

  // Debounce the input → liveQuery transition. On Enter we fire immediately
  // via onKeyDown below, so this only governs the typing case.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      setLiveQuery(input.trim());
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [input]);

  // Pull project list from /constellation.json once. The file is large but
  // the browser cache + the fact that we never re-fetch keeps this cheap.
  useEffect(() => {
    let cancelled = false;
    fetch("/constellation.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: ConstellationStats | null) => {
        if (cancelled || !data?.stats?.projects) return;
        setKnownProjects(data.stats.projects);
      })
      .catch(() => {
        // Non-fatal — the chip rail just won't render. Search still works.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Run search whenever liveQuery / scope / selectedProjects change.
  const projectKey = useMemo(
    () => Array.from(selectedProjects).sort().join("|"),
    [selectedProjects],
  );

  useEffect(() => {
    if (!isSignedIn) return;
    if (!liveQuery) {
      setHits([]);
      setIsSearching(false);
      setSearchError(null);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setIsSearching(true);
    setSearchError(null);

    void (async () => {
      try {
        const projects = projectKey ? projectKey.split("|") : [];
        const result = await customFetch<SearchResponse>(
          "/api/v1/memory-search",
          {
            method: "POST",
            body: JSON.stringify({
              query: liveQuery,
              limit: RESULT_LIMIT,
              projects,
              collections: SCOPE_TO_COLLECTIONS[scope],
            }),
            signal: controller.signal,
          },
        );
        if (cancelled) return;
        setHits(result?.hits ?? []);
      } catch (err) {
        if (cancelled) return;
        if ((err as { name?: string })?.name === "AbortError") return;
        const message =
          err instanceof Error ? err.message : "Search failed.";
        setSearchError(message);
        setHits([]);
      } finally {
        if (!cancelled) setIsSearching(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [isSignedIn, liveQuery, scope, projectKey]);

  // Selected hit → fetch its file. The side panel renders the full markdown
  // and scrolls to the section heading when possible.
  const selectedHit = useMemo(
    () => hits.find((h) => h.id === selectedHitId) ?? null,
    [hits, selectedHitId],
  );
  const selectedPath = selectedHit?.source_path ?? null;

  useEffect(() => {
    if (!selectedPath) {
      setFileText(null);
      setFileError(null);
      setIsFileLoading(false);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setIsFileLoading(true);
    setFileError(null);
    setFileText(null);

    void (async () => {
      try {
        const params = new URLSearchParams({ path: selectedPath });
        const result = await customFetch<FileResponse>(
          `/api/v1/memory-search/file?${params.toString()}`,
          { method: "GET", signal: controller.signal },
        );
        if (cancelled) return;
        setFileText(result?.content ?? "");
      } catch (err) {
        if (cancelled) return;
        if ((err as { name?: string })?.name === "AbortError") return;
        const message =
          err instanceof Error
            ? err.message
            : "Could not load source file.";
        setFileError(message);
      } finally {
        if (!cancelled) setIsFileLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [selectedPath]);

  // After the file loads, scroll to the matching section heading if present.
  useEffect(() => {
    if (!fileText) return;
    if (!selectedHit?.section_heading) return;
    const container = detailScrollRef.current;
    if (!container) return;
    const handle = window.setTimeout(() => {
      const headings = container.querySelectorAll(
        "h1, h2, h3, h4, h5, h6",
      );
      const wanted = selectedHit.section_heading?.trim();
      if (!wanted) return;
      for (const el of headings) {
        if (el.textContent?.trim() === wanted) {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
          break;
        }
      }
    }, 50);
    return () => window.clearTimeout(handle);
  }, [fileText, selectedHit?.section_heading]);

  // --- Event handlers -------------------------------------------------------

  const onInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setInput(e.target.value);
  }, []);

  const onInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        setLiveQuery(input.trim());
      }
    },
    [input],
  );

  const toggleProject = useCallback((project: string) => {
    setSelectedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(project)) {
        next.delete(project);
      } else {
        next.add(project);
      }
      return next;
    });
  }, []);

  const clearProjects = useCallback(() => {
    setSelectedProjects(new Set());
  }, []);

  const runSuggested = useCallback((suggestion: string) => {
    setInput(suggestion);
    setLiveQuery(suggestion);
  }, []);

  const findRelated = useCallback(() => {
    if (!selectedHit) return;
    const seed = (selectedHit.preview || selectedHit.section_heading || "")
      .trim()
      .slice(0, 200);
    if (!seed) return;
    setInput(seed);
    setLiveQuery(seed);
  }, [selectedHit]);

  const copyPath = useCallback(async () => {
    if (!selectedPath) return;
    try {
      await navigator.clipboard.writeText(selectedPath);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Permissions / iframe etc. — silent fail is fine here.
    }
  }, [selectedPath]);

  // --- Render helpers -------------------------------------------------------

  const resultCount = hits.length;
  const hasQuery = liveQuery.length > 0;

  const scopeButton = (value: SearchScope, label: string) => (
    <button
      key={value}
      type="button"
      onClick={() => setScope(value)}
      className={cn(
        "h-8 px-3 font-mono text-[11px] uppercase tracking-widest transition",
        "border border-[color:var(--border)] first:rounded-l-lg last:rounded-r-lg",
        "-ml-px first:ml-0",
        scope === value
          ? "bg-[color:var(--accent)] text-white border-[color:var(--accent)]"
          : "bg-[color:var(--surface)] text-muted hover:text-strong",
      )}
      aria-pressed={scope === value}
    >
      {label}
    </button>
  );

  // --- Render ---------------------------------------------------------------

  return (
    <DashboardShell>
      {isMounted ? (
        <>
          <SignedOut>
            <SignedOutPanel
              message="Sign in to search the brain."
              forceRedirectUrl="/search"
              signUpForceRedirectUrl="/search"
              mode="redirect"
              buttonTestId="search-signin"
            />
          </SignedOut>
          <SignedIn>
            <DashboardSidebar />
            <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-app">
              {/* --- Top bar --- */}
              <div className="sticky top-0 z-30 border-b border-strong bg-[color:var(--surface)]/85 backdrop-blur-md">
                <div className="flex flex-col gap-3 px-4 py-4 md:px-8 md:py-5">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex flex-1 min-w-[260px] items-center gap-2 rounded-xl border border-[color:var(--border)] bg-[color:var(--surface)] px-3 shadow-sm focus-within:ring-2 focus-within:ring-[color:var(--accent)]">
                      <Search className="h-4 w-4 text-quiet" aria-hidden />
                      <Input
                        autoFocus
                        value={input}
                        onChange={onInputChange}
                        onKeyDown={onInputKeyDown}
                        placeholder="Search across the brain…"
                        className="h-11 flex-1 border-0 bg-transparent px-0 font-mono text-sm shadow-none focus-visible:ring-0"
                        spellCheck={false}
                        autoComplete="off"
                      />
                      {hasQuery ? (
                        <span className="rounded-md bg-[color:var(--surface-muted)] px-2 py-0.5 font-mono text-[11px] text-muted">
                          {isSearching ? "…" : `${resultCount}`}
                        </span>
                      ) : null}
                    </div>

                    {/* Scope toggle */}
                    <div className="flex" role="group" aria-label="Search scope">
                      {scopeButton("memory", "Memory")}
                      {scopeButton("atlas", "Atlas")}
                      {scopeButton("both", "Both")}
                    </div>
                  </div>

                  {/* Project chip rail */}
                  {knownProjects.length > 0 ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="mr-1 font-mono text-[10px] uppercase tracking-widest text-quiet">
                        Projects
                      </span>
                      <button
                        type="button"
                        onClick={clearProjects}
                        className={cn(
                          "h-7 rounded-full border px-2.5 font-mono text-[11px] transition",
                          selectedProjects.size === 0
                            ? "border-[color:var(--accent)] bg-[color:var(--accent-soft)] text-[color:var(--accent-strong)]"
                            : "border-[color:var(--border)] text-muted hover:text-strong",
                        )}
                        aria-pressed={selectedProjects.size === 0}
                      >
                        all
                      </button>
                      {knownProjects.map((project) => {
                        const active = selectedProjects.has(project);
                        const color = colorForProject(project);
                        return (
                          <button
                            key={project}
                            type="button"
                            onClick={() => toggleProject(project)}
                            className={cn(
                              "flex h-7 items-center gap-1.5 rounded-full border px-2.5 font-mono text-[11px] transition",
                              active
                                ? "border-[color:var(--accent)] bg-[color:var(--accent-soft)] text-[color:var(--accent-strong)]"
                                : "border-[color:var(--border)] text-muted hover:text-strong",
                            )}
                            aria-pressed={active}
                          >
                            <span
                              className="h-2 w-2 rounded-full"
                              style={{ backgroundColor: color }}
                              aria-hidden
                            />
                            {project}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              </div>

              {/* --- Body: results | detail --- */}
              <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[2fr_3fr]">
                {/* Results pane (left) */}
                <section
                  aria-label="Results"
                  className="flex min-h-0 flex-col overflow-y-auto border-r border-strong"
                >
                  {!hasQuery ? (
                    <EmptyState onSuggestionClick={runSuggested} />
                  ) : searchError ? (
                    <div className="m-4 rounded-xl border border-rose-300 bg-rose-50 p-4 text-sm text-rose-800">
                      {searchError}
                    </div>
                  ) : isSearching && hits.length === 0 ? (
                    <div className="p-8 text-center font-mono text-xs uppercase tracking-widest text-quiet">
                      searching…
                    </div>
                  ) : hits.length === 0 ? (
                    <div className="p-8 text-center text-sm text-muted">
                      No matches.
                    </div>
                  ) : (
                    <ul className="divide-y divide-[color:var(--border)]">
                      {hits.map((hit) => {
                        const isSelected = hit.id === selectedHitId;
                        const color = colorForProject(hit.project);
                        return (
                          <li key={hit.id}>
                            <button
                              type="button"
                              onClick={() => setSelectedHitId(hit.id)}
                              className={cn(
                                "block w-full px-4 py-3 text-left transition",
                                isSelected
                                  ? "border-l-2 border-l-[color:var(--accent)] bg-[color:var(--accent-soft)]/60"
                                  : "border-l-2 border-l-transparent hover:bg-[color:var(--surface-muted)]",
                              )}
                            >
                              <div className="flex items-center justify-between gap-3">
                                <div className="flex items-center gap-2 min-w-0">
                                  <span
                                    className="h-2 w-2 flex-shrink-0 rounded-full"
                                    style={{ backgroundColor: color }}
                                    aria-hidden
                                  />
                                  <span className="font-mono text-[10px] uppercase tracking-widest text-quiet truncate">
                                    {hit.project ?? "—"}
                                  </span>
                                  <span className="font-mono text-[10px] uppercase tracking-widest text-quiet">
                                    ·
                                  </span>
                                  <span className="font-mono text-[10px] uppercase tracking-widest text-quiet truncate">
                                    {hit.collection.replace(
                                      /_memory$/,
                                      "",
                                    )}
                                  </span>
                                </div>
                                <span className="font-mono text-[11px] text-[color:var(--accent-strong)]">
                                  {formatScore(hit.score)}
                                </span>
                              </div>
                              <p className="mt-1 truncate text-sm font-semibold text-strong">
                                {hit.section_heading || "(preamble)"}
                              </p>
                              <p
                                className="mt-1 text-[13px] leading-snug text-muted"
                                style={{
                                  display: "-webkit-box",
                                  WebkitLineClamp: SNIPPET_LINES,
                                  WebkitBoxOrient: "vertical",
                                  overflow: "hidden",
                                }}
                              >
                                {highlightSnippet(
                                  hit.preview,
                                  liveQuery,
                                  hit.id,
                                )}
                              </p>
                              {hit.source_path ? (
                                <p className="mt-1 truncate font-mono text-[10px] text-quiet">
                                  {truncatePathLeft(hit.source_path, 70)}
                                </p>
                              ) : null}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>

                {/* Detail pane (right) */}
                <section
                  aria-label="Detail"
                  className="flex min-h-0 flex-col overflow-hidden bg-[color:var(--surface)]"
                >
                  {!selectedHit ? (
                    <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted">
                      {hasQuery
                        ? "Select a result to read the full file."
                        : "Type a query to start searching."}
                    </div>
                  ) : (
                    <>
                      {/* Detail header strip */}
                      <div className="flex flex-wrap items-center gap-2 border-b border-strong bg-[color:var(--surface)] px-4 py-3">
                        <span
                          className="flex h-7 items-center gap-1.5 rounded-full border border-[color:var(--border)] bg-[color:var(--surface-muted)] px-2.5 font-mono text-[11px] text-muted"
                          aria-label="Project"
                        >
                          <span
                            className="h-2 w-2 rounded-full"
                            style={{
                              backgroundColor: colorForProject(
                                selectedHit.project,
                              ),
                            }}
                            aria-hidden
                          />
                          {selectedHit.project ?? "—"}
                        </span>
                        {selectedHit.source_path ? (
                          <span
                            className="min-w-0 flex-1 truncate font-mono text-[11px] text-quiet"
                            title={selectedHit.source_path}
                            dir="rtl"
                          >
                            {selectedHit.source_path}
                          </span>
                        ) : (
                          <span className="min-w-0 flex-1 font-mono text-[11px] text-quiet">
                            (no source path)
                          </span>
                        )}
                        <div className="flex items-center gap-1.5">
                          {selectedHit.source_path ? (
                            <a
                              href={`obsidian://open?path=${encodeURIComponent(
                                selectedHit.source_path,
                              )}`}
                              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)] px-3 font-mono text-[11px] uppercase tracking-widest text-muted hover:border-[color:var(--accent)] hover:text-[color:var(--accent)]"
                            >
                              <ExternalLink className="h-3 w-3" />
                              Obsidian
                            </a>
                          ) : null}
                          <button
                            type="button"
                            onClick={copyPath}
                            disabled={!selectedHit.source_path}
                            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)] px-3 font-mono text-[11px] uppercase tracking-widest text-muted hover:border-[color:var(--accent)] hover:text-[color:var(--accent)] disabled:opacity-50"
                          >
                            <Copy className="h-3 w-3" />
                            {copied ? "copied" : "copy path"}
                          </button>
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={findRelated}
                          >
                            <Sparkles className="h-3 w-3" />
                            Find related
                          </Button>
                        </div>
                      </div>

                      {/* Detail body */}
                      <div
                        ref={detailScrollRef}
                        className="min-h-0 flex-1 overflow-y-auto px-6 py-5"
                      >
                        {isFileLoading ? (
                          <p className="font-mono text-xs uppercase tracking-widest text-quiet">
                            loading…
                          </p>
                        ) : fileError ? (
                          <div className="rounded-xl border border-rose-300 bg-rose-50 p-4 text-sm text-rose-800">
                            {fileError}
                            <p className="mt-2 font-mono text-xs text-rose-700/80">
                              Falling back to preview.
                            </p>
                            <p className="mt-3 whitespace-pre-wrap text-sm text-rose-900">
                              {selectedHit.preview}
                            </p>
                          </div>
                        ) : fileText !== null ? (
                          <div className="prose prose-sm max-w-none text-sm leading-relaxed text-strong">
                            <Markdown
                              content={fileText}
                              variant="description"
                            />
                          </div>
                        ) : (
                          <p className="whitespace-pre-wrap text-sm text-strong">
                            {selectedHit.preview}
                          </p>
                        )}
                      </div>
                    </>
                  )}
                </section>
              </div>
            </main>
          </SignedIn>
        </>
      ) : null}
    </DashboardShell>
  );
}

// --- Empty state ------------------------------------------------------------

function EmptyState({
  onSuggestionClick,
}: {
  onSuggestionClick: (q: string) => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 py-16">
      <pre
        aria-hidden
        className="select-none whitespace-pre font-mono text-[10px] leading-tight text-quiet/60"
      >
{`╭─────────────────────────────────────╮
│  ░▒▓  scanning  ▓▒░░▒▓  the  ▓▒░    │
│  ░▒▓  brain     ▓▒░░▒▓        ▓▒░   │
╰─────────────────────────────────────╯`}
      </pre>
      <p className="mt-6 font-mono text-[11px] uppercase tracking-widest text-quiet">
        Type to search the brain
      </p>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        {SUGGESTED_QUERIES.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => onSuggestionClick(q)}
            className="rounded-full border border-[color:var(--border)] bg-[color:var(--surface)] px-3 py-1 font-mono text-[11px] text-muted hover:border-[color:var(--accent)] hover:text-[color:var(--accent)]"
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}
