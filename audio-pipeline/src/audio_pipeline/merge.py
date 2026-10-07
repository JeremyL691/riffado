"""Strict timestamp validation and restoration to the source recording clock."""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass

from audio_pipeline.audio import SAMPLE_RATE
from audio_pipeline.chunker import ChunkPlan


@dataclass(frozen=True)
class TranscriptSegment:
    start_ms: int
    end_ms: int
    text: str
    timestamp_source: str = "native"

    def to_dict(self) -> dict[str, int | str]:
        return asdict(self)


class InvalidTimestampError(ValueError):
    pass


def map_native_segments(
    chunk: ChunkPlan,
    local_segments: list[dict[str, object]],
) -> list[TranscriptSegment]:
    """Validate provider-native chunk-relative seconds and map to absolute ms.

    Invalid or missing timestamps are not fabricated. The caller should retain
    the text and set the task to ``needs_alignment`` instead.
    """
    if not local_segments:
        raise InvalidTimestampError("provider returned no native segment timestamps")
    duration = chunk.audio_seconds
    mapped: list[TranscriptSegment] = []
    previous_start = -1.0
    for item in local_segments:
        start = item.get("start")
        end = item.get("end")
        text = item.get("text")
        if (
            not isinstance(start, (int, float))
            or not isinstance(end, (int, float))
            or not isinstance(text, str)
            or not text.strip()
        ):
            raise InvalidTimestampError("provider segment has an invalid shape")
        start_s, end_s = float(start), float(end)
        if not math.isfinite(start_s) or not math.isfinite(end_s):
            raise InvalidTimestampError("provider timestamp is not finite")
        if start_s < 0 or end_s <= start_s or end_s > duration:
            raise InvalidTimestampError("provider timestamp is outside its chunk")
        if start_s < previous_start:
            raise InvalidTimestampError("provider timestamps are out of order")
        previous_start = start_s
        offset = chunk.start_sample / SAMPLE_RATE
        abs_start_ms = round((offset + start_s) * 1000)
        abs_end_ms = round((offset + end_s) * 1000)
        mapped.append(
            TranscriptSegment(
                start_ms=abs_start_ms,
                end_ms=abs_end_ms,
                text=text.strip(),
            )
        )
    return mapped


def merge_chunk_results(
    chunks: list[tuple[ChunkPlan, dict[str, object]]],
) -> tuple[str, list[TranscriptSegment], bool]:
    """Merge text by chunk order and exact native timestamps where available.

    Returns ``(text, timeline, needs_alignment)``. If any chunk lacks usable
    native timestamps, text is retained and the timeline is empty rather than
    presenting estimated positions as accurate.
    """
    ordered = sorted(chunks, key=lambda pair: pair[0].start_sample)
    texts: list[str] = []
    timeline: list[TranscriptSegment] = []
    missing_time = False
    for plan, result in ordered:
        text = result.get("text")
        has_text = isinstance(text, str) and bool(text.strip())
        if has_text:
            texts.append(text.strip())
        raw_segments = result.get("segments")
        if not isinstance(raw_segments, list) or not raw_segments:
            # Empty STT responses do not need positions: there is no text to
            # locate. A chunk with recognized text but no timestamps remains
            # an alignment dependency and must not be presented as complete.
            if has_text:
                missing_time = True
            continue
        if not has_text:
            # Segment text without the provider's corresponding full-text
            # response is a contract mismatch, even if the timestamps exist.
            missing_time = True
            continue
        try:
            timeline.extend(map_native_segments(plan, raw_segments))
        except InvalidTimestampError:
            missing_time = True
    timeline.sort(key=lambda seg: (seg.start_ms, seg.end_ms))
    full_text = "\n\n".join(texts)
    if missing_time:
        return full_text, [], True
    return full_text, timeline, False


def render_srt(segments: list[TranscriptSegment]) -> str:
    def stamp(value: int) -> str:
        hours, rem = divmod(value, 3_600_000)
        minutes, rem = divmod(rem, 60_000)
        seconds, ms = divmod(rem, 1000)
        return f"{hours:02}:{minutes:02}:{seconds:02},{ms:03}"

    return "\n\n".join(
        f"{index}\n{stamp(segment.start_ms)} --> {stamp(segment.end_ms)}\n{segment.text}"
        for index, segment in enumerate(segments, 1)
    )


def render_vtt(segments: list[TranscriptSegment]) -> str:
    def stamp(value: int) -> str:
        hours, rem = divmod(value, 3_600_000)
        minutes, rem = divmod(rem, 60_000)
        seconds, ms = divmod(rem, 1000)
        return f"{hours:02}:{minutes:02}:{seconds:02}.{ms:03}"

    cues = [
        f"{stamp(segment.start_ms)} --> {stamp(segment.end_ms)}\n{segment.text}"
        for segment in segments
    ]
    return "WEBVTT\n\n" + "\n\n".join(cues)
