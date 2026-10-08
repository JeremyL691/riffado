import {
    and,
    asc,
    desc,
    eq,
    inArray,
    isNotNull,
    isNull,
    lt,
    or,
    sql,
} from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/db";
import {
    aiEnhancements,
    audioPipelineJobs,
    recordings,
    transcriptions,
} from "@/db/schema";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import { env } from "@/lib/env";
import { postProcessPipelineTranscription } from "@/lib/transcription/postprocess";
import { emitEvent } from "@/lib/webhooks/emit";

export interface QueueAudioPipelineInput {
    userId: string;
    recordingId: string;
    durationMs: number;
    providerId: string;
    provider: string;
    model: string;
    language?: string;
    speakerDiarization?: boolean;
    diarizationSpeakerCount?: number;
    trigger: "manual" | "sync";
    force: boolean;
}

export interface QueueAudioPipelineResult {
    jobId: string;
    reused: boolean;
}

export async function queueAudioPipelineJob(
    input: QueueAudioPipelineInput,
): Promise<QueueAudioPipelineResult | null> {
    const id = nanoid();
    const now = new Date();
    const queued = await db.transaction(async (tx) => {
        const [recording] = await tx
            .select({ id: recordings.id, deletedAt: recordings.deletedAt })
            .from(recordings)
            .where(
                and(
                    eq(recordings.id, input.recordingId),
                    eq(recordings.userId, input.userId),
                ),
            )
            .for("update")
            .limit(1);
        if (!recording || recording.deletedAt) return null;

        const jobs = await tx
            .select()
            .from(audioPipelineJobs)
            .where(
                and(
                    eq(audioPipelineJobs.recordingId, input.recordingId),
                    eq(audioPipelineJobs.userId, input.userId),
                ),
            )
            .orderBy(desc(audioPipelineJobs.generation))
            .limit(1);
        const latest = jobs[0];
        const active = Boolean(
            latest &&
                ["queued", "submitted", "running", "paused"].includes(
                    latest.status,
                ),
        );
        if (!input.force && latest && active) {
            return {
                jobId: latest.id,
                reused: true,
                supersededPipelineJobId: null,
            };
        }

        let supersededPipelineJobId: string | null = null;
        if (input.force && latest && active) {
            supersededPipelineJobId = latest.pipelineJobId;
            await tx
                .update(audioPipelineJobs)
                .set({
                    status: "superseded",
                    phase: "superseded",
                    errorMessage: "A newer transcription run replaced this job",
                    leaseToken: null,
                    leaseUntil: null,
                    updatedAt: now,
                })
                .where(
                    and(
                        eq(audioPipelineJobs.id, latest.id),
                        eq(audioPipelineJobs.userId, input.userId),
                    ),
                );
        }

        const generation = (latest?.generation ?? 0) + 1;
        await tx.insert(audioPipelineJobs).values({
            id,
            userId: input.userId,
            recordingId: input.recordingId,
            generation,
            providerId: input.providerId,
            provider: input.provider,
            model: input.model,
            language: input.language ?? null,
            trigger: input.trigger,
            durationMs: Math.max(0, Math.min(input.durationMs, 86_400_000)),
            status: "queued",
            phase: "queued",
            configSnapshot: {
                schema_version: 1,
                speaker_diarization: input.speakerDiarization ?? true,
                diarization_speaker_count:
                    input.diarizationSpeakerCount ?? null,
                vad: {
                    model: "silero-vad-onnx",
                    threshold: 0.5,
                    neg_threshold: 0.35,
                    min_speech_ms: 100,
                    min_silence_ms: 400,
                    speech_pad_ms: 250,
                },
                chunking: {
                    mode: "continuous",
                    target_seconds: 120,
                    max_seconds: 170,
                    long_silence_seconds: 1.5,
                    overlap_seconds: 0,
                    timestamp_guard_ms: 50,
                },
                provider: input.provider,
                model: input.model,
            },
            createdAt: now,
            updatedAt: now,
        });
        return { jobId: id, reused: false, supersededPipelineJobId };
    });

    if (!queued) return null;
    if (queued.supersededPipelineJobId) {
        void pipelineRequest(
            `/v1/jobs/${queued.supersededPipelineJobId}/cancel`,
            {
                method: "POST",
            },
        ).catch(() => undefined);
    }
    if (!queued.reused) wakeAudioPipelineWorker();
    return { jobId: queued.jobId, reused: queued.reused };
}

let workerStarted = false;
let workerRunning = false;
let workerTimer: ReturnType<typeof setInterval> | undefined;

export function startAudioPipelineWorker(): void {
    if (workerStarted || !env.AUDIO_PIPELINE_ENABLED || env.IS_HOSTED) return;
    workerStarted = true;
    void runWorkerPass();
    workerTimer = setInterval(() => void runWorkerPass(), 5_000);
    workerTimer.unref?.();
}

function wakeAudioPipelineWorker(): void {
    if (workerStarted) void runWorkerPass();
}

async function runWorkerPass(): Promise<void> {
    if (workerRunning || !env.AUDIO_PIPELINE_ENABLED || env.IS_HOSTED) return;
    workerRunning = true;
    try {
        await reconcilePipelineFinalization().catch((error) => {
            console.error(
                "[audio-pipeline] sidecar finalization check failed:",
                error,
            );
        });
        // Bound the pass; jobs are revisited on the next tick. The database
        // lease makes duplicate Next.js processes harmless.
        for (let i = 0; i < 4; i++) {
            const job = await claimJob();
            if (!job) break;
            try {
                await processJob(job);
            } catch (error) {
                console.error(
                    "[audio-pipeline] job reconciliation failed:",
                    error,
                );
                await releaseJob(job.id, job.leaseToken, {
                    errorType: "CoordinatorError",
                    errorMessage:
                        error instanceof Error ? error.message : String(error),
                    attemptsIncrement: true,
                    ...(job.attempts >= 5
                        ? { status: "failed", phase: "failed" }
                        : { retryAfterMs: pipelineRetryDelayMs(job.attempts) }),
                });
            }
        }
    } finally {
        workerRunning = false;
    }
}

interface ClaimedJob {
    id: string;
    userId: string;
    recordingId: string;
    generation: number;
    providerId: string | null;
    provider: string;
    model: string;
    language: string | null;
    durationMs: number;
    status: string;
    pipelineJobId: string | null;
    attempts: number;
    leaseToken: string;
}

async function claimJob(): Promise<ClaimedJob | null> {
    const now = new Date();
    const leaseToken = nanoid();
    return db.transaction(async (tx) => {
        const [job] = await tx
            .select()
            .from(audioPipelineJobs)
            .where(
                and(
                    inArray(audioPipelineJobs.status, [
                        "queued",
                        "submitted",
                        "running",
                        "paused",
                    ]),
                    or(
                        isNull(audioPipelineJobs.leaseUntil),
                        lt(audioPipelineJobs.leaseUntil, now),
                    ),
                ),
            )
            .orderBy(asc(audioPipelineJobs.createdAt))
            .limit(1)
            .for("update", { skipLocked: true });
        if (!job) return null;
        await tx
            .update(audioPipelineJobs)
            .set({
                leaseToken,
                leaseUntil: new Date(now.getTime() + 60_000),
                updatedAt: now,
            })
            .where(
                and(
                    eq(audioPipelineJobs.id, job.id),
                    eq(audioPipelineJobs.userId, job.userId),
                ),
            );
        return {
            id: job.id,
            userId: job.userId,
            recordingId: job.recordingId,
            generation: job.generation,
            providerId: job.providerId,
            provider: job.provider,
            model: job.model,
            language: job.language,
            durationMs: job.durationMs,
            status: job.status,
            pipelineJobId: job.pipelineJobId,
            attempts: job.attempts,
            leaseToken,
        };
    });
}

/** @internal Exported so recovery behavior can be exercised at process boundaries. */
export async function processJob(job: ClaimedJob): Promise<void> {
    let pipelineJobId = job.pipelineJobId;
    if (!pipelineJobId) {
        const response = await pipelineRequest("/v1/jobs", {
            method: "POST",
            body: JSON.stringify({
                idempotency_key: job.id,
                riffado_job_id: job.id,
                duration_ms: job.durationMs,
            }),
        });
        if (!response.ok) {
            const message = await errorMessage(response);
            const retryable = isRetryablePipelineStatus(response.status);
            await releaseJob(job.id, job.leaseToken, {
                errorType: `PipelineHTTP${response.status}`,
                errorMessage: message,
                attemptsIncrement: retryable,
                ...(!retryable || job.attempts >= 5
                    ? { status: "failed", phase: "failed" }
                    : { retryAfterMs: pipelineRetryDelayMs(job.attempts) }),
            });
            return;
        }
        const body = (await response.json()) as { job_id?: string };
        pipelineJobId = body.job_id ?? job.id;
        await db
            .update(audioPipelineJobs)
            .set({
                pipelineJobId,
                status: "submitted",
                phase: "queued",
                errorType: null,
                errorMessage: null,
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(audioPipelineJobs.id, job.id),
                    eq(audioPipelineJobs.userId, job.userId),
                    eq(audioPipelineJobs.leaseToken, job.leaseToken),
                ),
            );
    }

    const statusResponse = await pipelineRequest(`/v1/jobs/${pipelineJobId}`);
    if (!statusResponse.ok) {
        const retryable = isRetryablePipelineStatus(statusResponse.status);
        await releaseJob(job.id, job.leaseToken, {
            errorType: `PipelineHTTP${statusResponse.status}`,
            errorMessage: await errorMessage(statusResponse),
            attemptsIncrement: retryable,
            ...(!retryable || job.attempts >= 5
                ? { status: "failed", phase: "failed" }
                : { retryAfterMs: pipelineRetryDelayMs(job.attempts) }),
        });
        return;
    }
    const status = (await statusResponse.json()) as {
        status: string;
        phase: string;
        progress: number;
        error_type?: string | null;
        error?: string | null;
    };
    if (status.status === "failed") {
        await releaseJob(job.id, job.leaseToken, {
            status: "failed",
            phase: status.phase,
            progress: status.progress,
            errorType: status.error_type ?? "PipelineFailed",
            errorMessage: status.error ?? "Audio pipeline failed",
        });
        return;
    }
    if (status.status === "cancelled") {
        await releaseJob(job.id, job.leaseToken, {
            status: "cancelled",
            phase: "cancelled",
            progress: status.progress,
        });
        return;
    }
    if (status.status === "paused") {
        await releaseJob(job.id, job.leaseToken, {
            status: "paused",
            phase: status.phase,
            progress: status.progress,
            errorType: status.error_type ?? "DiskBudgetError",
            errorMessage: status.error ?? "Pipeline paused for disk space",
        });
        return;
    }
    if (status.status === "completed" || status.status === "needs_alignment") {
        const resultResponse = await pipelineRequest(
            `/v1/jobs/${pipelineJobId}/result`,
        );
        if (!resultResponse.ok)
            throw new Error(
                `Pipeline result returned HTTP ${resultResponse.status}`,
            );
        const result = (await resultResponse.json()) as PipelineResult;
        const committed = await persistPipelineResult(
            job,
            result,
            status.status,
        );
        if (committed) {
            try {
                await postProcessPipelineTranscription({
                    userId: job.userId,
                    recordingId: job.recordingId,
                    text: result.text,
                    jobId: job.id,
                    generation: job.generation,
                });
            } catch (error) {
                console.error(
                    "[audio-pipeline] transcript post-processing failed:",
                    error,
                );
            }
            try {
                await emitEvent(
                    "transcription.completed",
                    job.userId,
                    job.recordingId,
                );
            } catch (error) {
                console.error(
                    "[audio-pipeline] transcription event failed:",
                    error,
                );
            }
            await acknowledgePipelineJob(job.id);
        } else {
            // A deletion or a newer generation won the race. Do not publish
            // this result, but release its temporary workspace after the
            // stale job is safely discarded.
            await acknowledgePipelineJob(job.id);
            await releaseJob(job.id, job.leaseToken, {
                status: "superseded",
                phase: "superseded",
            });
        }
        return;
    }

    await releaseJob(job.id, job.leaseToken, {
        status: "running",
        phase: status.phase,
        progress: Number.isFinite(status.progress) ? status.progress : 0,
        errorType: null,
        errorMessage: null,
    });
}

interface PipelineResult {
    schema_version: number;
    status: "completed" | "needs_alignment";
    text: string;
    timeline: unknown[];
    timestamp_source: "native" | "normalized" | null;
    detected_language?: string | null;
    metadata: {
        duration_ms?: number;
        timestamp_policy?: {
            name: "chunk_end_guard_50ms_v1";
            normalized_segment_count: number;
            ignored_blank_segment_count: number;
        };
    };
}

async function persistPipelineResult(
    job: ClaimedJob,
    result: PipelineResult,
    sidecarStatus: string,
): Promise<boolean> {
    if (result.schema_version !== 1 || typeof result.text !== "string") {
        throw new Error(
            "Audio pipeline returned an unsupported result contract",
        );
    }
    let timeline = Array.isArray(result.timeline) ? result.timeline : [];
    let status: "completed" | "needs_alignment" =
        sidecarStatus === "needs_alignment" ||
        result.status === "needs_alignment"
            ? "needs_alignment"
            : "completed";
    const durationMs = result.metadata?.duration_ms ?? job.durationMs;
    if (timeline.length && !validateTimeline(timeline, durationMs)) {
        status = "needs_alignment";
        timeline = [];
    }
    if (status === "completed" && !timeline.length && result.text.trim()) {
        status = "needs_alignment";
    }

    const now = new Date();
    const encryptedText = encryptText(result.text);
    const encryptedTimeline = timeline.length
        ? encryptJsonField(timeline)
        : null;
    const committed = await db.transaction(async (tx) => {
        const [recording] = await tx
            .select({ deletedAt: recordings.deletedAt })
            .from(recordings)
            .where(
                and(
                    eq(recordings.id, job.recordingId),
                    eq(recordings.userId, job.userId),
                ),
            )
            .for("update")
            .limit(1);
        const [currentJob] = await tx
            .select({
                generation: audioPipelineJobs.generation,
                status: audioPipelineJobs.status,
                configSnapshot: audioPipelineJobs.configSnapshot,
            })
            .from(audioPipelineJobs)
            .where(
                and(
                    eq(audioPipelineJobs.id, job.id),
                    eq(audioPipelineJobs.userId, job.userId),
                    eq(audioPipelineJobs.leaseToken, job.leaseToken),
                ),
            )
            .for("update")
            .limit(1);
        const [latest] = await tx
            .select({ generation: audioPipelineJobs.generation })
            .from(audioPipelineJobs)
            .where(
                and(
                    eq(audioPipelineJobs.recordingId, job.recordingId),
                    eq(audioPipelineJobs.userId, job.userId),
                ),
            )
            .orderBy(desc(audioPipelineJobs.generation))
            .limit(1);
        if (
            !recording ||
            recording.deletedAt ||
            !currentJob ||
            currentJob.generation !== job.generation ||
            latest?.generation !== job.generation ||
            !["submitted", "running"].includes(currentJob.status)
        ) {
            return false;
        }

        const [existing] = await tx
            .select({ id: transcriptions.id })
            .from(transcriptions)
            .where(
                and(
                    eq(transcriptions.recordingId, job.recordingId),
                    eq(transcriptions.userId, job.userId),
                    eq(transcriptions.source, "riffado"),
                ),
            )
            .limit(1);
        const values = {
            text: encryptedText,
            detectedLanguage: result.detected_language ?? null,
            transcriptionType: "server",
            provider: job.provider,
            model: job.model,
            source: "riffado",
            timeline: encryptedTimeline,
            timelineSource: timeline.length
                ? (result.timestamp_source ?? "native")
                : null,
        } as const;
        if (existing) {
            await tx
                .update(transcriptions)
                .set(values)
                .where(
                    and(
                        eq(transcriptions.id, existing.id),
                        eq(transcriptions.userId, job.userId),
                    ),
                );
        } else {
            await tx.insert(transcriptions).values({
                id: nanoid(),
                recordingId: job.recordingId,
                userId: job.userId,
                ...values,
            });
        }
        await tx
            .delete(aiEnhancements)
            .where(
                and(
                    eq(aiEnhancements.recordingId, job.recordingId),
                    eq(aiEnhancements.userId, job.userId),
                    eq(aiEnhancements.source, "riffado"),
                ),
            );
        await tx
            .update(recordings)
            .set({ updatedAt: now })
            .where(
                and(
                    eq(recordings.id, job.recordingId),
                    eq(recordings.userId, job.userId),
                ),
            );
        await tx
            .update(audioPipelineJobs)
            .set({
                status,
                phase: status,
                progress: 1,
                timestampSource: timeline.length
                    ? (result.timestamp_source ?? "native")
                    : null,
                ...(result.metadata?.timestamp_policy
                    ? {
                          configSnapshot: {
                              ...((currentJob.configSnapshot &&
                              typeof currentJob.configSnapshot === "object" &&
                              !Array.isArray(currentJob.configSnapshot)
                                  ? currentJob.configSnapshot
                                  : {}) as Record<string, unknown>),
                              timestamp_policy:
                                  result.metadata.timestamp_policy,
                          },
                      }
                    : {}),
                errorType: null,
                errorMessage:
                    status === "needs_alignment"
                        ? "Provider returned no validated native timestamps"
                        : null,
                leaseToken: null,
                leaseUntil: null,
                completedAt: now,
                updatedAt: now,
            })
            .where(
                and(
                    eq(audioPipelineJobs.id, job.id),
                    eq(audioPipelineJobs.userId, job.userId),
                    eq(audioPipelineJobs.leaseToken, job.leaseToken),
                ),
            );
        return true;
    });
    return committed;
}

function validateTimeline(timeline: unknown[], durationMs: number): boolean {
    let previousStart = -1;
    for (const item of timeline) {
        if (!item || typeof item !== "object") return false;
        const segment = item as {
            start_ms?: unknown;
            end_ms?: unknown;
            text?: unknown;
        };
        const start = segment.start_ms;
        const end = segment.end_ms;
        if (
            typeof start !== "number" ||
            typeof end !== "number" ||
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            typeof segment.text !== "string" ||
            start < 0 ||
            end <= start ||
            end > durationMs + 1 ||
            start < previousStart
        )
            return false;
        previousStart = start;
    }
    return true;
}

async function releaseJob(
    id: string,
    leaseToken: string,
    values: {
        status?: string;
        phase?: string;
        progress?: number;
        errorType?: string | null;
        errorMessage?: string | null;
        attemptsIncrement?: boolean;
        retryAfterMs?: number;
    },
): Promise<void> {
    const now = new Date();
    await db
        .update(audioPipelineJobs)
        .set({
            ...(values.status ? { status: values.status } : {}),
            ...(values.phase ? { phase: values.phase } : {}),
            ...(values.progress !== undefined
                ? { progress: values.progress }
                : {}),
            ...(values.errorType !== undefined
                ? { errorType: values.errorType }
                : {}),
            ...(values.errorMessage !== undefined
                ? { errorMessage: values.errorMessage }
                : {}),
            ...(values.attemptsIncrement
                ? { attempts: sql`${audioPipelineJobs.attempts} + 1` }
                : {}),
            leaseToken: null,
            leaseUntil:
                values.retryAfterMs === undefined
                    ? null
                    : new Date(now.getTime() + values.retryAfterMs),
            updatedAt: now,
        })
        .where(
            and(
                eq(audioPipelineJobs.id, id),
                eq(audioPipelineJobs.leaseToken, leaseToken),
            ),
        );
}

async function pipelineRequest(
    path: string,
    init: RequestInit = {},
): Promise<Response> {
    const token = env.AUDIO_PIPELINE_TOKEN;
    if (!token)
        throw new Error("Audio pipeline service token is not configured");
    return fetch(`${env.AUDIO_PIPELINE_BASE_URL}${path}`, {
        ...init,
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(30_000),
    });
}

async function errorMessage(response: Response): Promise<string> {
    try {
        const body = (await response.json()) as {
            detail?: unknown;
            error?: unknown;
        };
        if (typeof body.error === "string") return body.error;
        if (typeof body.detail === "string") return body.detail;
    } catch {
        // Use the status text if the bridge returned a non-JSON error.
    }
    return `Audio pipeline returned HTTP ${response.status}`;
}

function isRetryablePipelineStatus(status: number): boolean {
    return status === 408 || status === 429 || status >= 500;
}

function pipelineRetryDelayMs(attempts: number): number {
    const exponentialDelay = Math.min(60_000, 1_000 * 2 ** attempts);
    return Math.round(exponentialDelay * (0.8 + Math.random() * 0.4));
}

export async function retryAudioPipelineJob(
    userId: string,
    jobId: string,
): Promise<boolean> {
    const [job] = await db
        .select()
        .from(audioPipelineJobs)
        .where(
            and(
                eq(audioPipelineJobs.id, jobId),
                eq(audioPipelineJobs.userId, userId),
            ),
        )
        .limit(1);
    if (!job || job.status !== "failed") return false;
    if (job.pipelineJobId) {
        const response = await pipelineRequest(
            `/v1/jobs/${job.pipelineJobId}/retry`,
            { method: "POST" },
        );
        if (!response.ok) return false;
        await db
            .update(audioPipelineJobs)
            .set({
                status: "submitted",
                phase: "queued",
                progress: 0,
                errorType: null,
                errorMessage: null,
                attempts: 0,
                sidecarAcknowledgedAt: null,
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(audioPipelineJobs.id, job.id),
                    eq(audioPipelineJobs.userId, userId),
                ),
            );
    } else {
        await db
            .update(audioPipelineJobs)
            .set({
                status: "queued",
                phase: "queued",
                attempts: 0,
                errorType: null,
                errorMessage: null,
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(audioPipelineJobs.id, job.id),
                    eq(audioPipelineJobs.userId, userId),
                ),
            );
    }
    wakeAudioPipelineWorker();
    return true;
}

export async function cancelAudioPipelineJob(
    userId: string,
    jobId: string,
): Promise<boolean> {
    const [job] = await db
        .select()
        .from(audioPipelineJobs)
        .where(
            and(
                eq(audioPipelineJobs.id, jobId),
                eq(audioPipelineJobs.userId, userId),
            ),
        )
        .limit(1);
    if (
        !job ||
        !["queued", "submitted", "running", "paused"].includes(job.status)
    )
        return false;
    if (job.pipelineJobId) {
        await pipelineRequest(`/v1/jobs/${job.pipelineJobId}/cancel`, {
            method: "POST",
        }).catch(() => undefined);
    }
    await db
        .update(audioPipelineJobs)
        .set({
            status: "cancelled",
            phase: "cancelled",
            leaseToken: null,
            leaseUntil: null,
            updatedAt: new Date(),
        })
        .where(
            and(
                eq(audioPipelineJobs.id, job.id),
                eq(audioPipelineJobs.userId, userId),
            ),
        );
    return true;
}

export async function acknowledgePipelineJob(jobId: string): Promise<void> {
    const [job] = await db
        .select({ pipelineJobId: audioPipelineJobs.pipelineJobId })
        .from(audioPipelineJobs)
        .where(eq(audioPipelineJobs.id, jobId))
        .limit(1);
    if (job?.pipelineJobId) {
        try {
            const response = await pipelineRequest(
                `/v1/jobs/${job.pipelineJobId}/ack`,
                {
                    method: "POST",
                },
            );
            if (response.ok || response.status === 404)
                await markSidecarFinalized(jobId);
            if (response.status === 409) {
                const current = await pipelineRequest(
                    `/v1/jobs/${job.pipelineJobId}`,
                );
                if (!current.ok && current.status === 404) {
                    await markSidecarFinalized(jobId);
                } else if (current.ok) {
                    const state = (await current.json()) as { status?: string };
                    if (
                        ["acknowledged", "cancelled"].includes(
                            state.status ?? "",
                        )
                    ) {
                        await markSidecarFinalized(jobId);
                    }
                }
            }
        } catch {
            // A durable sweeper retries this after the transcript transaction commits.
        }
    }
}

/** @internal Exported so acknowledgement recovery can be exercised after restart. */
export async function reconcilePipelineFinalization(): Promise<void> {
    const pending = await db
        .select({
            id: audioPipelineJobs.id,
            pipelineJobId: audioPipelineJobs.pipelineJobId,
            status: audioPipelineJobs.status,
        })
        .from(audioPipelineJobs)
        .where(
            and(
                inArray(audioPipelineJobs.status, [
                    "completed",
                    "needs_alignment",
                    "superseded",
                ]),
                isNotNull(audioPipelineJobs.pipelineJobId),
                isNull(audioPipelineJobs.sidecarAcknowledgedAt),
            ),
        )
        .orderBy(asc(audioPipelineJobs.updatedAt))
        .limit(4);

    await Promise.all(
        pending.map(async (job) => {
            if (!job.pipelineJobId) return;
            if (job.status === "superseded") {
                const statusResponse = await pipelineRequest(
                    `/v1/jobs/${job.pipelineJobId}`,
                ).catch(() => null);
                if (!statusResponse) return;
                if (statusResponse.status === 404) {
                    await markSidecarFinalized(job.id);
                    return;
                }
                if (!statusResponse.ok) return;
                const state = (await statusResponse.json()) as {
                    status?: string;
                };
                if (
                    ["completed", "needs_alignment"].includes(
                        state.status ?? "",
                    )
                ) {
                    await acknowledgePipelineJob(job.id);
                } else if (
                    ["cancelled", "acknowledged"].includes(state.status ?? "")
                ) {
                    await markSidecarFinalized(job.id);
                } else {
                    await pipelineRequest(
                        `/v1/jobs/${job.pipelineJobId}/cancel`,
                        {
                            method: "POST",
                        },
                    ).catch(() => undefined);
                }
                return;
            }
            await acknowledgePipelineJob(job.id);
        }),
    );
}

async function markSidecarFinalized(jobId: string): Promise<void> {
    await db
        .update(audioPipelineJobs)
        .set({ sidecarAcknowledgedAt: new Date(), updatedAt: new Date() })
        .where(
            and(
                eq(audioPipelineJobs.id, jobId),
                isNull(audioPipelineJobs.sidecarAcknowledgedAt),
            ),
        );
}
