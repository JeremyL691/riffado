import { Readable } from "node:stream";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { audioPipelineJobs, recordings } from "@/db/schema";
import { createUserStorageProvider } from "@/lib/storage/factory";
import { isAudioPipelineServiceRequest } from "@/lib/transcription/audio-pipeline-auth";

type Context = { params: Promise<{ id: string }> };

export async function GET(
    request: Request,
    context: Context,
): Promise<Response> {
    if (!isAudioPipelineServiceRequest(request)) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { id } = await context.params;
    const [row] = await db
        .select({
            userId: audioPipelineJobs.userId,
            storagePath: recordings.storagePath,
            duration: recordings.duration,
        })
        .from(audioPipelineJobs)
        .innerJoin(recordings, eq(recordings.id, audioPipelineJobs.recordingId))
        .where(
            and(
                eq(audioPipelineJobs.id, id),
                eq(recordings.userId, audioPipelineJobs.userId),
                isNull(recordings.deletedAt),
                inArray(audioPipelineJobs.status, [
                    "queued",
                    "submitted",
                    "running",
                    "paused",
                ]),
            ),
        )
        .limit(1);
    if (!row)
        return Response.json(
            { error: "Audio job is unavailable" },
            { status: 404 },
        );

    try {
        const storage = await createUserStorageProvider(row.userId);
        const stream = await storage.downloadStream(row.storagePath);
        const headers = new Headers({
            "Content-Type": "application/octet-stream",
            "Cache-Control": "no-store",
            "X-Audio-Duration-Ms": String(row.duration ?? 0),
        });
        return new Response(Readable.toWeb(stream) as ReadableStream, {
            headers,
        });
    } catch (error) {
        console.error("[audio-pipeline] failed to stream source audio:", error);
        return Response.json(
            { error: "Could not read source audio" },
            { status: 502 },
        );
    }
}
