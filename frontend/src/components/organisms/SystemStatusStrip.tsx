"use client";

import { useEffect, useState } from "react";

type ServiceStatus = "live" | "down" | "checking";

type Service = {
  name: string;
  url: string;
  // a status of 2xx (or 3xx for some) counts as live
  okCodes?: number[];
};

const SERVICES: Service[] = [
  { name: "MC API", url: "/api/healthz" },
  { name: "Langfuse", url: "https://forge.tail2cdf70.ts.net:8090/api/public/health" },
  { name: "FreshRSS", url: "https://forge.tail2cdf70.ts.net:8091/", okCodes: [200, 302] },
  { name: "Qdrant", url: "https://forge.tail2cdf70.ts.net/qdrant/" },
  { name: "RSSHub", url: "https://forge.tail2cdf70.ts.net:8091/", okCodes: [200, 302] },
];

const POLL_MS = 30_000;

async function probe(svc: Service): Promise<ServiceStatus> {
  try {
    const res = await fetch(svc.url, {
      method: "GET",
      cache: "no-store",
      // For cross-origin probes we rely on the request landing — even an opaque
      // response means the host is reachable. mode: "no-cors" returns opaque.
      mode: svc.url.startsWith("http") ? "no-cors" : "same-origin",
    });
    if (res.type === "opaque") return "live";
    if ((svc.okCodes ?? [200]).includes(res.status)) return "live";
    return res.status >= 200 && res.status < 400 ? "live" : "down";
  } catch {
    return "down";
  }
}

export function SystemStatusStrip() {
  const [statuses, setStatuses] = useState<ServiceStatus[]>(
    SERVICES.map(() => "checking"),
  );

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const next = await Promise.all(SERVICES.map(probe));
      if (!cancelled) setStatuses(next);
    };
    run();
    const id = setInterval(run, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-quiet md:px-6">
      <span className="text-[color:var(--accent)]">SYSTEM</span>
      {SERVICES.map((svc, i) => {
        const s = statuses[i];
        return (
          <span key={svc.name} className="flex items-center gap-1.5">
            <span
              className={
                s === "live"
                  ? "h-1.5 w-1.5 rounded-full bg-emerald-500 animate-constellation-pulse shadow-[0_0_6px_rgba(16,185,129,0.65)]"
                  : s === "down"
                  ? "h-1.5 w-1.5 rounded-full bg-rose-500 shadow-[0_0_6px_rgba(244,63,94,0.65)]"
                  : "h-1.5 w-1.5 rounded-full bg-amber-400"
              }
              aria-label={s}
            />
            <span>{svc.name}</span>
          </span>
        );
      })}
      <span className="ml-auto text-quiet">
        polled {Math.round(POLL_MS / 1000)}s
      </span>
    </div>
  );
}
