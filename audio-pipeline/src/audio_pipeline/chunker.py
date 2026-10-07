"""Sample-exact smart chunking over continuous ranges of the original audio."""

from __future__ import annotations

import hashlib
import math
from dataclasses import asdict, dataclass

import numpy as np

from audio_pipeline.audio import SAMPLE_RATE
from audio_pipeline.config import ChunkingConfig
from audio_pipeline.vad import FRAME_SAMPLES, Segment


@dataclass(frozen=True)
class ChunkPlan:
    index: int
    start_sample: int
    end_sample: int
    speech_samples: int

    @property
    def sample_count(self) -> int:
        return self.end_sample - self.start_sample

    @property
    def start_ms(self) -> int:
        return round(self.start_sample * 1000 / SAMPLE_RATE)

    @property
    def end_ms(self) -> int:
        return round(self.end_sample * 1000 / SAMPLE_RATE)

    @property
    def audio_seconds(self) -> float:
        return self.sample_count / SAMPLE_RATE

    def to_dict(self) -> dict[str, int]:
        return asdict(self)


def plan_chunks(
    segments: list[Segment],
    cfg: ChunkingConfig,
    probs: np.ndarray | None = None,
    *,
    sample_rate: int = SAMPLE_RATE,
    total_samples: int | None = None,
) -> list[ChunkPlan]:
    """Plan adjacent slices of the original recording, excluding long silences.

    Segments separated by more than ``keep_gap_seconds`` start a new range.
    Short pauses stay in the source audio. Boundaries prefer natural pauses
    near the target length; uninterrupted speech is cut at the quietest VAD
    frame before the hard limit.
    """
    if not segments:
        return []
    target = max(1, round(cfg.target_seconds * sample_rate))
    hard = max(target, round(cfg.max_seconds * sample_rate))
    max_gap = round(cfg.keep_gap_seconds * sample_rate)
    spans = [
        (max(0, round(start * sample_rate)), max(0, round(end * sample_rate)))
        for start, end in segments
        if end > start
    ]
    if not spans:
        return []

    runs: list[list[tuple[int, int]]] = []
    for span in spans:
        if runs and span[0] - runs[-1][-1][1] <= max_gap:
            runs[-1].append(span)
        else:
            runs.append([span])

    plans: list[ChunkPlan] = []
    timestamp_guard = round(cfg.timestamp_guard_ms * sample_rate / 1000)
    for run_index, run in enumerate(runs):
        run_start, speech_run_end = run[0][0], run[-1][1]
        if total_samples is None:
            run_end = speech_run_end
        elif run_index + 1 < len(runs):
            audio_limit = runs[run_index + 1][0][0]
            run_end = min(audio_limit, speech_run_end + timestamp_guard)
        else:
            run_end = min(total_samples, speech_run_end + timestamp_guard)
        cursor = run_start
        while cursor < run_end:
            if run_end - cursor <= hard:
                boundary = run_end
            else:
                lower = cursor + max(1, round(target * 0.65))
                upper = min(run_end, cursor + hard)
                natural = [
                    (next_start, next_start - previous_end)
                    for (_, previous_end), (next_start, _) in zip(run, run[1:], strict=False)
                    if lower <= next_start <= upper
                ]
                if natural:
                    # Prefer the longest pause, then the boundary nearest the
                    # target. The cut is at the next speech onset, so the short
                    # natural pause remains in the preceding contiguous chunk.
                    boundary, _ = max(
                        natural,
                        key=lambda item: (
                            item[1],
                            -abs(item[0] - (cursor + target)),
                        ),
                    )
                else:
                    boundary = _quietest_cut(probs, cursor + target, upper)
            if boundary <= cursor:
                boundary = min(run_end, cursor + hard)
            speech = sum(max(0, min(end, boundary) - max(start, cursor)) for start, end in run)
            plans.append(ChunkPlan(len(plans), cursor, boundary, speech))
            cursor = boundary
    return plans


def chunk_id(job_id: str, plan: ChunkPlan, pcm: np.ndarray) -> tuple[str, str]:
    """Return stable chunk id and SHA-256 over the exact s16le chunk bytes."""
    samples = np.asarray(pcm[plan.start_sample : plan.end_sample], dtype="<i2")
    digest = hashlib.sha256(samples.tobytes()).hexdigest()
    identity = hashlib.sha256(
        f"{job_id}:{plan.index}:{plan.start_sample}:{plan.end_sample}:{digest}".encode()
    ).hexdigest()[:24]
    return identity, digest


def _quietest_cut(probs: np.ndarray | None, lo: int, hi: int) -> int:
    if hi <= lo or probs is None or len(probs) == 0:
        return hi
    f0 = max(0, lo // FRAME_SAMPLES)
    f1 = min(len(probs), math.ceil(hi / FRAME_SAMPLES))
    if f1 <= f0:
        return hi
    frame = f0 + int(np.argmin(probs[f0:f1]))
    cut = (frame + 1) * FRAME_SAMPLES
    return max(lo, min(hi, cut))
