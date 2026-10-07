"""Private HTTP API for long-audio preprocessing jobs."""

from __future__ import annotations

import hmac
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, Field

from audio_pipeline.config import AppConfig, load_config
from audio_pipeline.service import PipelineService
from audio_pipeline.store import JobStore


class CreateJob(BaseModel):
    idempotency_key: str = Field(min_length=1, max_length=128)
    riffado_job_id: str = Field(min_length=1, max_length=128)
    duration_ms: int = Field(ge=0, le=86_400_000)


def create_app(config: AppConfig | None = None) -> FastAPI:
    settings = config or load_config()
    settings.server.data_dir.mkdir(parents=True, exist_ok=True)
    store = JobStore(settings.server.data_dir / "pipeline.sqlite3")
    service = PipelineService(settings, store)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        await service.start()
        try:
            yield
        finally:
            await service.stop()

    app = FastAPI(title="Riffado Audio Preprocessing Pipeline", version="0.1.0", lifespan=lifespan)
    app.state.store = store
    app.state.service = service

    async def authorize(
        request: Request,
        authorization: str | None = Header(default=None),
    ) -> None:
        expected = settings.server.api_token or ""
        supplied = authorization.removeprefix("Bearer ") if authorization else ""
        if not expected or not hmac.compare_digest(expected, supplied):
            raise HTTPException(status_code=401, detail="Unauthorized")

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/v1/jobs", status_code=202, dependencies=[Depends(authorize)])
    async def submit(body: CreateJob) -> dict[str, Any]:
        if body.idempotency_key != body.riffado_job_id:
            raise HTTPException(status_code=400, detail="Job identity must be idempotent")
        try:
            job, created = await service.submit(body.riffado_job_id, body.duration_ms)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"job_id": job["id"], "status": job["status"], "created": created}

    @app.get("/v1/jobs/{job_id}", dependencies=[Depends(authorize)])
    async def get_job(job_id: str, request: Request) -> dict[str, Any]:
        job = request.app.state.store.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        chunks = request.app.state.store.chunks(job_id)
        failed = [
            {
                "id": chunk["id"],
                "index": chunk["chunk_index"],
                "error_type": chunk["error_type"],
                "error": chunk["error"],
            }
            for chunk in chunks
            if chunk["status"] == "failed"
        ]
        return {
            "job_id": job["id"],
            "status": job["status"],
            "phase": job["phase"],
            "progress": job["progress"],
            "error_type": job["error_type"],
            "error": job["error"],
            "chunks_total": len(chunks),
            "chunks_completed": sum(chunk["status"] == "completed" for chunk in chunks),
            "failed_chunks": failed,
            "updated_at": job["updated_at"],
        }

    @app.get("/v1/jobs/{job_id}/result", dependencies=[Depends(authorize)])
    async def get_result(job_id: str, request: Request) -> dict[str, Any]:
        job = request.app.state.store.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        if (
            job["status"] not in {"completed", "needs_alignment", "acknowledged"}
            or not job["result"]
        ):
            raise HTTPException(status_code=409, detail="Job result is not ready")
        return job["result"]

    @app.post("/v1/jobs/{job_id}/retry", dependencies=[Depends(authorize)])
    async def retry(job_id: str, request: Request) -> dict[str, str]:
        if not request.app.state.service.retry(job_id):
            raise HTTPException(status_code=409, detail="Job is not retryable")
        return {"job_id": job_id, "status": "queued"}

    @app.post("/v1/jobs/{job_id}/cancel", dependencies=[Depends(authorize)])
    async def cancel(job_id: str, request: Request) -> dict[str, str]:
        if not request.app.state.service.cancel(job_id):
            raise HTTPException(status_code=404, detail="Job not found or already finished")
        return {"job_id": job_id, "status": "cancelling"}

    @app.post("/v1/jobs/{job_id}/ack", dependencies=[Depends(authorize)])
    async def acknowledge(job_id: str, request: Request) -> dict[str, str]:
        if not request.app.state.service.acknowledge(job_id):
            raise HTTPException(status_code=409, detail="Job result is not ready")
        return {"job_id": job_id, "status": "acknowledged"}

    return app


app = create_app()
