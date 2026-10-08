import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { audioPipelineJobs, recordings, transcriptions } from "@/db/schema";
import {
    decryptJsonField,
    decryptText,
    encryptJsonField,
} from "@/lib/encryption/fields";
import { isAudioPipelineServiceRequest } from "@/lib/transcription/audio-pipeline-auth";
import { isRepairResult } from "@/lib/transcription/audio-pipeline-repair";

function textHash(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function POST(request: Request): Promise<Response> {
    if (!isAudioPipelineServiceRequest(request)) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: {
        action?: unknown;
        job_id?: unknown;
        generation?: unknown;
        expected_text_sha256?: unknown;
        result?: unknown;
    };
    try {
        body = (await request.json()) as typeof body;
    } catch {
        return Response.json(
            { error: "Invalid repair request" },
            { status: 400 },
        );
    }
    if (
        !["preview", "apply"].includes(String(body.action)) ||
        typeof body.job_id !== "string" ||
        body.job_id.length < 1 ||
        body.job_id.length > 128 ||
        typeof body.expected_text_sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(body.expected_text_sha256) ||
        !isRepairResult(body.result) ||
        textHash(body.result.text) !== body.expected_text_sha256 ||
        (body.action === "apply" &&
            (!Number.isSafeInteger(body.generation) ||
                (body.generation as number) < 1))
    ) {
        return Response.json(
            { error: "Invalid repair request" },
            { status: 400 },
        );
    }
    const result = body.result;

    const [reference] = await db
        .select({
            id: audioPipelineJobs.id,
            userId: audioPipelineJobs.userId,
            recordingId: audioPipelineJobs.recordingId,
        })
        .from(audioPipelineJobs)
        .where(eq(audioPipelineJobs.id, body.job_id))
        .limit(1);
    if (!reference) {
        return Response.json(
            { error: "Pipeline job not found" },
            { status: 404 },
        );
    }

    try {
        const outcome = await db.transaction(async (tx) => {
            const [recording] = await tx
                .select({ id: recordings.id, deletedAt: recordings.deletedAt })
                .from(recordings)
                .where(
                    and(
                        eq(recordings.id, reference.recordingId),
                        eq(recordings.userId, reference.userId),
                    ),
                )
                .for("update")
                .limit(1);
            if (!recording || recording.deletedAt) {
                return {
                    error: "Recording is missing or deleted",
                    status: 409,
                } as const;
            }

            const [latest] = await tx
                .select()
                .from(audioPipelineJobs)
                .where(
                    and(
                        eq(audioPipelineJobs.recordingId, recording.id),
                        eq(audioPipelineJobs.userId, reference.userId),
                    ),
                )
                .orderBy(desc(audioPipelineJobs.generation))
                .limit(1)
                .for("update");
            if (!latest || latest.id !== reference.id) {
                return {
                    error: "A newer transcription generation exists",
                    status: 409,
                } as const;
            }
            if (
                body.action === "apply" &&
                latest.generation !== body.generation
            ) {
                return {
                    error: "Repair plan generation is stale",
                    status: 409,
                } as const;
            }

            const [activeJob] = await tx
                .select({ id: audioPipelineJobs.id })
                .from(audioPipelineJobs)
                .where(
                    and(
                        eq(audioPipelineJobs.recordingId, recording.id),
                        eq(audioPipelineJobs.userId, reference.userId),
                        inArray(audioPipelineJobs.status, [
                            "queued",
                            "submitted",
                            "running",
                            "paused",
                        ]),
                    ),
                )
                .limit(1);
            if (activeJob) {
                return {
                    error: "An audio pipeline job is active",
                    status: 409,
                } as const;
            }

            const [transcription] = await tx
                .select()
                .from(transcriptions)
                .where(
                    and(
                        eq(transcriptions.recordingId, recording.id),
                        eq(transcriptions.userId, reference.userId),
                        eq(transcriptions.source, "riffado"),
                    ),
                )
                .for("update")
                .limit(1);
            if (
                !transcription ||
                textHash(decryptText(transcription.text)) !==
                    body.expected_text_sha256
            ) {
                return {
                    error: "Current transcript no longer matches the repair plan",
                    status: 409,
                } as const;
            }

            if (latest.status === "completed") {
                const currentTimeline = decryptJsonField<unknown[]>(
                    transcription.timeline,
                );
                const matches =
                    transcription.timelineSource === result.timestamp_source &&
                    JSON.stringify(currentTimeline) ===
                        JSON.stringify(result.timeline);
                if (matches) {
                    return {
                        applied: true,
                        already_applied: true,
                        generation: latest.generation,
                    } as const;
                }
            }
            if (
                latest.status !== "needs_alignment" ||
                latest.sidecarAcknowledgedAt === null
            ) {
                return {
                    error: "Pipeline job is not an acknowledged alignment result",
                    status: 409,
                } as const;
            }
            if (body.action === "preview") {
                return {
                    preview: true,
                    generation: latest.generation,
                    segment_count: result.timeline.length,
                    timestamp_source: result.timestamp_source,
                    text_sha256: body.expected_text_sha256,
                } as const;
            }

            const now = new Date();
            await tx
                .update(transcriptions)
                .set({
                    timeline: encryptJsonField(result.timeline),
                    timelineSource: result.timestamp_source,
                })
                .where(
                    and(
                        eq(transcriptions.id, transcription.id),
                        eq(transcriptions.userId, reference.userId),
                    ),
                );
            await tx
                .update(audioPipelineJobs)
                .set({
                    status: "completed",
                    phase: "completed",
                    progress: 1,
                    timestampSource: result.timestamp_source,
                    configSnapshot: {
                        ...((latest.configSnapshot &&
                        typeof latest.configSnapshot === "object" &&
                        !Array.isArray(latest.configSnapshot)
                            ? latest.configSnapshot
                            : {}) as Record<string, unknown>),
                        timestamp_policy: result.metadata.timestamp_policy,
                    },
                    errorType: null,
                    errorMessage: null,
                    completedAt: now,
                    updatedAt: now,
                })
                .where(
                    and(
                        eq(audioPipelineJobs.id, latest.id),
                        eq(audioPipelineJobs.userId, reference.userId),
                        eq(audioPipelineJobs.generation, latest.generation),
                    ),
                );
            return {
                applied: true,
                already_applied: false,
                generation: latest.generation,
            } as const;
        });

        if ("error" in outcome) {
            return Response.json(
                { error: outcome.error },
                { status: outcome.status },
            );
        }
        return Response.json(outcome);
    } catch {
        return Response.json(
            { error: "Timeline repair failed" },
            { status: 500 },
        );
    }
}
