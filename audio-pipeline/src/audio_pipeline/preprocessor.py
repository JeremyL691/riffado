"""Silero/FFmpeg implementation of the replaceable preprocessing contract."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import numpy as np

from audio_pipeline.audio import decode_to_pcm
from audio_pipeline.chunker import ChunkPlan, plan_chunks
from audio_pipeline.config import ChunkingConfig, VadConfig
from audio_pipeline.vad import Segment, SileroVad, speech_segments


class SileroPreprocessor:
    def __init__(
        self, vad_config: VadConfig, chunking_config: ChunkingConfig, model_path: Path
    ) -> None:
        self.vad_config = vad_config
        self.chunking_config = chunking_config
        self.vad = SileroVad(model_path, vad_config.num_threads)

    def decode(self, source: Path, destination: Path) -> int:
        return decode_to_pcm(source, destination)

    def speech_probabilities(
        self,
        pcm: np.ndarray,
        *,
        output_path: Path,
        checkpoint_path: Path,
        progress: Callable[[float], None] | None = None,
    ) -> np.ndarray:
        return self.vad.frame_probabilities(
            pcm,
            batch_size=self.vad_config.batch_size,
            min_section_seconds=self.vad_config.min_section_seconds,
            progress=progress,
            output_path=output_path,
            checkpoint_path=checkpoint_path,
        )

    def detect_speech(self, probabilities: np.ndarray, duration_seconds: float) -> list[Segment]:
        return speech_segments(probabilities, self.vad_config, duration_seconds)

    def plan(
        self,
        segments: list[Segment],
        probabilities: np.ndarray,
        *,
        total_samples: int,
    ) -> list[ChunkPlan]:
        return plan_chunks(
            segments,
            self.chunking_config,
            probabilities,
            total_samples=total_samples,
        )
