"""Memory semantic-search endpoint backing the work-mode `/search` page.

Companion to the 3D constellation: where /constellation is the "wow demo"
that PCAs the entire memory graph into 3-space, this endpoint is the
work surface — query → ranked text hits → click through to full file.

Flow:
    POST /api/v1/memory-search
      1. Embed `query` via Ollama (nomic-embed-text:latest) at
         http://host.docker.internal:11434/api/embeddings
      2. For each requested collection (default both bakhoum_ops_memory
         and sort_atlas), POST to qdrant /points/search with the embedding
         plus an optional payload.project IN filter.
      3. Merge, sort by score, return top `limit` hits.

    GET /api/v1/memory-search/file?path=...
      Returns the raw markdown text of a memory file. The path MUST live
      under /opt/data/memory/ — anything else is rejected with 400 to
      defend against path traversal.

HTTP client: uses httpx 0.28.1 (already pinned in backend/pyproject.toml).

Auth: reuses `require_user_or_agent` from app.api.deps so the endpoint is
gated the same way as the bot-events stream — no new auth surface added.

This file is additive — wire it into `app/main.py` alongside the other
routers. Nothing else needs to change.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.api.deps import ActorContext, require_user_or_agent

router = APIRouter(prefix="/memory-search", tags=["memory-search"])

ACTOR_DEP = Depends(require_user_or_agent)

# --- Config -----------------------------------------------------------------

# Inside the MC backend container, Ollama lives on the docker host. The
# default `host.docker.internal` mapping works on Docker Desktop + the
# linux-with-host-gateway setup used on FORGE.
OLLAMA_URL = os.environ.get(
    "MEMORY_SEARCH_OLLAMA_URL",
    "http://host.docker.internal:11434/api/embeddings",
)
OLLAMA_MODEL = os.environ.get(
    "MEMORY_SEARCH_OLLAMA_MODEL",
    "nomic-embed-text:latest",
)

# Qdrant runs in the same compose network as the backend, so the
# service-name hostname is the right default.
QDRANT_BASE = os.environ.get("MEMORY_SEARCH_QDRANT_BASE", "http://qdrant:6333")

# All memory markdown files live under /opt/data/memory/. The file-fetch
# endpoint will refuse to read anything outside this root.
MEMORY_ROOT = Path(
    os.environ.get("MEMORY_SEARCH_FILE_ROOT", "/opt/data/memory"),
).resolve()

# Collections we know how to query. Keep this in sync with the constellation.
DEFAULT_COLLECTIONS = ("bakhoum_ops_memory", "sort_atlas")

# Hit-list size caps — small enough to keep latency tight on a single query.
DEFAULT_LIMIT = 20
MAX_LIMIT = 50

# Per-hit preview cap. The Qdrant payload already holds a preview string,
# but we trim to a sane upper bound so the response stays cheap to ship.
MAX_PREVIEW_CHARS = 1500

# Outbound HTTP timeout. Embeddings are usually <300 ms on a 4090; the
# 10 s ceiling matches what the spec asks for and is well above p99.
HTTP_TIMEOUT_S = 10.0


# --- Schemas ----------------------------------------------------------------


class MemorySearchRequest(BaseModel):
    """Input for the POST search endpoint."""

    query: str = Field(..., min_length=1, max_length=2000)
    limit: int = Field(DEFAULT_LIMIT, ge=1, le=MAX_LIMIT)
    projects: list[str] = Field(default_factory=list)
    collections: list[str] = Field(default_factory=list)


class MemorySearchHit(BaseModel):
    """One ranked hit returned in the response list."""

    id: str
    score: float
    collection: str
    project: str | None = None
    section_heading: str | None = None
    source_path: str | None = None
    preview: str = ""
    user_id: str | None = None
    agent_id: str | None = None
    tag: str | None = None


class MemorySearchResponse(BaseModel):
    """Response wrapper — single key keeps the door open for future fields."""

    hits: list[MemorySearchHit]


class MemoryFileResponse(BaseModel):
    """Response payload for the file-fetch helper."""

    path: str
    content: str
    bytes: int


# --- Helpers ----------------------------------------------------------------


async def _embed_query(client: httpx.AsyncClient, query: str) -> list[float]:
    """Embed `query` via Ollama's nomic-embed-text model."""
    try:
        resp = await client.post(
            OLLAMA_URL,
            json={"model": OLLAMA_MODEL, "prompt": query},
            timeout=HTTP_TIMEOUT_S,
        )
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Embedding request failed: {exc!s}",
        ) from exc
    if resp.status_code != httpx.codes.OK:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Embedding service returned {resp.status_code}",
        )
    payload = resp.json()
    embedding = payload.get("embedding")
    if not isinstance(embedding, list) or not embedding:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Embedding service returned no vector",
        )
    return [float(v) for v in embedding]


def _build_qdrant_filter(projects: list[str]) -> dict[str, Any] | None:
    """Build a Qdrant filter for `payload.project IN projects`."""
    cleaned = [p for p in projects if isinstance(p, str) and p.strip()]
    if not cleaned:
        return None
    return {
        "must": [
            {
                "key": "project",
                "match": {"any": cleaned},
            },
        ],
    }


async def _search_collection(
    client: httpx.AsyncClient,
    collection: str,
    vector: list[float],
    limit: int,
    qdrant_filter: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    """POST to qdrant `/points/search` and return the raw `result` array."""
    body: dict[str, Any] = {
        "vector": vector,
        "limit": limit,
        "with_payload": True,
    }
    if qdrant_filter is not None:
        body["filter"] = qdrant_filter
    url = f"{QDRANT_BASE}/collections/{collection}/points/search"
    try:
        resp = await client.post(url, json=body, timeout=HTTP_TIMEOUT_S)
    except httpx.HTTPError:
        # A missing collection or transient qdrant blip shouldn't blow up
        # the whole search — just skip this collection.
        return []
    if resp.status_code != httpx.codes.OK:
        return []
    payload = resp.json()
    result = payload.get("result")
    if not isinstance(result, list):
        return []
    return result


def _hit_from_qdrant(point: dict[str, Any], collection: str) -> MemorySearchHit | None:
    """Map a Qdrant point dict into our response schema."""
    point_id = point.get("id")
    score = point.get("score")
    if point_id is None or score is None:
        return None
    raw_payload = point.get("payload") or {}
    if not isinstance(raw_payload, dict):
        raw_payload = {}
    # mem0 stores the chunk body in `data`; sort_atlas-style ingest may use
    # `preview` directly. Fall through several common keys so this handles
    # both the production bakhoum_ops_memory schema and the atlas schema.
    preview_raw = (
        raw_payload.get("data")
        or raw_payload.get("memory")
        or raw_payload.get("text")
        or raw_payload.get("preview")
        or ""
    )
    preview = str(preview_raw)[:MAX_PREVIEW_CHARS]
    # source_path lives under either `source_path` (atlas) or `source` (mem0)
    src = raw_payload.get("source_path") or raw_payload.get("source")
    return MemorySearchHit(
        id=str(point_id),
        score=float(score),
        collection=collection,
        project=_str_or_none(raw_payload.get("project")),
        section_heading=_str_or_none(raw_payload.get("section_heading")),
        source_path=_str_or_none(src),
        preview=preview,
        user_id=_str_or_none(raw_payload.get("user_id")),
        agent_id=_str_or_none(raw_payload.get("agent_id")),
        tag=_str_or_none(raw_payload.get("tag")),
    )


def _str_or_none(value: Any) -> str | None:
    """Coerce payload fields to str, treating empty strings as None."""
    if value is None:
        return None
    text = str(value).strip()
    return text or None


# --- Endpoints --------------------------------------------------------------


@router.post(
    "",
    response_model=MemorySearchResponse,
    summary="Memory semantic search",
    description=(
        "Embed `query` and run a top-k cosine-similarity search across the "
        "requested Qdrant collections, merging results and returning the "
        "top `limit` hits."
    ),
)
async def memory_search(
    body: MemorySearchRequest,
    _actor: ActorContext = ACTOR_DEP,
) -> MemorySearchResponse:
    """Run the embed-and-search pipeline for the work-mode search page."""
    collections = body.collections or list(DEFAULT_COLLECTIONS)
    qdrant_filter = _build_qdrant_filter(body.projects)

    # Per-collection cap is the requested final limit — we'll trim after
    # merging. Asking for ~limit per collection keeps the response cheap
    # while leaving enough headroom that the merged top-k is well-formed.
    per_collection_cap = max(body.limit, DEFAULT_LIMIT)

    async with httpx.AsyncClient() as client:
        vector = await _embed_query(client, body.query)

        merged: list[MemorySearchHit] = []
        for collection in collections:
            points = await _search_collection(
                client=client,
                collection=collection,
                vector=vector,
                limit=per_collection_cap,
                qdrant_filter=qdrant_filter,
            )
            for point in points:
                hit = _hit_from_qdrant(point, collection)
                if hit is not None:
                    merged.append(hit)

    merged.sort(key=lambda h: h.score, reverse=True)
    return MemorySearchResponse(hits=merged[: body.limit])


@router.get(
    "/file",
    response_model=MemoryFileResponse,
    summary="Fetch a memory markdown file",
    description=(
        "Return the raw markdown text for a memory file. "
        "Paths are constrained to /opt/data/memory/ — anything outside is rejected."
    ),
)
async def memory_search_file(
    path: str = Query(..., min_length=1, max_length=4000),
    _actor: ActorContext = ACTOR_DEP,
) -> MemoryFileResponse:
    """Path-confined file reader for the search page side panel."""
    # Defense in depth: lexical prefix check first, then resolve and confirm.
    if not path.startswith("/opt/data/memory/"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="path must live under /opt/data/memory/",
        )

    try:
        candidate = Path(path).resolve(strict=False)
    except OSError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"invalid path: {exc!s}",
        ) from exc

    try:
        candidate.relative_to(MEMORY_ROOT)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="path escapes /opt/data/memory/",
        ) from exc

    if not candidate.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)

    try:
        content = candidate.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"failed to read file: {exc!s}",
        ) from exc

    return MemoryFileResponse(
        path=str(candidate),
        content=content,
        bytes=len(content.encode("utf-8")),
    )
