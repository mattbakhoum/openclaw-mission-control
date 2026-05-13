"use client";

import { useEffect, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";

const LANGFUSE_URL =
  process.env.NEXT_PUBLIC_LANGFUSE_URL ?? "https://forge.tail2cdf70.ts.net:8090";

export default function TracesPage() {
  const [iframeKey, setIframeKey] = useState(0);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold text-strong">Traces</h1>
          <p className="text-xs text-muted">
            Self-hosted Langfuse for LLM trace observability. Embedded from{" "}
            <code className="rounded bg-[color:var(--surface-muted)] px-1.5 py-0.5 text-[11px]">
              {LANGFUSE_URL}
            </code>
            .
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setIframeKey((k) => k + 1)}
            className="flex items-center gap-1.5 rounded-md border border-strong px-3 py-1.5 text-xs font-medium text-muted transition hover:bg-[color:var(--surface-muted)]"
            title="Reload trace viewer"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Reload
          </button>
          <a
            href={LANGFUSE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 rounded-md bg-[color:var(--accent)] px-3 py-1.5 text-xs font-medium text-white transition hover:bg-[color:var(--accent-strong)]"
          >
            Open full app
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>
      <div className="relative flex-1 bg-[color:var(--surface-muted)]">
        {mounted ? (
          <iframe
            key={iframeKey}
            src={LANGFUSE_URL}
            className="absolute inset-0 h-full w-full border-0"
            title="Langfuse trace explorer"
            allow="clipboard-read; clipboard-write"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted">
            Loading trace viewer…
          </div>
        )}
      </div>
    </div>
  );
}
