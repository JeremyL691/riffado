import { and, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { audioPipelineJobs, transcriptions } from "@/db/schema";
import { requireApiSession } from "@/lib/auth-server";
import { decryptJsonField, decryptText } from "@/lib/encryption/fields";
import { apiHandler } from "@/lib/errors";
import {
    cancelAudioPipelineJob,
    retryAudioPipelineJob,
} from "@/lib/transcription/audio-pipeline";

type Context = { params: Promise<{ id: string }> };

export const GET = apiHandler<Context>(async (request, context) => {
    const session = await requireApiSession(request);
    if (!context) throw new Error("Route context is unavailable");
    const { id: recordingId } = await context.params;
    const [job] = await db
        .select()
        .from(audioPipelineJobs)
        .where(
            and(
                eq(audioPipelineJobs.recordingId, recordingId),
                eq(audioPipelineJobs.userId, session.user.id),
            ),
        )
        .orderBy(desc(audioPipelineJobs.generation))
        .limit(1);
    const [transcription] = await db
        .select({
            text: transcriptions.text,
            language: transcriptions.detectedLanguage,
            timeline: transcriptions.timeline,
            timelineSource: transcriptions.timelineSource,
        })
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, recordingId),
                eq(transcriptions.userId, session.user.id),
                eq(transcriptions.source, "riffado"),
            ),
        )
        .limit(1);
    return NextResponse.json({
        job: job
            ? {
                  id: job.id,
                  status: job.status,
                  phase: job.phase,
                  progress: job.progress,
                  errorType: job.errorType,
                  error: job.errorMessage,
                  updatedAt: job.updatedAt,
              }
            : null,
        timeline: decryptJsonField<unknown[]>(transcription?.timeline),
        timestampSource: transcription?.timelineSource ?? null,
        transcription:
            !job || ["completed", "needs_alignment"].includes(job.status)
                ? transcription
                    ? {
                          text: decryptText(transcription.text),
                          language: transcription.language ?? undefined,
                          source: "riffado",
                      }
                    : null
                : null,
    });
});

export const POST = apiHandler<Context>(async (request, context) => {
    const session = await requireApiSession(request);
    if (!context) throw new Error("Route context is unavailable");
    const { id: recordingId } = await context.params;
    const body = (await request.json().catch(() => ({}))) as {
        action?: unknown;
    };
    if (body.action !== "retry" && body.action !== "cancel") {
        return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }
    const [job] = await db
        .select({ id: audioPipelineJobs.id })
        .from(audioPipelineJobs)
        .where(
            and(
                eq(audioPipelineJobs.recordingId, recordingId),
                eq(audioPipelineJobs.userId, session.user.id),
            ),
        )
        .orderBy(desc(audioPipelineJobs.generation))
        .limit(1);
    if (!job)
        return NextResponse.json(
            { error: "Audio job not found" },
            { status: 404 },
        );
    const changed =
        body.action === "retry"
            ? await retryAudioPipelineJob(session.user.id, job.id)
            : await cancelAudioPipelineJob(session.user.id, job.id);
    if (!changed)
        return NextResponse.json(
            { error: "Audio job cannot be changed" },
            { status: 409 },
        );
    return NextResponse.json({
        jobId: job.id,
        status: body.action === "retry" ? "queued" : "cancelled",
    });
});
