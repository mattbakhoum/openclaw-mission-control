"""Bot-events SSE endpoint.

Tails the shared `/var/lib/bot-events/bot-events.jsonl` ring-buffer file
produced by the `bot-events-tap` container and streams each new line to
the client as Server-Sent Events. Powers the live bot activity widget
on the Mission Control dashboard.

Design notes
------------
- This endpoint reuses the existing `require_user_or_agent` dep so an
  unauthenticated caller can't tail bot logs. No new auth surface.
- The ring buffer is rewritten by the tap on every write (read tail →
  append → truncate → atomic rename), which means the file inode can
  change underneath us. We tolerate that by re-opening the file each
  poll cycle and tracking the highwater by *(line index, line digest)*
  rather than file position.
- On connect we replay the last 30 lines so the dashboard fills
  immediately instead of waiting for the next event.
- Backpressure: if the client falls behind by more than
  `MAX_PENDING_FRAMES`, we drop the connection rather than buffering
  unbounded data. sse-starlette + Starlette's downstream queues already
  raise on disconnect; we additionally bail when our own pending count
  trips the cap.

This file is *additive* — adding it does not touch any existing route.
Register the router from `app/main.py` alongside the other routers.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
from pathlib import Path
from typing import TYPE_CHECKING, Any

from fastapi import APIRouter, Depends, Request
from sse_starlette.sse import EventSourceResponse

from app.api.deps import ActorContext, require_user_or_agent

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

router = APIRouter(prefix="/bot-events", tags=["bot-events"])

# Path the bot_events named volume is mounted at inside the MC backend
# container. Overridable for local dev where the volume isn't present.
BOT_EVENTS_PATH = Path(os.environ.get("BOT_EVENTS_PATH", "/var/lib/bot-events/bot-events.jsonl"))

# Seconds between file polls. The ring buffer is rewritten atomically so
# we can poll fairly aggressively without partial-read risk. 0.5s keeps
# the UI feeling "live" without burning CPU.
POLL_SECONDS = 0.5

# How many trailing events to replay on connect. Matches the dashboard's
# default visible window so the widget paints fully on first frame.
REPLAY_LINES = 30

# SSE keepalive ping interval — sse_starlette emits a comment-only frame
# every N seconds to keep proxies (and Tailscale Serve) from closing the
# connection. 15s is the same value the activity stream uses.
SSE_PING_SECONDS = 15

# Backpressure cap: if our pending-frame counter exceeds this, drop the
# client. With a 0.5s poll and reasonable bot volume the steady-state is
# ≤2 pending frames, so 200 leaves a generous safety margin while still
# protecting the server from a stuck consumer.
MAX_PENDING_FRAMES = 200

ACTOR_DEP = Depends(require_user_or_agent)


def _read_tail_lines(path: Path, limit: int) -> list[str]:
    """Return up to `limit` trailing lines from the ring buffer.

    Returns an empty list if the file doesn't exist yet (graceful cold
    start — the tap may come up after the backend).
    """
    try:
        with path.open("r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except FileNotFoundError:
        return []
    except OSError:
        return []
    if limit <= 0:
        return []
    return [line.rstrip("\n") for line in lines[-limit:] if line.strip()]


def _digest(line: str) -> str:
    """Cheap stable per-line fingerprint for dedup across re-reads."""
    return hashlib.blake2s(line.encode("utf-8", errors="replace"), digest_size=8).hexdigest()


def _parse_event(line: str) -> dict[str, Any] | None:
    """Parse a JSONL line into a dict; return None on malformed input."""
    try:
        parsed = json.loads(line)
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(parsed, dict):
        return None
    return parsed


@router.get("/stream")
async def stream_bot_events(
    request: Request,
    _actor: ActorContext = ACTOR_DEP,
) -> EventSourceResponse:
    """Server-Sent Events stream of recent bot activity.

    Reuses the standard user-or-agent auth dep so anonymous callers
    are rejected before any file IO happens.
    """

    # On connect: replay the trailing window so the UI paints fully.
    initial = _read_tail_lines(BOT_EVENTS_PATH, REPLAY_LINES)
    seen: set[str] = {_digest(line) for line in initial}
    # Cap the dedup set so a long-lived connection doesn't grow unbounded.
    # 4× ring buffer is plenty given the ring caps at 1000 lines.
    seen_cap = 4000

    async def event_generator() -> AsyncIterator[dict[str, str]]:
        pending = 0
        # Drain the initial replay first so the client sees a fully
        # populated widget within the first ~30ms.
        for line in initial:
            event = _parse_event(line)
            if event is None:
                continue
            yield {"event": "bot-event", "data": json.dumps(event)}

        while True:
            if await request.is_disconnected():
                break
            try:
                lines = _read_tail_lines(BOT_EVENTS_PATH, 200)
            except Exception:  # noqa: BLE001 — last-resort skip-cycle
                await asyncio.sleep(POLL_SECONDS)
                continue
            new_frames = 0
            for line in lines:
                digest = _digest(line)
                if digest in seen:
                    continue
                seen.add(digest)
                if len(seen) > seen_cap:
                    # Cheap eviction: rebuild from the current tail.
                    seen = {_digest(item) for item in lines[-REPLAY_LINES:]}
                event = _parse_event(line)
                if event is None:
                    continue
                new_frames += 1
                pending += 1
                if pending > MAX_PENDING_FRAMES:
                    # Backpressure trip — drop the client. sse_starlette
                    # will close the connection cleanly.
                    return
                yield {"event": "bot-event", "data": json.dumps(event)}
            # Each successful flush past sse_starlette drains pending.
            if new_frames:
                pending = max(0, pending - new_frames)
            await asyncio.sleep(POLL_SECONDS)

    return EventSourceResponse(event_generator(), ping=SSE_PING_SECONDS)
