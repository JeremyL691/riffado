"""Rebuild and safely apply timelines from acknowledged chunk results."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import stat
from contextlib import suppress
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

from audio_pipeline.chunker import ChunkPlan
from audio_pipeline.config import load_config
from audio_pipeline.merge import merge_chunk_results
from audio_pipeline.store import JobStore


class RepairConflictError(RuntimeError):
    pass


def _build_result(row: sqlite3.Row, chunks: list[dict[str, Any]]) -> dict[str, Any] | None:
    original = json.loads(row["result_json"] or "null")
    if (
        not row["acknowledged"]
        or row["status"] != "acknowledged"
        or not isinstance(original, dict)
        or original.get("status") != "needs_alignment"
    ):
        return None

    source_chunks = original.get("metadata", {}).get("chunks", [])
    if len(source_chunks) != len(chunks):
        raise ValueError(f"{row['id']}: stored chunk plan no longer matches the job")

    planned = []
    blank_count = 0
    for index, (source, chunk) in enumerate(zip(source_chunks, chunks, strict=True)):
        if (
            source.get("id") != chunk["id"]
            or source.get("start_sample") != chunk["start_sample"]
            or source.get("end_sample") != chunk["end_sample"]
            or chunk["status"] != "completed"
            or not isinstance(chunk.get("result"), dict)
        ):
            raise ValueError(f"{row['id']}: stored chunk identity or result changed")
        raw_segments = chunk["result"].get("segments") or []
        blank_count += sum(
            isinstance(segment, dict)
            and isinstance(segment.get("text"), str)
            and not segment["text"].strip()
            for segment in raw_segments
        )
        plan = ChunkPlan(
            index=index,
            start_sample=chunk["start_sample"],
            end_sample=chunk["end_sample"],
            speech_samples=chunk["end_sample"] - chunk["start_sample"],
        )
        planned.append((plan, chunk["result"]))

    text, timeline, needs_alignment = merge_chunk_results(planned)
    if needs_alignment or not text or not timeline:
        return None

    source = (
        "normalized"
        if any(segment.timestamp_source == "normalized" for segment in timeline)
        else "native"
    )
    metadata = dict(original.get("metadata") or {})
    metadata["timestamp_policy"] = {
        "name": "chunk_end_guard_50ms_v1",
        "normalized_segment_count": sum(
            segment.timestamp_source == "normalized" for segment in timeline
        ),
        "ignored_blank_segment_count": blank_count,
    }
    return {
        **original,
        "text": text,
        "timeline": [segment.to_dict() for segment in timeline],
        "timestamp_source": source,
        "status": "completed",
        "metadata": metadata,
    }


def _digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _write_private(path: Path, content: dict[str, Any], *, create: bool) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.parent.chmod(stat.S_IRWXU)
    flags = os.O_WRONLY | os.O_CREAT | (os.O_EXCL if create else os.O_TRUNC)
    descriptor = os.open(path, flags, stat.S_IRUSR | stat.S_IWUSR)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(content, output, separators=(",", ":"))
    except BaseException:
        with suppress(OSError):
            os.close(descriptor)
        raise


def _request(
    client: httpx.Client,
    config: Any,
    token: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    response = client.post(
        f"{config.server.core_base_url}/api/internal/audio-pipeline/repair",
        headers={"Authorization": f"Bearer {token}"},
        json=payload,
    )
    if response.status_code in {404, 409}:
        try:
            detail = response.json().get("error", "repair plan no longer matches Core")
        except (ValueError, AttributeError):
            detail = "repair plan no longer matches Core"
        raise RepairConflictError(str(detail))
    if not response.is_success:
        raise RuntimeError(f"Core repair request failed with HTTP {response.status_code}")
    body = response.json()
    if not isinstance(body, dict):
        raise RuntimeError("Core returned an invalid repair response")
    return body


def _preview(database: Path, output: Path) -> None:
    if not database.is_file():
        raise ValueError(f"Pipeline database not found: {database}")
    config = load_config()
    token = config.server.api_token
    if not token:
        raise ValueError("Audio pipeline token is not configured")

    connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    jobs = connection.execute(
        "SELECT * FROM jobs WHERE acknowledged=1 AND status='acknowledged' ORDER BY created_at"
    ).fetchall()
    plans = []
    skipped = []
    try:
        with httpx.Client(timeout=30) as client:
            for row in jobs:
                chunks = []
                for chunk in connection.execute(
                    "SELECT * FROM chunks WHERE job_id=? ORDER BY chunk_index",
                    (row["id"],),
                ):
                    item = dict(chunk)
                    raw_result = item.pop("result_json")
                    item["result"] = json.loads(raw_result) if raw_result else None
                    chunks.append(item)
                result = _build_result(row, chunks)
                if result is None:
                    continue
                try:
                    preview = _request(
                        client,
                        config,
                        token,
                        {
                            "action": "preview",
                            "job_id": row["riffado_job_id"],
                            "expected_text_sha256": _digest(result["text"]),
                            "result": result,
                        },
                    )
                except RepairConflictError as exc:
                    skipped.append(
                        {
                            "recording_minutes": round(row["duration_ms"] / 60_000, 2),
                            "reason": str(exc),
                        }
                    )
                    continue
                generation = preview.get("generation")
                if not isinstance(generation, int) or generation < 1:
                    raise RuntimeError("Core returned an invalid repair generation")
                plans.append(
                    {
                        "job_id": row["riffado_job_id"],
                        "recording_minutes": round(row["duration_ms"] / 60_000, 2),
                        "generation": generation,
                        "expected_text_sha256": _digest(result["text"]),
                        "result": result,
                    }
                )
    finally:
        connection.close()

    _write_private(
        output,
        {
            "schema_version": 1,
            "created_at": datetime.now(UTC).isoformat(),
            "policy": "chunk_end_guard_50ms_v1",
            "repairs": plans,
            "skipped": skipped,
        },
        create=True,
    )
    for plan in plans:
        result = plan["result"]
        policy = result["metadata"]["timestamp_policy"]
        print(
            json.dumps(
                {
                    "minutes": plan["recording_minutes"],
                    "segments": len(result["timeline"]),
                    "source": result["timestamp_source"],
                    **policy,
                },
                separators=(",", ":"),
            )
        )
    for item in skipped:
        print(
            json.dumps(
                {
                    "minutes": item["recording_minutes"],
                    "skipped": True,
                    "reason": item["reason"],
                },
                separators=(",", ":"),
            )
        )
    print(f"Preview saved to {output}; it contains transcript text and must remain private.")


def _apply(database: Path, plan_path: Path) -> None:
    config = load_config()
    token = config.server.api_token
    if not token:
        raise ValueError("Audio pipeline token is not configured")
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    if (
        plan.get("schema_version") != 1
        or plan.get("policy") != "chunk_end_guard_50ms_v1"
        or not isinstance(plan.get("repairs"), list)
    ):
        raise ValueError("Repair plan is invalid or uses an unsupported policy")

    store = JobStore(database)
    reports = []
    with httpx.Client(timeout=60) as client:
        for repair in plan["repairs"]:
            result = repair["result"]
            response = _request(
                client,
                config,
                token,
                {
                    "action": "apply",
                    "job_id": repair["job_id"],
                    "generation": repair["generation"],
                    "expected_text_sha256": repair["expected_text_sha256"],
                    "result": result,
                },
            )
            if not response.get("applied"):
                raise RuntimeError("Core did not confirm the timeline repair")
            if not store.repair_acknowledged_result(repair["job_id"], result):
                raise RuntimeError(
                    "Core was repaired; pipeline result sync is pending. "
                    "Re-run with the same plan after resolving the sidecar error."
                )
            reports.append(
                {
                    "job_id": repair["job_id"],
                    "segments": len(result["timeline"]),
                    "source": result["timestamp_source"],
                    "status": "completed",
                }
            )

    receipt = {
        "schema_version": 1,
        "policy": plan["policy"],
        "completed_at": datetime.now(UTC).isoformat(),
        "repairs": reports,
    }
    _write_private(plan_path, receipt, create=False)
    print(json.dumps(receipt, separators=(",", ":")))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", type=Path, default=Path("/data/pipeline.sqlite3"))
    parser.add_argument("--apply", type=Path)
    parser.add_argument("--preview-output", type=Path)
    args = parser.parse_args()
    output = args.preview_output or (
        Path("/data/repairs")
        / f"timeline-repair-{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}.json"
    )
    if args.apply:
        _apply(args.database, args.apply)
    else:
        _preview(args.database, output)


if __name__ == "__main__":
    main()
