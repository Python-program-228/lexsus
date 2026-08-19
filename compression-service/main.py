"""AI Continuity Bridge — compression-service.

Local FastAPI microservice for LLM-based context compression (Layer 3).
Phase 0 ships the skeleton: a /health endpoint and a /compress stub.

The Rust core calls this over localhost to compress structured project
memory into a handoff-sized snapshot for a web AI. Implemented in Phase 2.
"""

from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(
    title="AI Continuity Bridge — Compression Service",
    version="0.1.0",
    description="Local LLM context compression for the continuity bridge (Layer 3).",
)


class CompressRequest(BaseModel):
    """Structured project memory to be compressed into a handoff snapshot."""

    objective: str | None = None
    decisions: list[str] = []
    attempts: list[str] = []
    constraints: list[str] = []
    changed_files: list[str] = []
    progress: dict[str, Any] | None = None


class CompressResponse(BaseModel):
    """A handoff-sized snapshot a fresh web AI can act on."""

    summary: str
    next_step: str | None = None


@app.get("/health")
def health() -> dict[str, str]:
    """Liveness probe for the Rust core / Docker healthcheck."""
    return {"status": "ok", "service": "compression-service"}


@app.post("/compress", response_model=CompressResponse)
def compress(req: CompressRequest) -> CompressResponse:
    """Compress structured state into a handoff snapshot.

    Phase 0: stub. The LLM-backed compression is implemented in Phase 2.
    This intentionally raises 501 so callers can rely on the contract without
    a half-working implementation.
    """
    raise HTTPException(
        status_code=501,
        detail="compression not implemented yet (Phase 2)",
    )