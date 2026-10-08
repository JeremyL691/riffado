import { describe, expect, it } from "vitest";
import { isRepairResult } from "@/lib/transcription/audio-pipeline-repair";

function result(overrides: Record<string, unknown> = {}) {
    return {
        schema_version: 1,
        text: "A saved transcript",
        status: "completed",
        timestamp_source: "native",
        timeline: [{ start_ms: 0, end_ms: 100, text: "A saved transcript" }],
        metadata: {
            duration_ms: 1000,
            timestamp_policy: {
                name: "chunk_end_guard_50ms_v1",
                normalized_segment_count: 0,
                ignored_blank_segment_count: 0,
            },
        },
        ...overrides,
    };
}

describe("offline timeline repair payload validation", () => {
    it("accepts an unchanged native timeline", () => {
        expect(isRepairResult(result())).toBe(true);
    });

    it("accepts a normalized endpoint with a 25ms recorded correction", () => {
        expect(
            isRepairResult(
                result({
                    timestamp_source: "normalized",
                    timeline: [
                        {
                            start_ms: 850,
                            end_ms: 1000,
                            text: "end",
                            timestamp_source: "normalized",
                            timestamp_correction: {
                                reason: "chunk_end_guard",
                                original_end_ms: 1025,
                                normalized_end_ms: 1000,
                                chunk_index: 9,
                            },
                        },
                    ],
                    metadata: {
                        duration_ms: 1000,
                        timestamp_policy: {
                            name: "chunk_end_guard_50ms_v1",
                            normalized_segment_count: 1,
                            ignored_blank_segment_count: 0,
                        },
                    },
                }),
            ),
        ).toBe(true);
    });

    it("rejects a correction larger than the approved 50ms bound", () => {
        expect(
            isRepairResult(
                result({
                    timestamp_source: "normalized",
                    timeline: [
                        {
                            start_ms: 900,
                            end_ms: 1000,
                            text: "end",
                            timestamp_correction: {
                                reason: "chunk_end_guard",
                                original_end_ms: 1051,
                                normalized_end_ms: 1000,
                                chunk_index: 9,
                            },
                        },
                    ],
                }),
            ),
        ).toBe(false);
    });

    it("rejects source metadata that disagrees with normalized segments", () => {
        expect(
            isRepairResult(
                result({
                    timestamp_source: "native",
                    timeline: [
                        {
                            start_ms: 900,
                            end_ms: 1000,
                            text: "end",
                            timestamp_correction: {
                                reason: "chunk_end_guard",
                                original_end_ms: 1025,
                                normalized_end_ms: 1000,
                                chunk_index: 9,
                            },
                        },
                    ],
                }),
            ),
        ).toBe(false);
    });

    it("rejects a normalized segment whose correction count is not recorded", () => {
        expect(
            isRepairResult(
                result({
                    timestamp_source: "normalized",
                    timeline: [
                        {
                            start_ms: 900,
                            end_ms: 1000,
                            text: "end",
                            timestamp_source: "normalized",
                            timestamp_correction: {
                                reason: "chunk_end_guard",
                                original_end_ms: 1025,
                                normalized_end_ms: 1000,
                                chunk_index: 9,
                            },
                        },
                    ],
                    metadata: {
                        duration_ms: 1000,
                        timestamp_policy: {
                            name: "chunk_end_guard_50ms_v1",
                            normalized_segment_count: 0,
                            ignored_blank_segment_count: 0,
                        },
                    },
                }),
            ),
        ).toBe(false);
    });
});
