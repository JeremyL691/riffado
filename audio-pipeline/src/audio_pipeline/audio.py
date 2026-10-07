"""ffmpeg-backed audio I/O.

The source file is decoded exactly once into a raw 16 kHz mono s16le PCM cache
(``audio.pcm``, ~115 MB per hour). VAD and chunk extraction then work on a
memory map of that cache, so a 24 h recording never has to sit in RAM and every
chunk is cut at a sample-exact position of the original timeline.
"""

from __future__ import annotations

import io
import json
import os
import subprocess
import wave
from pathlib import Path

import numpy as np

SAMPLE_RATE = 16_000
BYTES_PER_SAMPLE = 2

CONTENT_TYPES = {"wav": "audio/wav", "flac": "audio/flac", "mp3": "audio/mpeg"}


class AudioError(RuntimeError):
    """Raised when ffmpeg/ffprobe cannot read or encode audio."""


def probe_duration(path: Path) -> float | None:
    """Container-reported duration in seconds, or ``None`` when unknown."""
    try:
        out = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "json",
                str(path),
            ],
            check=True,
            capture_output=True,
            timeout=120,
        ).stdout
        value = json.loads(out).get("format", {}).get("duration")
        return float(value) if value not in (None, "N/A") else None
    except (subprocess.SubprocessError, ValueError, OSError):
        return None


def decode_to_pcm(source: Path, dest: Path) -> int:
    """Decode ``source`` to a 16 kHz mono s16le file at ``dest``; returns sample count.

    Writes to a temporary sibling and renames on success so a crash never leaves
    a truncated cache that looks complete.
    """
    tmp = dest.with_suffix(".pcm.partial")
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(source),
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        str(SAMPLE_RATE),
        "-f",
        "s16le",
        "-acodec",
        "pcm_s16le",
        str(tmp),
    ]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        tmp.unlink(missing_ok=True)
        raise AudioError(f"ffmpeg decode failed: {proc.stderr.decode(errors='replace').strip()}")
    os.replace(tmp, dest)
    return dest.stat().st_size // BYTES_PER_SAMPLE


def open_pcm(path: Path) -> np.ndarray:
    """Read-only memory map of a PCM cache as int16 samples (empty array for empty files)."""
    if path.stat().st_size < BYTES_PER_SAMPLE:
        return np.zeros(0, dtype=np.int16)
    return np.memmap(path, dtype=np.int16, mode="r")


def assemble(pcm: np.ndarray, pieces: list[tuple[float, float, float]]) -> np.ndarray:
    """Build chunk audio from ``(local_start, abs_start, duration)`` pieces.

    Gaps between pieces in local time are filled with digital silence, which is
    how long pauses are compressed without losing the mapping back to the
    original timeline.
    """
    if not pieces:
        return np.zeros(0, dtype=np.int16)
    last_local, _, last_dur = pieces[-1]
    total = int(round((last_local + last_dur) * SAMPLE_RATE))
    out = np.zeros(total, dtype=np.int16)
    n = len(pcm)
    for local_start, abs_start, duration in pieces:
        src0 = max(0, int(round(abs_start * SAMPLE_RATE)))
        src1 = min(n, src0 + int(round(duration * SAMPLE_RATE)))
        dst0 = int(round(local_start * SAMPLE_RATE))
        length = max(0, min(src1 - src0, total - dst0))
        out[dst0 : dst0 + length] = pcm[src0 : src0 + length]
    return out


def encode(samples: np.ndarray, fmt: str) -> bytes:
    """Encode int16 mono 16 kHz samples as ``wav``, ``flac`` or ``mp3``."""
    if fmt == "wav":
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(BYTES_PER_SAMPLE)
            w.setframerate(SAMPLE_RATE)
            w.writeframes(samples.astype("<i2", copy=False).tobytes())
        return buf.getvalue()
    codec_args = {
        "flac": ["-c:a", "flac", "-f", "flac"],
        "mp3": ["-c:a", "libmp3lame", "-b:a", "64k", "-f", "mp3"],
    }.get(fmt)
    if codec_args is None:
        raise AudioError(f"unsupported chunk format: {fmt}")
    proc = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "error",
            "-f",
            "s16le",
            "-ar",
            str(SAMPLE_RATE),
            "-ac",
            "1",
            "-i",
            "pipe:0",
            *codec_args,
            "pipe:1",
        ],
        input=samples.astype("<i2", copy=False).tobytes(),
        capture_output=True,
    )
    if proc.returncode != 0:
        raise AudioError(f"ffmpeg encode failed: {proc.stderr.decode(errors='replace').strip()}")
    return proc.stdout
