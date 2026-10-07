"""Silero VAD (ONNX, no torch) over a PCM cache.

The file is split into up to ``batch_size`` contiguous sections that are run as
one ONNX batch, each row carrying its own recurrent state. That keeps a 24 h
recording to a few minutes of single-threaded CPU. Per-frame speech
probabilities are kept as ``uint8`` (one byte per 32 ms frame, ~2.7 MB per
24 h) so they can be checkpointed and reused by the chunker to find the
quietest cut point inside long uninterrupted speech.
"""

from __future__ import annotations

import math
import os
from collections.abc import Callable
from pathlib import Path

import numpy as np

from audio_pipeline.audio import SAMPLE_RATE
from audio_pipeline.config import VadConfig

FRAME_SAMPLES = 512
CONTEXT_SAMPLES = 64
FRAME_SECONDS = FRAME_SAMPLES / SAMPLE_RATE
_BLOCK_FRAMES = 1024

Segment = tuple[float, float]


def default_model_path(configured: Path | None = None) -> Path:
    """Locate ``silero_vad.onnx``: config, ``$AUDIO_PIPELINE_VAD_MODEL``, then bundled paths."""
    candidates: list[Path] = []
    if configured:
        candidates.append(configured)
    env = os.environ.get("AUDIO_PIPELINE_VAD_MODEL")
    if env:
        candidates.append(Path(env))
    here = Path(__file__).resolve()
    candidates += [
        here.parents[2] / "models" / "silero_vad.onnx",
        Path("/app/models/silero_vad.onnx"),
    ]
    for c in candidates:
        if c.is_file():
            return c
    raise FileNotFoundError(
        "silero_vad.onnx not found; set vad.model_path or AUDIO_PIPELINE_VAD_MODEL "
        f"(searched: {', '.join(str(c) for c in candidates)})"
    )


class SileroVad:
    """Thin numpy wrapper around the Silero VAD v5/v6 ONNX graph (16 kHz)."""

    def __init__(self, model_path: Path, num_threads: int = 1) -> None:
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.intra_op_num_threads = num_threads
        opts.inter_op_num_threads = 1
        opts.log_severity_level = 3
        self._session = ort.InferenceSession(
            str(model_path), sess_options=opts, providers=["CPUExecutionProvider"]
        )
        self._sr = np.array(SAMPLE_RATE, dtype=np.int64)

    def frame_probabilities(
        self,
        pcm: np.ndarray,
        *,
        batch_size: int = 16,
        min_section_seconds: float = 300,
        progress: Callable[[float], None] | None = None,
        output_path: Path | None = None,
        checkpoint_path: Path | None = None,
    ) -> np.ndarray:
        """Speech probability per 512-sample frame, quantised to ``uint8`` (0..255)."""
        n = len(pcm)
        total = math.ceil(n / FRAME_SAMPLES)
        if total == 0:
            return np.zeros(0, dtype=np.uint8)
        if output_path:
            if output_path.exists() and output_path.stat().st_size != total:
                output_path.unlink()
            probs = np.memmap(
                output_path,
                dtype=np.uint8,
                mode="r+" if output_path.exists() else "w+",
                shape=(total,),
            )
        else:
            probs = np.zeros(total, dtype=np.uint8)
        min_section = max(1, int(min_section_seconds / FRAME_SECONDS))
        sections = max(1, min(batch_size, total // min_section))
        per = math.ceil(total / sections)
        rows = np.arange(sections)
        starts = rows * per
        ends = np.minimum(starts + per, total)
        state = np.zeros((2, sections, 128), dtype=np.float32)
        next_block = 0
        if checkpoint_path and checkpoint_path.is_file():
            try:
                with np.load(checkpoint_path, allow_pickle=False) as saved:
                    matches = (
                        int(saved["total"]) == total
                        and int(saved["sections"]) == sections
                        and int(saved["per"]) == per
                    )
                    if matches:
                        next_block = int(saved["next_block"])
                        state = saved["state"].astype(np.float32, copy=True)
            except (OSError, ValueError, KeyError):
                next_block = 0
                state.fill(0)

        for block_start in range(next_block, per, _BLOCK_FRAMES):
            block_len = min(_BLOCK_FRAMES, per - block_start)
            buf = np.zeros((sections, CONTEXT_SAMPLES + block_len * FRAME_SAMPLES), np.float32)
            for s in range(sections):
                f0 = int(starts[s]) + block_start
                f1 = min(f0 + block_len, int(ends[s]))
                if f0 >= f1:
                    continue
                ctx = 0 if block_start == 0 else CONTEXT_SAMPLES
                a = f0 * FRAME_SAMPLES - ctx
                b = min(f1 * FRAME_SAMPLES, n)
                if b > a:
                    chunk = np.asarray(pcm[a:b], dtype=np.float32) / 32768.0
                    off = CONTEXT_SAMPLES - ctx
                    buf[s, off : off + len(chunk)] = chunk
            base = starts + block_start
            for t in range(block_len):
                x = buf[:, t * FRAME_SAMPLES : t * FRAME_SAMPLES + CONTEXT_SAMPLES + FRAME_SAMPLES]
                out, state = self._session.run(None, {"input": x, "state": state, "sr": self._sr})
                idx = base + t
                valid = idx < ends
                probs[idx[valid]] = np.clip(out[valid, 0] * 255.0 + 0.5, 0, 255).astype(np.uint8)
            if progress:
                progress(min(1.0, (block_start + block_len) / per))
            if isinstance(probs, np.memmap):
                probs.flush()
            if checkpoint_path:
                temporary = checkpoint_path.with_suffix(".npz.partial")
                with temporary.open("wb") as checkpoint_file:
                    np.savez(
                        checkpoint_file,
                        total=np.array(total),
                        sections=np.array(sections),
                        per=np.array(per),
                        next_block=np.array(block_start + block_len),
                        state=state,
                    )
                temporary.replace(checkpoint_path)
        return probs


def speech_segments(probs: np.ndarray, cfg: VadConfig, duration: float) -> list[Segment]:
    """Turn frame probabilities into padded, merged speech spans (seconds, absolute).

    Same hysteresis as Silero's ``get_speech_timestamps``: speech starts at
    ``p >= threshold`` and only ends after ``min_silence_ms`` below
    ``neg_threshold``; spans shorter than ``min_speech_ms`` are dropped.
    """
    thr = int(round(cfg.threshold * 255))
    neg_value = cfg.neg_threshold if cfg.neg_threshold is not None else cfg.threshold - 0.15
    neg = int(round(max(0.01, neg_value) * 255))
    min_speech = max(1, math.ceil(cfg.min_speech_ms / 1000 / FRAME_SECONDS))
    min_silence = max(1, math.ceil(cfg.min_silence_ms / 1000 / FRAME_SECONDS))
    pad = cfg.speech_pad_ms / 1000

    raw: list[tuple[int, int]] = []
    triggered = False
    start = 0
    temp_end: int | None = None
    for i, p in enumerate(probs):
        if p >= thr:
            if not triggered:
                triggered = True
                start = i
            temp_end = None
        elif triggered and p < neg:
            if temp_end is None:
                temp_end = i
            if i - temp_end >= min_silence:
                if temp_end - start >= min_speech:
                    raw.append((start, temp_end))
                triggered = False
                temp_end = None
    if triggered:
        end = temp_end if temp_end is not None else len(probs)
        if end - start >= min_speech:
            raw.append((start, end))

    merged: list[list[float]] = []
    for f0, f1 in raw:
        s = max(0.0, f0 * FRAME_SECONDS - pad)
        e = min(duration, f1 * FRAME_SECONDS + pad)
        if merged and s <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    return [(round(s, 3), round(e, 3)) for s, e in merged if e > s]
