"""Configuration: server settings, VAD/chunking defaults and named STT profiles.

Loaded from a YAML file (``AUDIO_PIPELINE_CONFIG``, default ``/app/config.yaml``)
with ``${ENV_VAR}`` / ``${ENV_VAR:-default}`` interpolation so secrets stay in
the environment. Every section has defaults, so an empty file is valid and
yields a single ``mock`` profile.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, Field, model_validator

_ENV_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}")


class ServerConfig(BaseModel):
    data_dir: Path = Path("/data")
    api_token: str | None = None
    core_base_url: str = "http://app:3000"
    max_concurrent_jobs: int = Field(1, ge=1, le=4)
    stt_concurrency: int = Field(2, ge=1, le=2)
    max_upload_mb: int = Field(8192, ge=1)
    keep_pcm: bool = False
    facade_wait_seconds: float = Field(3300, ge=1)


class VadConfig(BaseModel):
    model_path: Path | None = None
    threshold: float = Field(0.5, gt=0, lt=1)
    neg_threshold: float | None = None
    min_speech_ms: int = Field(100, ge=0)
    min_silence_ms: int = Field(400, ge=0)
    speech_pad_ms: int = Field(250, ge=0)
    batch_size: int = Field(16, ge=1, le=256)
    min_section_seconds: float = Field(300, ge=10)
    num_threads: int = Field(1, ge=1, le=64)


class ChunkingConfig(BaseModel):
    """Smart chunking knobs. All durations in seconds of *chunk audio*."""

    target_seconds: float = Field(120, gt=0)
    max_seconds: float = Field(170, gt=0)
    min_seconds: float = Field(4, ge=0)
    keep_gap_seconds: float = Field(1.5, ge=0)
    natural_pause_seconds: float = Field(1.0, gt=0)
    min_chunk_speech_seconds: float = Field(0.5, ge=0)
    timestamp_guard_ms: int = Field(50, ge=0, le=250)

    @model_validator(mode="after")
    def _check(self) -> ChunkingConfig:
        if self.target_seconds > self.max_seconds:
            raise ValueError("chunking.target_seconds must be <= max_seconds")
        if self.max_seconds < 5:
            raise ValueError("chunking.max_seconds must be >= 5")
        return self


class OutputConfig(BaseModel):
    timestamps: bool = True
    paragraph_gap_seconds: float = Field(2.5, ge=0)
    paragraph_max_seconds: float = Field(90, gt=0)
    drop_phrases: list[str] = Field(default_factory=list)


class RetryConfig(BaseModel):
    max_attempts: int = Field(6, ge=1, le=50)
    base_delay_seconds: float = Field(2.0, gt=0)
    max_delay_seconds: float = Field(120.0, gt=0)


class ProfileConfig(BaseModel):
    """A named STT target. ``provider`` selects the adapter in ``stt/``."""

    provider: str
    model: str | None = None
    base_url: str | None = None
    api_key: str | None = None
    language: str | None = None
    prompt: str | None = None
    timeout_seconds: float = Field(300, gt=0)
    concurrency: int = Field(4, ge=1, le=64)
    audio_format: Literal["wav", "flac", "mp3"] | None = None
    options: dict[str, Any] = Field(default_factory=dict)
    chunking: dict[str, Any] = Field(default_factory=dict)
    output: dict[str, Any] = Field(default_factory=dict)
    retry: dict[str, Any] = Field(default_factory=dict)


class AppConfig(BaseModel):
    server: ServerConfig = Field(default_factory=ServerConfig)
    vad: VadConfig = Field(default_factory=VadConfig)
    chunking: ChunkingConfig = Field(default_factory=ChunkingConfig)
    output: OutputConfig = Field(default_factory=OutputConfig)
    retry: RetryConfig = Field(default_factory=RetryConfig)
    default_profile: str = "mock"
    profiles: dict[str, ProfileConfig] = Field(
        default_factory=lambda: {"mock": ProfileConfig(provider="mock")}
    )

    @model_validator(mode="after")
    def _check_default(self) -> AppConfig:
        if self.default_profile not in self.profiles:
            raise ValueError(f"default_profile '{self.default_profile}' is not defined in profiles")
        return self

    def resolve_profile_name(self, name: str | None) -> str:
        """Map a requested profile (``None``/``"default"`` allowed) to a defined name."""
        if not name or name == "default":
            return self.default_profile
        if name not in self.profiles:
            raise KeyError(name)
        return name

    def chunking_for(self, profile: str) -> ChunkingConfig:
        return _merge(self.chunking, self.profiles[profile].chunking)

    def output_for(self, profile: str) -> OutputConfig:
        return _merge(self.output, self.profiles[profile].output)

    def retry_for(self, profile: str) -> RetryConfig:
        return _merge(self.retry, self.profiles[profile].retry)


def _merge[M: BaseModel](base: M, overrides: dict[str, Any]) -> M:
    if not overrides:
        return base
    return type(base).model_validate({**base.model_dump(), **overrides})


def _interpolate(value: Any) -> Any:
    if isinstance(value, str):
        return _ENV_RE.sub(lambda m: os.environ.get(m.group(1), m.group(2) or ""), value)
    if isinstance(value, dict):
        return {k: _interpolate(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_interpolate(v) for v in value]
    return value


def load_config(path: str | os.PathLike[str] | None = None) -> AppConfig:
    """Load config from ``path`` or ``$AUDIO_PIPELINE_CONFIG``; missing file means defaults."""
    raw_path = path or os.environ.get("AUDIO_PIPELINE_CONFIG", "/app/config.yaml")
    file = Path(raw_path)
    data: dict[str, Any] = {}
    if file.is_file():
        loaded = yaml.safe_load(file.read_text(encoding="utf-8")) or {}
        if not isinstance(loaded, dict):
            raise ValueError(f"{file}: top level must be a mapping")
        data = _interpolate(loaded)
    config = AppConfig.model_validate(data)
    env_token = os.environ.get("AUDIO_PIPELINE_TOKEN")
    if env_token:
        config.server.api_token = env_token
    env_data = os.environ.get("AUDIO_PIPELINE_DATA_DIR")
    if env_data:
        config.server.data_dir = Path(env_data)
    env_core = os.environ.get("AUDIO_PIPELINE_CORE_URL")
    if env_core:
        config.server.core_base_url = env_core.rstrip("/")
    for profile in config.profiles.values():
        if profile.api_key == "":
            profile.api_key = None
    return config
