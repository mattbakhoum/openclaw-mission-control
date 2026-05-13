"""Live dashboard KPI endpoints — wired to real data sources.

Sibling of app.api.metrics (which serves the existing /api/v1/metrics/dashboard
aggregation). This module exposes lightweight live-counter endpoints for
the dashboard hero tiles: memory chunk counts, FreshRSS unread, Langfuse
trace counts, bot-event aggregates, and search-query stats.

Every endpoint here:
- Reuses require_user_or_agent auth dep.
- Caches 15-60s in-process so dashboard refreshes don't hammer upstreams.
- Degrades to null/zero on upstream errors rather than 500ing.

Mount at /api/v1/live-metrics to avoid collision with the existing metrics
router prefix.
"""
from __future__ import annotations

import base64
import json
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.api.deps import ActorContext, require_user_or_agent

router = APIRouter(prefix="/live-metrics", tags=["live-metrics"])
ACTOR_DEP = Depends(require_user_or_agent)
TIMEOUT = 8.0

QDRANT_BASE = os.environ.get("MEMORY_SEARCH_QDRANT_BASE", "http://qdrant:6333")
QDRANT_COLLECTIONS = ["bakhoum_ops_memory", "sort_atlas"]

LANGFUSE_BASE = os.environ.get("LANGFUSE_BASE", "http://langfuse-web:3000")
LANGFUSE_PUBLIC_KEY = os.environ.get("LANGFUSE_INIT_PROJECT_PUBLIC_KEY", "")
LANGFUSE_SECRET_KEY = os.environ.get("LANGFUSE_INIT_PROJECT_SECRET_KEY", "")

FRESHRSS_BASE = os.environ.get("FRESHRSS_BASE", "http://freshrss")
FRESHRSS_USER = os.environ.get("FRESHRSS_USER", "")
FRESHRSS_API_PASSWORD = os.environ.get("FRESHRSS_API_PASSWORD", "")

BOT_EVENTS_PATH = Path(os.environ.get("BOT_EVENTS_FILE", "/var/lib/bot-events/bot-events.jsonl"))
METRICS_DIR = Path(os.environ.get("METRICS_DIR", "/var/lib/metrics"))
SEARCHES_PATH = METRICS_DIR / "searches.jsonl"


_CACHE: dict[str, tuple[float, Any]] = {}


def _cache_get(key: str, ttl: float):
    rec = _CACHE.get(key)
    if not rec:
        return None
    ts, val = rec
    return val if time.time() - ts <= ttl else None


def _cache_set(key: str, val: Any) -> None:
    _CACHE[key] = (time.time(), val)


# ----- response models -------------------------------------------------------

class MemoryCount(BaseModel):
    counts: dict[str, int]
    total: int


class FeedStats(BaseModel):
    unread_count: int | None = None
    error: str | None = None


class TraceStats(BaseModel):
    traces_today: int | None = None
    traces_total: int | None = None
    error: str | None = None


class BotEventsSummary(BaseModel):
    events_last_hour: int
    events_last_24h: int
    by_bot: dict[str, int]
    newest_event_at: str | None = None
    hourly_buckets_24h: list[int]


class SearchStats(BaseModel):
    queries_24h: int
    top_queries: list[dict[str, Any]]


# ----- endpoints -------------------------------------------------------------

@router.get("/memory-count", response_model=MemoryCount)
async def memory_count(_actor: ActorContext = ACTOR_DEP) -> MemoryCount:
    cached = _cache_get("memory-count", ttl=20)
    if cached:
        return cached
    counts: dict[str, int] = {}
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        for col in QDRANT_COLLECTIONS:
            try:
                r = await client.post(
                    f"{QDRANT_BASE}/collections/{col}/points/count",
                    json={"exact": True},
                )
                r.raise_for_status()
                counts[col] = int(r.json()["result"]["count"])
            except Exception:
                counts[col] = 0
    out = MemoryCount(counts=counts, total=sum(counts.values()))
    _cache_set("memory-count", out)
    return out


@router.get("/feed-stats", response_model=FeedStats)
async def feed_stats(_actor: ActorContext = ACTOR_DEP) -> FeedStats:
    if not (FRESHRSS_USER and FRESHRSS_API_PASSWORD):
        return FeedStats(error="no creds")
    cached = _cache_get("feed-stats", ttl=60)
    if cached:
        return cached
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            auth = await client.post(
                f"{FRESHRSS_BASE}/api/greader.php/accounts/ClientLogin",
                data={"Email": FRESHRSS_USER, "Passwd": FRESHRSS_API_PASSWORD},
            )
            sid = ""
            for line in auth.text.splitlines():
                if line.startswith("SID="):
                    sid = line.split("=", 1)[1]
                    break
            if not sid:
                return FeedStats(error=f"login {auth.status_code}")
            r = await client.get(
                f"{FRESHRSS_BASE}/api/greader.php/reader/api/0/unread-count?output=json",
                headers={"Authorization": f"GoogleLogin auth={sid}"},
            )
            r.raise_for_status()
            data = r.json()
            unread = 0
            for c in data.get("unreadcounts", []):
                if c.get("id", "").startswith("feed/"):
                    unread += int(c.get("count", 0))
            out = FeedStats(unread_count=unread)
            _cache_set("feed-stats", out)
            return out
    except Exception as e:
        return FeedStats(error=type(e).__name__)


@router.get("/trace-stats", response_model=TraceStats)
async def trace_stats(_actor: ActorContext = ACTOR_DEP) -> TraceStats:
    if not (LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY):
        return TraceStats(error="no langfuse keys")
    cached = _cache_get("trace-stats", ttl=30)
    if cached:
        return cached
    creds = base64.b64encode(
        f"{LANGFUSE_PUBLIC_KEY}:{LANGFUSE_SECRET_KEY}".encode()
    ).decode()
    headers = {"Authorization": f"Basic {creds}"}
    today_iso = (
        datetime.now(timezone.utc)
        .replace(hour=0, minute=0, second=0, microsecond=0)
        .isoformat()
    )
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            r = await client.get(
                f"{LANGFUSE_BASE}/api/public/traces",
                params={"limit": 1, "fromTimestamp": today_iso},
                headers=headers,
            )
            r.raise_for_status()
            today = int((r.json().get("meta") or {}).get("totalItems", 0))
            r2 = await client.get(
                f"{LANGFUSE_BASE}/api/public/traces", params={"limit": 1}, headers=headers
            )
            r2.raise_for_status()
            total = int((r2.json().get("meta") or {}).get("totalItems", 0))
            out = TraceStats(traces_today=today, traces_total=total)
            _cache_set("trace-stats", out)
            return out
    except Exception as e:
        return TraceStats(error=type(e).__name__)


@router.get("/bot-events-summary", response_model=BotEventsSummary)
async def bot_events_summary(_actor: ActorContext = ACTOR_DEP) -> BotEventsSummary:
    cached = _cache_get("bot-events-summary", ttl=15)
    if cached:
        return cached
    now = datetime.now(timezone.utc)
    hour_ago = now - timedelta(hours=1)
    day_ago = now - timedelta(hours=24)
    buckets = [0] * 24
    h_total = 0
    d_total = 0
    by_bot: dict[str, int] = {}
    newest: datetime | None = None
    if BOT_EVENTS_PATH.exists():
        try:
            with BOT_EVENTS_PATH.open("rb") as f:
                for raw in f:
                    try:
                        ev = json.loads(raw)
                    except Exception:
                        continue
                    ts_s = ev.get("ts")
                    if not ts_s:
                        continue
                    try:
                        ts = datetime.fromisoformat(str(ts_s).replace("Z", "+00:00"))
                    except Exception:
                        continue
                    if newest is None or ts > newest:
                        newest = ts
                    bot = ev.get("bot") or "unknown"
                    if ts >= day_ago:
                        d_total += 1
                        by_bot[bot] = by_bot.get(bot, 0) + 1
                        hours_back = int((now - ts).total_seconds() // 3600)
                        if 0 <= hours_back < 24:
                            buckets[23 - hours_back] += 1
                    if ts >= hour_ago:
                        h_total += 1
        except Exception:
            pass
    out = BotEventsSummary(
        events_last_hour=h_total,
        events_last_24h=d_total,
        by_bot=by_bot,
        newest_event_at=newest.isoformat() if newest else None,
        hourly_buckets_24h=buckets,
    )
    _cache_set("bot-events-summary", out)
    return out


@router.get("/search-stats", response_model=SearchStats)
async def search_stats(_actor: ActorContext = ACTOR_DEP) -> SearchStats:
    if not SEARCHES_PATH.exists():
        return SearchStats(queries_24h=0, top_queries=[])
    now = datetime.now(timezone.utc)
    day_ago = now - timedelta(hours=24)
    count = 0
    by_q: dict[str, int] = {}
    try:
        with SEARCHES_PATH.open("rb") as f:
            for raw in f:
                try:
                    ev = json.loads(raw)
                except Exception:
                    continue
                try:
                    ts = datetime.fromisoformat(str(ev.get("ts", "")).replace("Z", "+00:00"))
                except Exception:
                    continue
                if ts < day_ago:
                    continue
                count += 1
                q = (ev.get("query") or "").strip().lower()[:80]
                if q:
                    by_q[q] = by_q.get(q, 0) + 1
    except Exception:
        pass
    top = sorted(by_q.items(), key=lambda x: x[1], reverse=True)[:5]
    return SearchStats(
        queries_24h=count,
        top_queries=[{"query": q, "count": c} for q, c in top],
    )
