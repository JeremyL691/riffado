export interface TimelineSegment {
    start_ms: number;
    end_ms: number;
    text: string;
    timestamp_source?: "native" | "normalized";
    speaker_id?: string;
    chunk_index?: number;
    timestamp_correction?: {
        reason: "chunk_end_guard";
        original_end_ms: number;
        normalized_end_ms: number;
        chunk_index: number;
    };
}

export interface RepairResult {
    schema_version: 1;
    text: string;
    timeline: TimelineSegment[];
    timestamp_source: "native" | "normalized";
    status: "completed";
    metadata: {
        duration_ms: number;
        timestamp_policy: {
            name: "chunk_end_guard_50ms_v1";
            normalized_segment_count: number;
            ignored_blank_segment_count: number;
        };
    };
}

export function isRepairResult(value: unknown): value is RepairResult {
    if (!value || typeof value !== "object") return false;
    const result = value as Partial<RepairResult>;
    if (
        result.schema_version !== 1 ||
        typeof result.text !== "string" ||
        !Array.isArray(result.timeline) ||
        !result.timeline.length ||
        !["native", "normalized"].includes(result.timestamp_source ?? "") ||
        result.status !== "completed" ||
        !result.metadata ||
        !Number.isSafeInteger(result.metadata.duration_ms) ||
        (result.metadata.duration_ms ?? -1) < 0 ||
        result.timeline.length > 200_000
    ) {
        return false;
    }

    let previousStart = -1;
    let normalizedCount = 0;
    for (const item of result.timeline) {
        if (
            !item ||
            typeof item !== "object" ||
            !Number.isSafeInteger(item.start_ms) ||
            !Number.isSafeInteger(item.end_ms) ||
            typeof item.text !== "string" ||
            !item.text.trim() ||
            item.start_ms < 0 ||
            item.end_ms <= item.start_ms ||
            item.end_ms > (result.metadata.duration_ms ?? 0) + 1 ||
            item.start_ms < previousStart
        ) {
            return false;
        }
        previousStart = item.start_ms;
        if (item.timestamp_correction) {
            const correction = item.timestamp_correction;
            if (
                correction.reason !== "chunk_end_guard" ||
                !Number.isSafeInteger(correction.original_end_ms) ||
                correction.normalized_end_ms !== item.end_ms ||
                !Number.isSafeInteger(correction.chunk_index) ||
                correction.chunk_index < 0 ||
                correction.original_end_ms <= item.end_ms ||
                correction.original_end_ms - item.end_ms > 50
            ) {
                return false;
            }
            if (
                item.timestamp_source !== undefined &&
                item.timestamp_source !== "normalized"
            ) {
                return false;
            }
            normalizedCount += 1;
        } else if (item.timestamp_source === "normalized") {
            return false;
        }
    }

    const policy = result.metadata.timestamp_policy;
    if (
        !policy ||
        policy.name !== "chunk_end_guard_50ms_v1" ||
        !Number.isSafeInteger(policy.normalized_segment_count) ||
        policy.normalized_segment_count !== normalizedCount ||
        !Number.isSafeInteger(policy.ignored_blank_segment_count) ||
        policy.ignored_blank_segment_count < 0
    ) {
        return false;
    }
    if (result.timestamp_source === "normalized" && normalizedCount === 0) {
        return false;
    }
    if (result.timestamp_source === "native" && normalizedCount !== 0) {
        return false;
    }
    return true;
}
