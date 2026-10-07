"""Stable boundaries between audio preparation, speech recognition, and alignment."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Protocol

import numpy as np

from audio_pipeline.chunker import ChunkPlan
from audio_pipeline.vad import Segment


class Preprocessor(Protocol):
    """Model-independent contract consumed by the durable job runner."""

    def decode(self, source: Path, destination: Path) -> int: ...

    def speech_probabilities(
        self,
        pcm: np.ndarray,
        *,
        output_path: Path,
        checkpoint_path: Path,
        progress: Callable[[float], None] | None = None,
    ) -> np.ndarray: ...

    def detect_speech(
        self, probabilities: np.ndarray, duration_seconds: float
    ) -> list[Segment]: ...

    def plan(self, segments: list[Segment], probabilities: np.ndarray) -> list[ChunkPlan]: ...


class Aligner(Protocol):
    """Optional independent forced-aligner boundary; no approximation fallback."""

    async def align(
        self,
        audio: bytes,
        text: str,
        *,
        sample_rate: int,
    ) -> list[dict[str, float | str]]: ...
