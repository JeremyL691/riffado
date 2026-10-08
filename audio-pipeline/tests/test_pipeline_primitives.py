from pathlib import Path

import numpy as np
import pytest

from audio_pipeline.chunker import ChunkPlan, chunk_id, plan_chunks
from audio_pipeline.config import ChunkingConfig
from audio_pipeline.merge import InvalidTimestampError, map_native_segments, merge_chunk_results
from audio_pipeline.store import JobStore


def test_long_silence_is_not_joined_and_short_pause_stays_in_chunk() -> None:
    plans = plan_chunks(
        [(1.0, 3.0), (4.0, 5.0), (12.0, 14.0)],
        ChunkingConfig(target_seconds=120, max_seconds=170),
    )
    assert len(plans) == 2
    assert plans[0].start_sample == 16_000
    assert plans[0].end_sample == 80_000
    assert plans[1].start_sample == 192_000
    assert plans[1].end_sample == 224_000


def test_chunk_keeps_small_source_audio_tail_for_provider_timestamps() -> None:
    cfg = ChunkingConfig(target_seconds=120, max_seconds=170, timestamp_guard_ms=50)
    plans = plan_chunks([(1.0, 3.0)], cfg, total_samples=10 * 16_000)
    assert len(plans) == 1
    assert plans[0].start_sample == 16_000
    assert plans[0].end_sample == 3 * 16_000 + 800

    mapped = map_native_segments(plans[0], [{"start": 1.2, "end": 2.011, "text": "last word"}])
    assert mapped[0].end_ms == 3_011


def test_timestamp_guard_does_not_cross_next_long_silence_run() -> None:
    cfg = ChunkingConfig(target_seconds=120, max_seconds=170, timestamp_guard_ms=50)
    plans = plan_chunks(
        [(1.0, 2.0), (4.0, 5.0)],
        cfg,
        total_samples=8 * 16_000,
    )
    assert len(plans) == 2
    assert plans[0].end_sample == 2 * 16_000 + 800
    assert plans[0].end_sample < plans[1].start_sample


def test_long_uninterrupted_speech_is_split_below_hard_limit() -> None:
    cfg = ChunkingConfig(target_seconds=120, max_seconds=170)
    probabilities = np.full((300 * 16_000 + 511) // 512, 240, dtype=np.uint8)
    probabilities[2_100:2_110] = 1
    plans = plan_chunks([(0.0, 300.0)], cfg, probabilities)
    assert len(plans) >= 2
    assert all(plan.audio_seconds <= 170 for plan in plans)
    assert plans[0].start_sample == 0
    assert plans[-1].end_sample == 300 * 16_000
    assert all(
        left.end_sample == right.start_sample for left, right in zip(plans, plans[1:], strict=False)
    )


def test_chunk_identity_hashes_actual_audio_bytes() -> None:
    pcm = np.arange(48_000, dtype=np.int16)
    plan = ChunkPlan(0, 8_000, 24_000, 16_000)
    first = chunk_id("job-a", plan, pcm)
    assert first == chunk_id("job-a", plan, pcm)
    changed = pcm.copy()
    changed[10_000] += 1
    assert first[1] != chunk_id("job-a", plan, changed)[1]


def test_native_timestamps_restore_absolute_milliseconds_past_24h() -> None:
    start = 86_399 * 16_000
    plan = ChunkPlan(0, start, start + 32_000, 32_000)
    result = map_native_segments(plan, [{"start": 0.4, "end": 1.2, "text": "hello"}])
    assert result[0].start_ms == 86_399_400
    assert result[0].end_ms == 86_400_200


def test_invalid_provider_timestamps_are_rejected_without_clamping() -> None:
    plan = ChunkPlan(0, 0, 16_000, 16_000)
    with pytest.raises(InvalidTimestampError):
        map_native_segments(plan, [{"start": 0.2, "end": 1.1, "text": "outside"}])
    text, timeline, needs_alignment = merge_chunk_results(
        [(plan, {"text": "keep the recognized words", "segments": []})]
    )
    assert text == "keep the recognized words"
    assert timeline == []
    assert needs_alignment


@pytest.mark.parametrize("overshoot", [0.025, 0.05])
def test_small_chunk_end_overshoot_is_normalized_with_provenance(overshoot: float) -> None:
    plan = ChunkPlan(7, 16_000, 32_000, 16_000)
    mapped = map_native_segments(
        plan,
        [{"start": 0.5, "end": 1 + overshoot, "text": "last word"}],
    )

    assert mapped[0].end_ms == 2_000
    assert mapped[0].timestamp_source == "normalized"
    assert mapped[0].to_dict()["timestamp_correction"] == {
        "reason": "chunk_end_guard",
        "original_end_ms": round((1 + overshoot + 1) * 1000),
        "normalized_end_ms": 2_000,
        "chunk_index": 7,
    }


@pytest.mark.parametrize("end", [1.0500001, 1.0501])
def test_chunk_end_overshoot_over_50ms_is_rejected(end: float) -> None:
    plan = ChunkPlan(0, 0, 16_000, 16_000)
    with pytest.raises(InvalidTimestampError):
        map_native_segments(
            plan,
            [{"start": 0.5, "end": end, "text": "outside"}],
        )


def test_normalization_cannot_create_zero_length_segment() -> None:
    plan = ChunkPlan(0, 0, 16_000, 16_000)
    with pytest.raises(InvalidTimestampError):
        map_native_segments(
            plan,
            [{"start": 1.0, "end": 1.05, "text": "outside"}],
        )


def test_blank_provider_segments_are_ignored_without_changing_full_text() -> None:
    plan = ChunkPlan(0, 0, 16_000, 16_000)
    text, timeline, needs_alignment = merge_chunk_results(
        [
            (
                plan,
                {
                    "text": "the provider's complete text",
                    "segments": [
                        {"start": 0.0, "end": 0.0, "text": "  "},
                        {"start": 0.25, "end": 0.75, "text": "word"},
                    ],
                },
            )
        ]
    )

    assert text == "the provider's complete text"
    assert len(timeline) == 1
    assert timeline[0].text == "word"
    assert not needs_alignment


def test_chunk_with_only_blank_segments_still_needs_alignment() -> None:
    plan = ChunkPlan(0, 0, 16_000, 16_000)
    text, timeline, needs_alignment = merge_chunk_results(
        [
            (
                plan,
                {
                    "text": "unlocated text",
                    "segments": [{"start": 0.0, "end": 0.5, "text": "  "}],
                },
            )
        ]
    )

    assert text == "unlocated text"
    assert timeline == []
    assert needs_alignment


def test_speaker_segment_keeps_its_chunk_local_identity() -> None:
    plan = ChunkPlan(4, 32_000, 48_000, 16_000)
    mapped = map_native_segments(
        plan,
        [
            {
                "start": 0.25,
                "end": 0.75,
                "text": "word",
                "speaker_id": "speaker_0",
            }
        ],
    )

    assert mapped[0].to_dict()["speaker_id"] == "speaker_0"
    assert mapped[0].to_dict()["chunk_index"] == 4


def test_empty_provider_chunks_do_not_require_alignment() -> None:
    empty = ChunkPlan(0, 0, 16_000, 16_000)
    speech = ChunkPlan(1, 32_000, 48_000, 16_000)
    text, timeline, needs_alignment = merge_chunk_results(
        [
            (empty, {"text": "", "segments": None}),
            (
                speech,
                {
                    "text": "hello",
                    "segments": [{"start": 0.25, "end": 0.75, "text": "hello"}],
                },
            ),
        ]
    )
    assert text == "hello"
    assert [segment.to_dict() for segment in timeline] == [
        {"start_ms": 2250, "end_ms": 2750, "text": "hello", "timestamp_source": "native"}
    ]
    assert not needs_alignment


def test_text_without_provider_timestamps_still_requires_alignment() -> None:
    plan = ChunkPlan(0, 0, 16_000, 16_000)
    text, timeline, needs_alignment = merge_chunk_results(
        [(plan, {"text": "recognized words", "segments": None})]
    )
    assert text == "recognized words"
    assert timeline == []
    assert needs_alignment


def test_job_and_completed_chunk_survive_store_reopen(tmp_path: Path) -> None:
    path = tmp_path / "pipeline.sqlite3"
    store = JobStore(path)
    job, created = store.create("core-job-1", "core-job-1", 900_000)
    assert created
    _, created_again = store.create("core-job-1", "core-job-1", 900_000)
    assert not created_again
    store.update(job["id"], status="running")
    store.upsert_chunks(
        job["id"],
        [
            {
                "id": "chunk-1",
                "index": 0,
                "start_sample": 0,
                "end_sample": 16000,
                "content_sha256": "hash",
            }
        ],
    )
    store.update_chunk("chunk-1", status="completed", result_json={"text": "hello"})
    reopened = JobStore(path)
    assert reopened.chunks(job["id"])[0]["result"] == {"text": "hello"}
    assert reopened.get(job["id"])["progress"] >= 0.98


def test_retry_resets_only_failed_chunks_and_clears_cancellation(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "pipeline.sqlite3")
    job, _ = store.create("core-job-2", "core-job-2", 60_000)
    store.upsert_chunks(
        job["id"],
        [
            {
                "id": "done",
                "index": 0,
                "start_sample": 0,
                "end_sample": 16_000,
                "content_sha256": "first",
            },
            {
                "id": "failed",
                "index": 1,
                "start_sample": 16_000,
                "end_sample": 32_000,
                "content_sha256": "second",
            },
        ],
    )
    store.update_chunk("done", status="completed", result_json={"text": "saved"})
    store.update_chunk("failed", status="failed", attempts=6, error="429")
    store.update(job["id"], status="failed", cancel_requested=True)

    assert store.retry(job["id"])
    by_id = {chunk["id"]: chunk for chunk in store.chunks(job["id"])}
    assert by_id["done"]["status"] == "completed"
    assert by_id["done"]["result"] == {"text": "saved"}
    assert by_id["failed"]["status"] == "queued"
    assert by_id["failed"]["attempts"] == 0
    assert not store.get(job["id"])["cancel_requested"]


def test_job_store_persists_cancellation_until_worker_acknowledges(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "pipeline.sqlite3")
    job, _ = store.create("core-job-3", "core-job-3", 60_000)
    assert store.set_cancelled(job["id"])
    reopened = JobStore(tmp_path / "pipeline.sqlite3")
    assert reopened.is_cancelled(job["id"])
    assert reopened.get(job["id"])["status"] == "queued"


def test_acknowledged_alignment_repair_is_idempotent_and_preserves_ack(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "pipeline.sqlite3")
    job, _ = store.create("core-job-repair", "core-job-repair", 60_000)
    original = {"schema_version": 1, "status": "needs_alignment", "text": "same"}
    store.update(job["id"], status="needs_alignment", result_json=original)
    assert store.acknowledge(job["id"])

    repaired = {
        "schema_version": 1,
        "status": "completed",
        "text": "same",
        "timeline": [{"start_ms": 0, "end_ms": 100, "text": "same"}],
        "timestamp_source": "native",
    }
    assert store.repair_acknowledged_result(job["id"], repaired)
    assert store.repair_acknowledged_result(job["id"], repaired)
    current = store.get(job["id"])
    assert current["status"] == "acknowledged"
    assert current["acknowledged"] is True
    assert current["phase"] == "completed"
    assert current["result"] == repaired
    assert not store.repair_acknowledged_result(job["id"], {**repaired, "text": "different"})
