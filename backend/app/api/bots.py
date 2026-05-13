"""Bots control surface — Phase 1 (observability).

Powers the `/bots` page in Mission Control: a single read-only view of
every bot container under the `bot-events-tap`'s purview, plus a few
enrichments stitched together from the tap snapshot, the event ring
buffer, and Qdrant memory counts.

Data sources
------------
1. `/var/lib/bot-events/bot-status.json` — written by the tap every
   ~30s via `docker inspect`. Authoritative for container state.
2. `/var/lib/bot-events/bot-events.jsonl` — the rolling ~1000-line
   event ring buffer. We tail it for `last_event_at` and the
   `events_last_hour` count, scoped per bot.
3. Qdrant `/collections/bakhoum_ops_memory` — for memory chunk counts
   per bot (filtered by `payload.project == primary_project_tag`) and
   for persona existence (a SOUL.md row filter).

Design choices
--------------
- The endpoint never touches docker.sock. Only the tap holds that
  capability; the backend reads its file snapshots. Smaller blast
  radius, simpler container surface area.
- Phase 1 is read-only — no restart, no kill, no exec. The frontend
  shows a disabled "Restart" button so the affordance is visible but
  the wire is not yet hot. Phase 2 will add the action endpoints.
- We do not error on a missing snapshot file or unreachable Qdrant —
  the response degrades gracefully so the page is still useful when
  one sub-system is down.

Auth: reuses `require_user_or_agent` — same gate as the bot-events
stream. No new auth surface.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.api.deps import ActorContext, require_user_or_agent

router = APIRouter(prefix="/bots", tags=["bots"])

ACTOR_DEP = Depends(require_user_or_agent)

# --- Config -----------------------------------------------------------------

# The bot_events named volume is mounted read-only into the MC backend at
# /var/lib/bot-events. Both files live alongside each other there.
BOT_EVENTS_DIR = Path(
    os.environ.get("BOT_EVENTS_DIR", "/var/lib/bot-events"),
)
BOT_STATUS_PATH = Path(
    os.environ.get(
        "BOT_STATUS_PATH",
        str(BOT_EVENTS_DIR / "bot-status.json"),
    ),
)
BOT_EVENTS_PATH = Path(
    os.environ.get(
        "BOT_EVENTS_FILE",
        str(BOT_EVENTS_DIR / "bot-events.jsonl"),
    ),
)

# Qdrant base url (same default the memory-search endpoint uses).
QDRANT_BASE = os.environ.get("MEMORY_SEARCH_QDRANT_BASE", "http://qdrant:6333")

# Memory collection for bot personas + chunk counts. Configurable so the
# eventual per-bot collection split (one collection per bot) can land
# without a code change.
BOT_MEMORY_COLLECTION = os.environ.get(
    "BOTS_MEMORY_COLLECTION",
    "bakhoum_ops_memory",
)

# How far back to count "events last hour" — kept in a constant so tests
# can tune it without flaking on real-time data.
EVENTS_LOOKBACK = timedelta(hours=1)

# Cap the event tail we scan. 1000 matches the tap's ring-buffer size, so
# this is "the whole buffer" in practice — but explicit for safety.
EVENT_TAIL_LINES = 1000

HTTP_TIMEOUT_S = 5.0

# Path-traversal defense for the persona_source_path field — same lexical
# prefix the memory-search file endpoint uses.
PERSONA_ROOT = "/opt/data/memory/"

# Persona filename. SOUL.md is the convention across bakhoum_ops,
# household, and trips memory directories.
PERSONA_FILENAME = "SOUL.md"


# --- Schemas ----------------------------------------------------------------


class BotInfo(BaseModel):
    """One row of the /bots response."""

    name: str
    display_name: str
    state: str
    started_at: str | None = None
    uptime_seconds: int | None = None
    restart_count: int = 0
    image: str | None = None
    health: str | None = None
    primary_project_tag: str | None = None

    last_event_at: str | None = None
    events_last_hour: int = 0

    memory_chunks: int = 0
    persona_source_path: str | None = None
    persona_exists: bool = False


class BotsResponse(BaseModel):
    """Wrapper so future top-level fields (e.g. tap_health) can be added."""

    generated_at: str
    bots: list[BotInfo]


# --- Snapshot loader --------------------------------------------------------


def _load_status_snapshot() -> dict[str, Any]:
    """Read the tap's status snapshot. Returns an empty stub if missing.

    Treat any kind of read or parse failure as "snapshot unavailable" —
    the endpoint then returns an empty bots list rather than 500-ing.
    The /bots page surfaces this as a gentle "no bots seen yet" state.
    """
    try:
        raw = BOT_STATUS_PATH.read_text(encoding="utf-8")
    except (FileNotFoundError, OSError):
        return {"generated_at": _now_iso(), "bots": []}
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return {"generated_at": _now_iso(), "bots": []}
    if not isinstance(parsed, dict):
        return {"generated_at": _now_iso(), "bots": []}
    bots = parsed.get("bots")
    if not isinstance(bots, list):
        parsed["bots"] = []
    if not isinstance(parsed.get("generated_at"), str):
        parsed["generated_at"] = _now_iso()
    return parsed


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


# --- Event tail aggregation -------------------------------------------------


def _read_event_tail(limit: int) -> list[dict[str, Any]]:
    """Return up to `limit` trailing events parsed from the JSONL file."""
    try:
        with BOT_EVENTS_PATH.open("r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except FileNotFoundError:
        return []
    except OSError:
        return []
    tail = lines[-limit:] if limit > 0 else lines
    events: list[dict[str, Any]] = []
    for line in tail:
        line = line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            continue
        if isinstance(parsed, dict):
            events.append(parsed)
    return events


def _aggregate_events(
    events: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    """Group events by both bot id and container name.

    Returns a dict keyed by either name → {last_ts, last_dt, count_hour}.
    Indexing by both makes the per-bot join work whether the snapshot
    row's `primary_project_tag` matches the event's `bot` (the modern
    case) or only its `container` (older containers without a stable
    bot id).
    """
    now = datetime.now(timezone.utc)
    cutoff = now - EVENTS_LOOKBACK
    aggregates: dict[str, dict[str, Any]] = {}
    for event in events:
        ts_raw = event.get("ts")
        if not isinstance(ts_raw, str):
            continue
        ts_norm = ts_raw.replace("Z", "+00:00")
        try:
            ts = datetime.fromisoformat(ts_norm)
        except ValueError:
            continue
        # Treat naive timestamps as UTC — the tap always writes tz-aware
        # but a custom test fixture might not.
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        for key_field in ("bot", "container"):
            key = event.get(key_field)
            if not isinstance(key, str) or not key:
                continue
            bucket = aggregates.setdefault(
                key,
                {"last_dt": None, "last_ts": None, "count_hour": 0},
            )
            if bucket["last_dt"] is None or ts > bucket["last_dt"]:
                bucket["last_dt"] = ts
                bucket["last_ts"] = ts_raw
            if ts >= cutoff:
                bucket["count_hour"] += 1
    return aggregates


# --- Qdrant lookups ---------------------------------------------------------


async def _qdrant_count(
    client: httpx.AsyncClient,
    project_tag: str,
) -> int:
    """Count memory points for one bot's project tag. 0 on any failure."""
    url = f"{QDRANT_BASE}/collections/{BOT_MEMORY_COLLECTION}/points/count"
    body = {
        "filter": {
            "must": [
                {"key": "project", "match": {"value": project_tag}},
            ],
        },
        # exact=true is required: Qdrant's approximate path ignores filters
        # and returns the segment-level total (~2103) regardless of project.
        "exact": True,
    }
    try:
        resp = await client.post(url, json=body, timeout=HTTP_TIMEOUT_S)
    except httpx.HTTPError:
        return 0
    if resp.status_code != httpx.codes.OK:
        return 0
    try:
        payload = resp.json()
    except ValueError:
        return 0
    result = payload.get("result")
    if isinstance(result, dict):
        count = result.get("count")
        if isinstance(count, int):
            return max(0, count)
    return 0


async def _qdrant_persona(
    client: httpx.AsyncClient,
    project_tag: str,
) -> tuple[bool, str | None]:
    """Look up a SOUL.md row in Qdrant for `project_tag`.

    Returns (persona_exists, persona_source_path). We use the scroll
    endpoint with a text match on `source` so a small payload comes back
    even if there are many chunks. Path-traversal is defended by the
    lexical PERSONA_ROOT prefix check on the returned source path.
    """
    url = f"{QDRANT_BASE}/collections/{BOT_MEMORY_COLLECTION}/points/scroll"
    body = {
        "limit": 1,
        "with_payload": True,
        "with_vector": False,
        "filter": {
            "must": [
                {"key": "project", "match": {"value": project_tag}},
                {
                    "should": [
                        {"key": "source", "match": {"text": PERSONA_FILENAME}},
                        {
                            "key": "source_path",
                            "match": {"text": PERSONA_FILENAME},
                        },
                    ],
                },
            ],
        },
    }
    try:
        resp = await client.post(url, json=body, timeout=HTTP_TIMEOUT_S)
    except httpx.HTTPError:
        return (False, None)
    if resp.status_code != httpx.codes.OK:
        return (False, None)
    try:
        payload = resp.json()
    except ValueError:
        return (False, None)
    result = payload.get("result") or {}
    points = result.get("points") if isinstance(result, dict) else None
    if not isinstance(points, list) or not points:
        return (False, None)
    point = points[0] or {}
    raw_payload = point.get("payload") or {}
    candidate = (
        raw_payload.get("source_path")
        or raw_payload.get("source")
        or None
    )
    if isinstance(candidate, str) and candidate.startswith(PERSONA_ROOT):
        return (True, candidate)
    # Fallback: synthesize a conventional path. Even if Qdrant's row uses
    # a relative filename, the canonical layout is
    # /opt/data/memory/<project>/SOUL.md. We only return it when we have
    # a positive Qdrant signal that the persona exists.
    synthesized = f"{PERSONA_ROOT}{project_tag}/{PERSONA_FILENAME}"
    return (True, synthesized)


# --- Endpoint ---------------------------------------------------------------


@router.get(
    "",
    response_model=BotsResponse,
    summary="List bot containers and observability metadata",
    description=(
        "Returns one row per container tapped by bot-events-tap, "
        "enriched with last-event time, last-hour event count, "
        "memory chunk count, and persona-doc existence."
    ),
)
async def list_bots(
    _actor: ActorContext = ACTOR_DEP,
) -> BotsResponse:
    """Read-only bot control surface for the /bots page."""
    snapshot = _load_status_snapshot()
    rows = snapshot.get("bots") or []
    events = _read_event_tail(EVENT_TAIL_LINES)
    aggregates = _aggregate_events(events)

    async with httpx.AsyncClient() as client:
        enriched: list[BotInfo] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            name = str(row.get("name") or "").strip()
            if not name:
                continue
            project_tag = (
                str(row.get("primary_project_tag") or "").strip()
                or None
            )
            display_name = str(row.get("display_name") or name)
            state = str(row.get("state") or "unknown")
            started_at = row.get("started_at")
            uptime_seconds = row.get("uptime_seconds")
            restart_count = row.get("restart_count") or 0
            image = row.get("image")
            health = row.get("health")

            # Event aggregates — join on bot id first, fall back to
            # container name so older containers without a CONTAINER_TO_BOT
            # mapping still light up.
            bucket: dict[str, Any] = {}
            if project_tag and project_tag in aggregates:
                bucket = aggregates[project_tag]
            elif name in aggregates:
                bucket = aggregates[name]
            last_event_at = bucket.get("last_ts") if bucket else None
            events_last_hour = int(bucket.get("count_hour", 0)) if bucket else 0

            # Memory/persona — only meaningful when we have a project tag.
            memory_chunks = 0
            persona_exists = False
            persona_path: str | None = None
            if project_tag:
                memory_chunks = await _qdrant_count(client, project_tag)
                persona_exists, persona_path = await _qdrant_persona(
                    client, project_tag,
                )

            enriched.append(
                BotInfo(
                    name=name,
                    display_name=display_name,
                    state=state,
                    started_at=started_at if isinstance(started_at, str) else None,
                    uptime_seconds=(
                        int(uptime_seconds)
                        if isinstance(uptime_seconds, (int, float))
                        and uptime_seconds is not None
                        else None
                    ),
                    restart_count=(
                        int(restart_count)
                        if isinstance(restart_count, (int, float))
                        else 0
                    ),
                    image=str(image) if isinstance(image, str) else None,
                    health=str(health) if isinstance(health, str) else None,
                    primary_project_tag=project_tag,
                    last_event_at=last_event_at
                    if isinstance(last_event_at, str)
                    else None,
                    events_last_hour=max(0, events_last_hour),
                    memory_chunks=memory_chunks,
                    persona_source_path=persona_path,
                    persona_exists=persona_exists,
                )
            )

    generated_at = snapshot.get("generated_at") or _now_iso()
    return BotsResponse(generated_at=str(generated_at), bots=enriched)
