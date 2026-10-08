import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    transaction: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
    postProcess: vi.fn(),
    emitEvent: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
    and: vi.fn(() => ({})),
    asc: vi.fn(() => ({})),
    desc: vi.fn(() => ({})),
    eq: vi.fn(() => ({})),
    inArray: vi.fn(() => ({})),
    isNotNull: vi.fn(() => ({})),
    isNull: vi.fn(() => ({})),
    sql: vi.fn(() => ({})),
}));

vi.mock("@/db", () => ({
    db: {
        transaction: mocks.transaction,
        select: mocks.select,
        update: mocks.update,
    },
}));

vi.mock("@/db/schema", () => {
    const columns = (table: string) =>
        new Proxy({}, { get: (_target, key) => `${table}.${String(key)}` });
    return {
        aiEnhancements: columns("aiEnhancements"),
        audioPipelineJobs: columns("audioPipelineJobs"),
        recordings: columns("recordings"),
        transcriptions: columns("transcriptions"),
    };
});

vi.mock("@/lib/env", () => ({
    env: {
        AUDIO_PIPELINE_BASE_URL: "http://pipeline.internal",
        AUDIO_PIPELINE_ENABLED: true,
        AUDIO_PIPELINE_TOKEN: "controlled-test-token",
        IS_HOSTED: false,
    },
}));

vi.mock("@/lib/encryption/fields", () => ({
    encryptJsonField: vi.fn((value: unknown) => JSON.stringify(value)),
    encryptText: vi.fn((value: string) => `encrypted:${value}`),
}));

vi.mock("@/lib/transcription/postprocess", () => ({
    postProcessPipelineTranscription: mocks.postProcess,
}));

vi.mock("@/lib/webhooks/emit", () => ({ emitEvent: mocks.emitEvent }));

import {
    processJob,
    reconcilePipelineFinalization,
} from "@/lib/transcription/audio-pipeline";

const job = {
    id: "core-job",
    userId: "user-1",
    recordingId: "recording-1",
    generation: 1,
    providerId: "provider-1",
    provider: "elevenlabs",
    model: "scribe_v1",
    language: "en",
    durationMs: 1000,
    status: "running",
    pipelineJobId: "pipeline-job",
    attempts: 0,
    leaseToken: "lease-token",
};

const pipelineResult = {
    schema_version: 1,
    text: "A synthetic transcript",
    timeline: [{ start_ms: 0, end_ms: 100, text: "A synthetic transcript" }],
    timestamp_source: "native",
    status: "completed",
    metadata: {
        duration_ms: 1000,
        timestamp_policy: {
            name: "chunk_end_guard_50ms_v1",
            normalized_segment_count: 0,
            ignored_blank_segment_count: 0,
        },
    },
};

function makeTransaction() {
    const rows = [
        { deletedAt: null },
        { generation: 1, status: "running", configSnapshot: {} },
        { generation: 1 },
        { id: "transcription-1" },
    ];
    let selection = 0;
    const tx: Record<string, ReturnType<typeof vi.fn>> = {
        select: vi.fn(() => {
            const builder: Record<string, ReturnType<typeof vi.fn>> = {};
            builder.from = vi.fn(() => builder);
            builder.where = vi.fn(() => builder);
            builder.for = vi.fn(() => builder);
            builder.orderBy = vi.fn(() => builder);
            builder.limit = vi.fn(async () => {
                const row = rows[selection++];
                return row ? [row] : [];
            });
            return builder;
        }),
        update: vi.fn(() => {
            const builder: Record<string, ReturnType<typeof vi.fn>> = {};
            builder.set = vi.fn(() => builder);
            builder.where = vi.fn(async () => undefined);
            return builder;
        }),
        delete: vi.fn(() => {
            const builder: Record<string, ReturnType<typeof vi.fn>> = {};
            builder.where = vi.fn(async () => undefined);
            return builder;
        }),
    };
    return tx;
}

function queryResult(result: unknown[]) {
    const builder: Record<string, ReturnType<typeof vi.fn>> = {};
    builder.from = vi.fn(() => builder);
    builder.where = vi.fn(() => builder);
    builder.orderBy = vi.fn(() => builder);
    builder.limit = vi.fn(async () => result);
    return builder;
}

describe("audio pipeline coordinator recovery", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });

    it("replays an uncommitted result after restart and acknowledges a committed result without duplicate events", async () => {
        let transactionCount = 0;
        mocks.transaction.mockImplementation(async (callback) => {
            transactionCount += 1;
            const committed = await callback(makeTransaction());
            if (transactionCount === 1) {
                throw new Error("injected Core interruption before commit");
            }
            return committed;
        });

        let selectCount = 0;
        mocks.select.mockImplementation(() => {
            selectCount += 1;
            if (selectCount === 2) {
                return queryResult([
                    {
                        id: job.id,
                        pipelineJobId: job.pipelineJobId,
                        status: "completed",
                    },
                ]);
            }
            return queryResult([{ pipelineJobId: job.pipelineJobId }]);
        });

        let ackCount = 0;
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith("/v1/jobs/pipeline-job")) {
                return Response.json({
                    status: "completed",
                    phase: "completed",
                    progress: 1,
                });
            }
            if (url.endsWith("/v1/jobs/pipeline-job/result")) {
                return Response.json(pipelineResult);
            }
            if (url.endsWith("/v1/jobs/pipeline-job/ack")) {
                ackCount += 1;
                return new Response(null, {
                    status: ackCount === 1 ? 503 : 200,
                });
            }
            throw new Error(`Unexpected pipeline request: ${url}`);
        });
        vi.stubGlobal("fetch", fetchMock);

        const coreUpdate = vi.fn(() => {
            const builder: Record<string, ReturnType<typeof vi.fn>> = {};
            builder.set = vi.fn(() => builder);
            builder.where = vi.fn(async () => undefined);
            return builder;
        });
        mocks.update.mockImplementation(coreUpdate);

        await expect(processJob(job)).rejects.toThrow(
            "injected Core interruption before commit",
        );
        expect(mocks.postProcess).not.toHaveBeenCalled();
        expect(mocks.emitEvent).not.toHaveBeenCalled();
        expect(ackCount).toBe(0);

        await processJob(job);
        expect(transactionCount).toBe(2);
        expect(mocks.postProcess).toHaveBeenCalledTimes(1);
        expect(mocks.emitEvent).toHaveBeenCalledTimes(1);
        expect(ackCount).toBe(1);

        await reconcilePipelineFinalization();

        expect(ackCount).toBe(2);
        expect(mocks.postProcess).toHaveBeenCalledTimes(1);
        expect(mocks.emitEvent).toHaveBeenCalledTimes(1);
        expect(coreUpdate).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
            "http://pipeline.internal/v1/jobs/pipeline-job",
            "http://pipeline.internal/v1/jobs/pipeline-job/result",
            "http://pipeline.internal/v1/jobs/pipeline-job",
            "http://pipeline.internal/v1/jobs/pipeline-job/result",
            "http://pipeline.internal/v1/jobs/pipeline-job/ack",
            "http://pipeline.internal/v1/jobs/pipeline-job/ack",
        ]);
    });
});
