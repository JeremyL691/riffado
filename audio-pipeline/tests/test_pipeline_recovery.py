import asyncio
from pathlib import Path
from types import SimpleNamespace

import numpy as np

from audio_pipeline.audio import SAMPLE_RATE
from audio_pipeline.chunker import ChunkPlan, chunk_id
from audio_pipeline.config import AppConfig, ServerConfig
from audio_pipeline.service import DiskBudgetError, PipelineService
from audio_pipeline.store import JobStore


class FakePreprocessor:
    def __init__(self, plans: list[ChunkPlan]) -> None:
        self.plans = plans

    def detect_speech(self, _probs: np.ndarray, _duration: float) -> list[tuple[float, float]]:
        return [(0.0, len(self.plans))]

    def plan(
        self,
        _segments: list[tuple[float, float]],
        _probs: np.ndarray,
        *,
        total_samples: int,
    ) -> list[ChunkPlan]:
        assert self.plans[-1].end_sample == total_samples
        return self.plans


class FakeProvider:
    capabilities = SimpleNamespace(max_duration_seconds=170, max_file_bytes=10_000_000)

    def __init__(self, fail_once_for: set[int] | None = None) -> None:
        self.calls: list[int] = []
        self.fail_once_for = set(fail_once_for or ())

    async def transcribe(self, request: object) -> dict[str, object]:
        index = request.index
        self.calls.append(index)
        if index in self.fail_once_for:
            self.fail_once_for.remove(index)
            raise RuntimeError("injected transient chunk failure")
        return {
            "text": f"chunk {index}",
            "segments": [{"start": 0.1, "end": 0.9, "text": f"chunk {index}"}],
        }


def _seed_interrupted_job(tmp_path: Path) -> tuple[Path, str, list[ChunkPlan], np.ndarray]:
    database = tmp_path / "pipeline.sqlite3"
    store = JobStore(database)
    job, _ = store.create("restart-job", "restart-job", 2_000)
    job_id = job["id"]
    pcm = np.zeros(2 * SAMPLE_RATE, dtype=np.int16)
    plans = [
        ChunkPlan(0, 0, SAMPLE_RATE, SAMPLE_RATE),
        ChunkPlan(1, SAMPLE_RATE, len(pcm), SAMPLE_RATE),
    ]

    workdir = tmp_path / "jobs" / job_id
    workdir.mkdir(parents=True)
    (workdir / "source.audio").write_bytes(b"local synthetic source")
    pcm.tofile(workdir / "audio.pcm")
    (workdir / "vad-probabilities.u8").write_bytes(bytes((len(pcm) + 511) // 512))
    (workdir / "vad.complete").write_text(str(len(pcm)), encoding="ascii")

    persisted = []
    for plan in plans:
        chunk_id_value, digest = chunk_id(job_id, plan, pcm)
        persisted.append(
            {
                "id": chunk_id_value,
                "index": plan.index,
                "start_sample": plan.start_sample,
                "end_sample": plan.end_sample,
                "content_sha256": digest,
            }
        )
    store.upsert_chunks(job_id, persisted)
    store.update_chunk(
        persisted[0]["id"],
        status="completed",
        result_json={
            "text": "saved chunk",
            "segments": [{"start": 0.1, "end": 0.9, "text": "saved chunk"}],
        },
    )
    store.update(job_id, status="running", phase="transcribing")
    return database, job_id, plans, pcm


def test_startup_reuses_completed_chunks_after_store_reopen(tmp_path: Path, monkeypatch) -> None:
    database, job_id, plans, _ = _seed_interrupted_job(tmp_path)
    reopened = JobStore(database)
    provider = FakeProvider()

    import audio_pipeline.service as service_module

    monkeypatch.setattr(service_module, "probe_duration", lambda _source: 2.0)
    monkeypatch.setattr(service_module, "CoreBridgeProvider", lambda *_args: provider)
    service = PipelineService(
        AppConfig(server=ServerConfig(data_dir=tmp_path, api_token="local-mock-token")),
        reopened,
    )
    service._preprocessor = FakePreprocessor(plans)

    async def restart() -> None:
        await service.start()
        try:
            await asyncio.wait_for(asyncio.gather(*tuple(service._tasks.values())), timeout=3)
        finally:
            await service.stop()

    asyncio.run(restart())

    current = reopened.get(job_id)
    chunks = reopened.chunks(job_id)
    assert current["status"] == "completed"
    assert current["result"]["text"] == "saved chunk\n\nchunk 1"
    assert [chunk["status"] for chunk in chunks] == ["completed", "completed"]
    assert provider.calls == [1]


def test_retry_reuses_successful_chunks_and_retries_only_failed_chunk(
    tmp_path: Path, monkeypatch
) -> None:
    database, job_id, plans, _ = _seed_interrupted_job(tmp_path)
    reopened = JobStore(database)
    provider = FakeProvider(fail_once_for={1})

    import audio_pipeline.service as service_module

    monkeypatch.setattr(service_module, "probe_duration", lambda _source: 2.0)
    monkeypatch.setattr(service_module, "CoreBridgeProvider", lambda *_args: provider)
    service = PipelineService(
        AppConfig(server=ServerConfig(data_dir=tmp_path, api_token="local-mock-token")),
        reopened,
    )
    service._preprocessor = FakePreprocessor(plans)

    async def retry_failed_chunk() -> None:
        await service.start()
        try:
            first_run = tuple(service._tasks.values())
            await asyncio.wait_for(asyncio.gather(*first_run), timeout=3)
            assert reopened.get(job_id)["status"] == "failed"
            assert [chunk["status"] for chunk in reopened.chunks(job_id)] == [
                "completed",
                "failed",
            ]

            assert service.retry(job_id)
            retry_run = tuple(service._tasks.values())
            await asyncio.wait_for(asyncio.gather(*retry_run), timeout=3)
        finally:
            await service.stop()

    asyncio.run(retry_failed_chunk())

    current = reopened.get(job_id)
    chunks = reopened.chunks(job_id)
    assert current["status"] == "completed"
    assert current["result"]["text"] == "saved chunk\n\nchunk 1"
    assert [chunk["status"] for chunk in chunks] == ["completed", "completed"]
    assert provider.calls == [1, 1]


def test_disk_budget_pauses_then_auto_resumes_after_restart(tmp_path: Path, monkeypatch) -> None:
    database = tmp_path / "pipeline.sqlite3"
    store = JobStore(database)
    job, _ = store.create("disk-job", "disk-job", 60_000)
    first_service = PipelineService(AppConfig(server=ServerConfig(data_dir=tmp_path)), store)

    async def fail_for_budget(_job_id: str) -> None:
        raise DiskBudgetError("injected disk budget exhaustion")

    first_service._run = fail_for_budget
    asyncio.run(first_service._run_with_slot(job["id"]))
    assert store.get(job["id"])["status"] == "paused"
    assert store.get(job["id"])["phase"] == "paused_disk"

    reopened = JobStore(database)
    recovered_service = PipelineService(AppConfig(server=ServerConfig(data_dir=tmp_path)), reopened)
    completed = asyncio.Event()

    async def finish_after_budget_returns(_job_id: str) -> None:
        reopened.update(job["id"], status="completed", phase="completed")
        completed.set()

    recovered_service._run = finish_after_budget_returns

    import audio_pipeline.service as service_module

    monkeypatch.setattr(
        service_module.shutil,
        "disk_usage",
        lambda _path: SimpleNamespace(free=1024 * 1024 * 1024),
    )

    async def recover() -> None:
        await recovered_service.start()
        try:
            await asyncio.wait_for(completed.wait(), timeout=3)
        finally:
            await recovered_service.stop()

    asyncio.run(recover())
    assert reopened.get(job["id"])["status"] == "completed"


def test_startup_finishes_persisted_cancellation_without_processing(tmp_path: Path) -> None:
    database = tmp_path / "pipeline.sqlite3"
    store = JobStore(database)
    job, _ = store.create("cancel-job", "cancel-job", 60_000)
    assert store.set_cancelled(job["id"])
    reopened = JobStore(database)
    service = PipelineService(AppConfig(server=ServerConfig(data_dir=tmp_path)), reopened)

    async def restart() -> None:
        await service.start()
        try:
            await asyncio.wait_for(asyncio.gather(*tuple(service._tasks.values())), timeout=3)
        finally:
            await service.stop()

    asyncio.run(restart())
    assert reopened.get(job["id"])["status"] == "cancelled"
    assert reopened.chunks(job["id"]) == []
