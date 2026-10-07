"""Provider-neutral STT boundary; provider credentials remain in Riffado Core."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Protocol

import httpx


@dataclass(frozen=True)
class ProviderCapabilities:
    formats: tuple[str, ...] = ("wav",)
    max_duration_seconds: int = 170
    max_file_bytes: int = 50 * 1024 * 1024
    native_timestamps: bool = False


@dataclass(frozen=True)
class ChunkAudio:
    job_id: str
    chunk_id: str
    index: int
    start_sample: int
    end_sample: int
    content_sha256: str
    audio: bytes
    content_type: str = "audio/wav"


class STTProvider(Protocol):
    @property
    def capabilities(self) -> ProviderCapabilities: ...

    async def transcribe(self, chunk: ChunkAudio) -> dict[str, object]: ...


class ProviderRequestError(RuntimeError):
    def __init__(self, status_code: int | None, message: str, retry_after: float | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.retry_after = retry_after

    @property
    def retryable(self) -> bool:
        return (
            self.status_code is None
            or self.status_code in {408, 429}
            or (self.status_code is not None and 500 <= self.status_code < 600)
        )


class CoreBridgeProvider:
    """Calls the authenticated Core bridge for each chunk, never a model API."""

    # The generic Core bridge does not guarantee that every configured model
    # returns timestamps. Actual returned segments are still preserved.
    capabilities = ProviderCapabilities(native_timestamps=False)

    def __init__(self, base_url: str, token: str, timeout_seconds: float = 3600) -> None:
        self._url = base_url.rstrip("/")
        self._token = token
        self._timeout = timeout_seconds

    async def transcribe(self, chunk: ChunkAudio) -> dict[str, object]:
        data = {
            "chunk_id": chunk.chunk_id,
            "chunk_index": str(chunk.index),
            "start_sample": str(chunk.start_sample),
            "end_sample": str(chunk.end_sample),
            "content_sha256": chunk.content_sha256,
        }
        headers = {"Authorization": f"Bearer {self._token}"}
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                response = await client.post(
                    f"{self._url}/api/internal/audio-pipeline/jobs/{chunk.job_id}/chunks",
                    headers=headers,
                    data=data,
                    files={
                        "file": (f"chunk-{chunk.index:05d}.wav", chunk.audio, chunk.content_type)
                    },
                )
        except (httpx.TimeoutException, httpx.NetworkError) as exc:
            raise ProviderRequestError(None, f"Core bridge unavailable: {exc}") from exc
        if response.is_error:
            retry_after: float | None = None
            value = response.headers.get("retry-after")
            if value:
                try:
                    retry_after = max(0.0, float(value))
                except ValueError:
                    try:
                        retry_at = parsedate_to_datetime(value)
                        if retry_at.tzinfo is None:
                            retry_at = retry_at.replace(tzinfo=UTC)
                        retry_after = max(0.0, (retry_at - datetime.now(UTC)).total_seconds())
                    except (TypeError, ValueError, OverflowError):
                        retry_after = None
            message = "Core transcription bridge rejected the chunk"
            try:
                detail = response.json()
                if isinstance(detail, dict) and isinstance(detail.get("error"), str):
                    message = detail["error"]
            except ValueError:
                pass
            raise ProviderRequestError(response.status_code, message, retry_after)
        try:
            result = response.json()
        except ValueError as exc:
            raise ProviderRequestError(
                response.status_code, "Invalid Core bridge response"
            ) from exc
        if not isinstance(result, dict) or not isinstance(result.get("text"), str):
            raise ProviderRequestError(response.status_code, "Core bridge response is missing text")
        return result
