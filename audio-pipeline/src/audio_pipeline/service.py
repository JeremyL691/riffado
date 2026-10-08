"""Durable orchestration for decode, VAD, chunk-level STT, and timestamp merge."""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import random
import re
import shutil
from contextlib import suppress
from pathlib import Path
from typing import Any

import httpx
import numpy as np

from audio_pipeline.audio import (
    SAMPLE_RATE,
    encode,
    open_pcm,
    probe_duration,
)
from audio_pipeline.chunker import ChunkPlan, chunk_id
from audio_pipeline.config import AppConfig
from audio_pipeline.interfaces import Preprocessor
from audio_pipeline.merge import merge_chunk_results
from audio_pipeline.preprocessor import SileroPreprocessor
from audio_pipeline.provider import (
    ChunkAudio,
    CoreBridgeProvider,
    ProviderRequestError,
)
from audio_pipeline.store import JobStore
from audio_pipeline.vad import default_model_path

_MODEL_SHA256 = "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3"
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


class _JobCancelled(Exception):
    pass


class DiskBudgetError(OSError):
    pass


class PipelineService:
    def __init__(self, config: AppConfig, store: JobStore) -> None:
        self.config = config
        self.store = store
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._job_slots = asyncio.Semaphore(config.server.max_concurrent_jobs)
        self._stt_slots = asyncio.Semaphore(config.server.stt_concurrency)
        self._preprocessor: Preprocessor | None = None
        self._resume_task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        for job in self.store.list_runnable():
            self.schedule(job["id"])
        self._resume_task = asyncio.create_task(self._resume_paused_jobs())

    async def stop(self) -> None:
        """Stop background tasks without changing durable job state.

        In-flight jobs remain resumable: completed chunks and checkpoints stay
        on disk, while any interrupted job remains ``running`` for startup
        recovery.
        """
        tasks = list(self._tasks.values())
        for task in tasks:
            task.cancel()
        if self._resume_task:
            self._resume_task.cancel()
            tasks.append(self._resume_task)
            self._resume_task = None
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    def schedule(self, job_id: str) -> None:
        task = self._tasks.get(job_id)
        if task and not task.done():
            return
        self._tasks[job_id] = asyncio.create_task(self._run_with_slot(job_id))

    async def submit(self, riffado_job_id: str, duration_ms: int) -> tuple[dict[str, Any], bool]:
        if not _ID_RE.fullmatch(riffado_job_id):
            raise ValueError("Invalid Riffado job id")
        if duration_ms < 0 or duration_ms > 24 * 60 * 60 * 1000:
            raise ValueError("Audio duration must be between zero and 24 hours")
        job, created = self.store.create(riffado_job_id, riffado_job_id, duration_ms)
        self.schedule(job["id"])
        return job, created

    async def _run_with_slot(self, job_id: str) -> None:
        async with self._job_slots:
            try:
                await self._run(job_id)
            except _JobCancelled:
                self._finish_cancel(job_id)
                return
            except DiskBudgetError as exc:
                self.store.update(
                    job_id,
                    status="paused",
                    phase="paused_disk",
                    error_type="DiskBudgetError",
                    error=str(exc)[:1000],
                )
            except asyncio.CancelledError:
                if self.store.is_cancelled(job_id):
                    self._finish_cancel(job_id)
                else:
                    raise
            except Exception as exc:
                self.store.update(
                    job_id,
                    status="failed",
                    phase="failed",
                    error_type=type(exc).__name__,
                    error=str(exc)[:1000],
                )
            finally:
                job = self.store.get(job_id)
                if job and job["status"] == "cancelled":
                    self._cleanup_workspace(job_id)
                self._tasks.pop(job_id, None)

    async def _run(self, job_id: str) -> None:
        job = self.store.get(job_id)
        if not job or job["status"] in {
            "completed",
            "needs_alignment",
            "cancelled",
            "acknowledged",
        }:
            return
        if self.store.is_cancelled(job_id):
            self.store.update(job_id, status="cancelled", phase="cancelled")
            return

        workdir = self.config.server.data_dir / "jobs" / job_id
        workdir.mkdir(parents=True, exist_ok=True)
        source = workdir / "source.audio"
        pcm_path = workdir / "audio.pcm"
        meta_path = workdir / "audio.meta.json"
        probs_path = workdir / "vad-probabilities.u8"
        vad_complete_path = workdir / "vad.complete"
        vad_checkpoint_path = workdir / "vad-checkpoint.npz"
        vad_segments_path = workdir / "vad-segments.json"
        duration_ms = int(job["duration_ms"])
        self.store.update(job_id, status="running", phase="download", progress=0.01)

        if not source.is_file():
            await self._download_source(job_id, source, duration_ms)
        self._check_cancel(job_id)

        probed_duration = await asyncio.to_thread(probe_duration, source)
        if probed_duration is None and duration_ms <= 0:
            raise ValueError("Unable to determine source audio duration for disk budgeting")
        if probed_duration is not None:
            if probed_duration > 24 * 60 * 60:
                raise ValueError("Source audio exceeds the 24-hour pipeline limit")
            duration_ms = max(duration_ms, round(probed_duration * 1000))

        if self._preprocessor is None:
            model = default_model_path(self.config.vad.model_path)
            actual_hash = await asyncio.to_thread(_sha256, model)
            if actual_hash != _MODEL_SHA256:
                raise RuntimeError("Bundled Silero VAD model checksum mismatch")
            self._preprocessor = SileroPreprocessor(self.config.vad, self.config.chunking, model)

        if not pcm_path.is_file():
            self.store.update(job_id, phase="decode", progress=0.05)
            required_pcm = math.ceil(duration_ms / 1000 * SAMPLE_RATE * 2)
            if (
                shutil.disk_usage(self.config.server.data_dir).free
                < required_pcm + 64 * 1024 * 1024
            ):
                raise DiskBudgetError("Waiting for disk space to decode the source audio")
            try:
                sample_count = await asyncio.to_thread(self._preprocessor.decode, source, pcm_path)
            except Exception as exc:
                if (
                    shutil.disk_usage(self.config.server.data_dir).free
                    < required_pcm + 64 * 1024 * 1024
                ):
                    raise DiskBudgetError(
                        "Waiting for disk space to finish decoding audio"
                    ) from exc
                raise
            meta_path.write_text(json.dumps({"sample_count": sample_count}), encoding="utf-8")
        else:
            sample_count = pcm_path.stat().st_size // 2
        actual_duration = sample_count / SAMPLE_RATE
        if actual_duration > 24 * 60 * 60 + 0.02:
            raise ValueError("Decoded audio exceeds the 24-hour pipeline limit")
        pcm = open_pcm(pcm_path)
        if self.store.is_cancelled(job_id):
            self._finish_cancel(job_id)
            return

        if (
            vad_complete_path.is_file()
            and probs_path.is_file()
            and probs_path.stat().st_size == math.ceil(sample_count / 512)
        ):
            probs = np.memmap(probs_path, dtype=np.uint8, mode="r")
        else:
            self.store.update(job_id, phase="vad", progress=0.1)

            def vad_progress(value: float) -> None:
                if self.store.is_cancelled(job_id):
                    self._finish_cancel(job_id)
                    raise _JobCancelled
                self.store.update(job_id, progress=round(0.1 + 0.55 * value, 4))

            probs = await asyncio.to_thread(
                self._preprocessor.speech_probabilities,
                pcm,
                progress=vad_progress,
                output_path=probs_path,
                checkpoint_path=vad_checkpoint_path,
            )
            if len(probs):
                probs.flush() if isinstance(probs, np.memmap) else probs.tofile(probs_path)
                probs = np.memmap(probs_path, dtype=np.uint8, mode="r")
            vad_complete_path.write_text(str(sample_count), encoding="ascii")
        self._check_cancel(job_id)

        segments = self._preprocessor.detect_speech(probs, actual_duration)
        segment_payload = {
            "schema_version": 1,
            "sample_rate": SAMPLE_RATE,
            "vad": self.config.vad.model_dump(mode="json"),
            "regions": [
                {
                    "start_ms": round(start * 1000),
                    "end_ms": round(end * 1000),
                }
                for start, end in segments
            ],
        }
        segment_partial = vad_segments_path.with_suffix(".json.partial")
        segment_partial.write_text(
            json.dumps(segment_payload, separators=(",", ":")), encoding="utf-8"
        )
        os.replace(segment_partial, vad_segments_path)
        plans = self._preprocessor.plan(segments, probs, total_samples=sample_count)
        persisted_plans: list[dict[str, Any]] = []
        plans_by_index: dict[int, ChunkPlan] = {}
        for plan in plans:
            cid, digest = chunk_id(job_id, plan, pcm)
            plans_by_index[plan.index] = plan
            persisted_plans.append(
                {
                    "id": cid,
                    "index": plan.index,
                    "start_sample": plan.start_sample,
                    "end_sample": plan.end_sample,
                    "content_sha256": digest,
                }
            )
        self.store.upsert_chunks(job_id, persisted_plans)
        chunks = self.store.chunks(job_id)
        self.store.update(job_id, phase="transcribing", progress=0.68)

        provider = CoreBridgeProvider(
            self.config.server.core_base_url,
            self.config.server.api_token or "",
        )
        pending = [chunk for chunk in chunks if chunk["status"] != "completed"]
        completed = sum(1 for chunk in chunks if chunk["status"] == "completed")
        if pending:
            outcomes = await asyncio.gather(
                *(
                    self._transcribe_chunk(job, chunk, plans_by_index, pcm, provider)
                    for chunk in pending
                ),
                return_exceptions=True,
            )
            for outcome in outcomes:
                if isinstance(outcome, BaseException) and not isinstance(
                    outcome, asyncio.CancelledError
                ):
                    # Per-chunk state contains the exact failure and all other
                    # successful chunks remain durable and reusable.
                    pass
        self._check_cancel(job_id)

        chunks = self.store.chunks(job_id)
        completed = sum(chunk["status"] == "completed" for chunk in chunks)
        failures = [chunk for chunk in chunks if chunk["status"] != "completed"]
        if failures:
            error_type = failures[0].get("error_type") or "ChunkFailed"
            error = failures[0].get("error") or "One or more audio chunks failed"
            self.store.update(
                job_id,
                status="failed",
                phase="failed",
                error_type=error_type,
                error=error,
                progress=0.68 + 0.3 * completed / max(1, len(chunks)),
            )
            return

        merged_input = [
            (plans_by_index[chunk["chunk_index"]], chunk["result"] or {}) for chunk in chunks
        ]
        text, timeline, needs_alignment = merge_chunk_results(merged_input)
        languages = {
            chunk["result"].get("language")
            for chunk in chunks
            if isinstance(chunk.get("result"), dict)
            and isinstance(chunk["result"].get("language"), str)
        }
        result = {
            "schema_version": 1,
            "text": text,
            "timeline": [segment.to_dict() for segment in timeline],
            "timestamp_source": (
                "normalized"
                if any(segment.timestamp_source == "normalized" for segment in timeline)
                else "native"
                if timeline
                else None
            ),
            "detected_language": next(iter(languages)) if len(languages) == 1 else None,
            "status": "needs_alignment" if needs_alignment else "completed",
            "metadata": {
                "sample_rate": SAMPLE_RATE,
                "total_samples": sample_count,
                "duration_ms": round(sample_count * 1000 / SAMPLE_RATE),
                "vad": self.config.vad.model_dump(mode="json"),
                "chunking": self.config.chunking.model_dump(mode="json"),
                "timestamp_policy": {
                    "name": "chunk_end_guard_50ms_v1",
                    "normalized_segment_count": sum(
                        segment.timestamp_source == "normalized" for segment in timeline
                    ),
                    "ignored_blank_segment_count": sum(
                        1
                        for chunk in chunks
                        for segment in (chunk["result"] or {}).get("segments") or []
                        if isinstance(segment, dict)
                        and isinstance(segment.get("text"), str)
                        and not segment["text"].strip()
                    ),
                },
                "chunks": [
                    {
                        "id": chunk["id"],
                        "start_sample": chunk["start_sample"],
                        "end_sample": chunk["end_sample"],
                        "content_sha256": chunk["content_sha256"],
                    }
                    for chunk in chunks
                ],
            },
        }
        status = "needs_alignment" if needs_alignment else "completed"
        self.store.update(job_id, status=status, phase=status, progress=1.0, result_json=result)

    async def _download_source(self, job_id: str, destination: Path, duration_ms: int) -> None:
        token = self.config.server.api_token
        if not token:
            raise RuntimeError("AUDIO_PIPELINE_TOKEN is required")
        partial = destination.with_suffix(".partial")
        partial.unlink(missing_ok=True)
        url = (
            f"{self.config.server.core_base_url.rstrip('/')}/api/internal/"
            f"audio-pipeline/jobs/{job_id}/audio"
        )
        headers = {"Authorization": f"Bearer {token}"}
        try:
            async with (
                httpx.AsyncClient(timeout=None) as client,
                client.stream("GET", url, headers=headers) as response,
            ):
                if response.is_error:
                    raise RuntimeError(f"Core audio bridge returned HTTP {response.status_code}")
                try:
                    content_length = int(response.headers.get("content-length", "0"))
                except ValueError:
                    content_length = 0
                expected_pcm = math.ceil(duration_ms / 1000 * SAMPLE_RATE * 2)
                required = content_length + expected_pcm + 256 * 1024 * 1024
                if shutil.disk_usage(self.config.server.data_dir).free < required:
                    raise DiskBudgetError("Waiting for disk space for source and decoded PCM")
                bytes_written = 0
                next_progress_at = 64 * 1024 * 1024
                with partial.open("wb") as file:
                    async for block in response.aiter_bytes(1024 * 1024):
                        if self.store.is_cancelled(job_id):
                            self._finish_cancel(job_id)
                            raise _JobCancelled
                        bytes_written += len(block)
                        if bytes_written > self.config.server.max_upload_mb * 1024 * 1024:
                            raise ValueError("Source audio exceeds AUDIO_PIPELINE_MAX_UPLOAD_MB")
                        if (
                            shutil.disk_usage(self.config.server.data_dir).free
                            < expected_pcm + 256 * 1024 * 1024
                        ):
                            raise DiskBudgetError(
                                "Waiting for disk space while downloading source audio"
                            )
                        file.write(block)
                        if content_length and bytes_written >= next_progress_at:
                            fraction = min(1.0, bytes_written / content_length)
                            self.store.update(
                                job_id,
                                progress=round(0.01 + 0.03 * fraction, 4),
                            )
                            next_progress_at = bytes_written + 64 * 1024 * 1024
        except BaseException:
            partial.unlink(missing_ok=True)
            raise
        os.replace(partial, destination)
        self.store.update(job_id, phase="decode", progress=0.04)

    async def _transcribe_chunk(
        self,
        job: dict[str, Any],
        chunk: dict[str, Any],
        plans: dict[int, ChunkPlan],
        pcm: np.ndarray,
        provider: CoreBridgeProvider,
    ) -> None:
        plan = plans[chunk["chunk_index"]]
        async with self._stt_slots:
            if self.store.is_cancelled(job["id"]):
                return
            # Limit encoded buffers as well as network calls. Without holding
            # the semaphore here, a 24-hour recording could encode every
            # chunk at once and exceed the container's memory budget.
            samples = np.asarray(pcm[plan.start_sample : plan.end_sample], dtype=np.int16)
            payload = await asyncio.to_thread(encode, samples, "wav")
            audio_digest = hashlib.sha256(payload).hexdigest()
            self.store.update_chunk(chunk["id"], content_sha256=audio_digest)
            caps = provider.capabilities
            if plan.audio_seconds > caps.max_duration_seconds:
                self.store.update_chunk(
                    chunk["id"],
                    status="failed",
                    error_type="LimitError",
                    error="Chunk exceeds provider duration limit",
                )
                return
            if len(payload) > caps.max_file_bytes:
                self.store.update_chunk(
                    chunk["id"],
                    status="failed",
                    error_type="LimitError",
                    error="Chunk exceeds provider file-size limit",
                )
                return
            request = ChunkAudio(
                job_id=job["riffado_job_id"],
                chunk_id=chunk["id"],
                index=chunk["chunk_index"],
                start_sample=plan.start_sample,
                end_sample=plan.end_sample,
                content_sha256=audio_digest,
                audio=payload,
            )
            for attempt in range(1, self.config.retry.max_attempts + 1):
                if self.store.is_cancelled(job["id"]):
                    return
                self.store.update_chunk(chunk["id"], status="running", attempts=attempt)
                try:
                    response = await provider.transcribe(request)
                    self.store.update_chunk(
                        chunk["id"],
                        status="completed",
                        attempts=attempt,
                        result_json=response,
                        error_type=None,
                        error=None,
                    )
                    return
                except ProviderRequestError as exc:
                    self.store.update_chunk(
                        chunk["id"],
                        status="retrying"
                        if exc.retryable and attempt < self.config.retry.max_attempts
                        else "failed",
                        attempts=attempt,
                        error_type=f"HTTP{exc.status_code}" if exc.status_code else "NetworkError",
                        error=str(exc)[:1000],
                    )
                    if not exc.retryable or attempt >= self.config.retry.max_attempts:
                        return
                    delay = min(
                        self.config.retry.max_delay_seconds,
                        self.config.retry.base_delay_seconds * 2 ** (attempt - 1),
                    )
                    if exc.retry_after is not None:
                        delay = max(0.0, exc.retry_after)
                        delay += random.uniform(0, min(1.0, delay * 0.2))
                    else:
                        delay = min(
                            self.config.retry.max_delay_seconds,
                            delay + random.uniform(0, min(1.0, delay * 0.2)),
                        )
                    await asyncio.sleep(delay)
                except Exception as exc:
                    self.store.update_chunk(
                        chunk["id"],
                        status="failed",
                        attempts=attempt,
                        error_type=type(exc).__name__,
                        error=str(exc)[:1000],
                    )
                    return

    def _check_cancel(self, job_id: str) -> None:
        if self.store.is_cancelled(job_id):
            self._finish_cancel(job_id)
            raise _JobCancelled

    def _finish_cancel(self, job_id: str) -> None:
        self.store.update(job_id, status="cancelled", phase="cancelled")

    def retry(self, job_id: str) -> bool:
        changed = self.store.retry(job_id)
        if changed:
            self.schedule(job_id)
        return changed

    def cancel(self, job_id: str) -> bool:
        changed = self.store.set_cancelled(job_id)
        if not changed:
            return False
        job = self.store.get(job_id)
        task = self._tasks.get(job_id)
        if task is None:
            self.schedule(job_id)
        elif job and (job["status"] == "queued" or job["phase"] in {"download", "transcribing"}):
            task.cancel()
        return True

    def acknowledge(self, job_id: str) -> bool:
        job = self.store.get(job_id)
        if not job:
            return False
        changed = self.store.acknowledge(job_id)
        if changed:
            self._cleanup_workspace(job_id)
        return changed

    def _cleanup_workspace(self, job_id: str) -> None:
        workdir = self.config.server.data_dir / "jobs" / job_id
        for name in (
            "source.audio",
            "source.partial",
            "audio.pcm",
            "audio.pcm.partial",
            "audio.meta.json",
            "vad-probabilities.u8",
            "vad.complete",
            "vad-checkpoint.npz",
            "vad-checkpoint.npz.partial",
            "vad-segments.json",
            "vad-segments.json.partial",
        ):
            (workdir / name).unlink(missing_ok=True)
        with suppress(OSError):
            workdir.rmdir()

    async def _resume_paused_jobs(self) -> None:
        while True:
            try:
                minimum_free = 512 * 1024 * 1024
                for job in self.store.list_paused():
                    required_pcm = math.ceil(job["duration_ms"] / 1000 * SAMPLE_RATE * 2)
                    workdir = self.config.server.data_dir / "jobs" / job["id"]
                    if (workdir / "audio.pcm").is_file():
                        required_pcm = 0
                    if (
                        shutil.disk_usage(self.config.server.data_dir).free
                        < required_pcm + minimum_free
                    ):
                        continue
                    if self.store.resume(job["id"]):
                        self.schedule(job["id"])
            except asyncio.CancelledError:
                raise
            except Exception:
                # A disk probe or corrupt paused row must not stop recovery for
                # other jobs. The next pass retries after the interval.
                pass
            await asyncio.sleep(30)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()
