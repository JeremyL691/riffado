import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { OpenAI } from "openai";
import { db } from "@/db";
import { apiCredentials, audioPipelineJobs, recordings } from "@/db/schema";
import { getTranscriptionStyle } from "@/lib/ai/provider-presets";
import { decrypt } from "@/lib/encryption";
import { env } from "@/lib/env";
import { buildAudioFile } from "@/lib/transcription/audio-file";
import { isAudioPipelineServiceRequest } from "@/lib/transcription/audio-pipeline-auth";
import { chatTranscribe } from "@/lib/transcription/chat-transcribe";
import { elevenLabsTranscribe } from "@/lib/transcription/elevenlabs-transcribe";
import {
    buildTranscriptionParams,
    getResponseFormat,
} from "@/lib/transcription/format";
import { geminiTranscribe } from "@/lib/transcription/gemini-transcribe";

type Context = { params: Promise<{ id: string }> };

export async function POST(
    request: Request,
    context: Context,
): Promise<Response> {
    if (!isAudioPipelineServiceRequest(request)) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { id } = await context.params;
    const [job] = await db
        .select()
        .from(audioPipelineJobs)
        .where(
            and(
                eq(audioPipelineJobs.id, id),
                // User-scoped provider lookup below is derived from this job.
                // Never accept userId or credentials from the pipeline body.
            ),
        )
        .limit(1);
    if (
        !job ||
        !["queued", "submitted", "running", "paused"].includes(job.status)
    ) {
        return Response.json(
            { error: "Audio job is unavailable" },
            { status: 404 },
        );
    }
    const [recording] = await db
        .select({ deletedAt: recordings.deletedAt })
        .from(recordings)
        .where(
            and(
                eq(recordings.id, job.recordingId),
                eq(recordings.userId, job.userId),
                isNull(recordings.deletedAt),
            ),
        )
        .limit(1);
    if (!recording)
        return Response.json(
            { error: "Recording was deleted" },
            { status: 410 },
        );

    const form = await request.formData();
    const file = form.get("file");
    const chunkId = form.get("chunk_id");
    const startSample = Number(form.get("start_sample"));
    const endSample = Number(form.get("end_sample"));
    const expectedHash = form.get("content_sha256");
    if (
        !(file instanceof File) ||
        typeof chunkId !== "string" ||
        !Number.isSafeInteger(startSample) ||
        !Number.isSafeInteger(endSample) ||
        startSample < 0 ||
        endSample <= startSample ||
        typeof expectedHash !== "string"
    ) {
        return Response.json(
            { error: "Invalid chunk request" },
            { status: 400 },
        );
    }
    if (
        endSample - startSample > 170 * 16_000 ||
        file.size > 50 * 1024 * 1024
    ) {
        return Response.json(
            { error: "Chunk exceeds provider limits" },
            { status: 413 },
        );
    }

    const audioBuffer = Buffer.from(await file.arrayBuffer());
    const actualHash = createHash("sha256").update(audioBuffer).digest("hex");
    if (
        !/^[a-f0-9]{64}$/i.test(expectedHash) ||
        !chunkId ||
        actualHash !== expectedHash
    ) {
        return Response.json(
            { error: "Invalid chunk identity" },
            { status: 400 },
        );
    }

    const [credentials] = job.providerId
        ? await db
              .select()
              .from(apiCredentials)
              .where(
                  and(
                      eq(apiCredentials.id, job.providerId),
                      eq(apiCredentials.userId, job.userId),
                  ),
              )
              .limit(1)
        : [];
    if (!credentials)
        return Response.json(
            { error: "Configured transcription provider was removed" },
            { status: 409 },
        );

    try {
        const filename = `chunk-${String(form.get("chunk_index") ?? "audio")}.wav`;
        const { file: audioFile, contentType } = buildAudioFile(
            audioBuffer,
            filename,
            filename,
        );
        const language = job.language ?? undefined;
        const style = getTranscriptionStyle(credentials.provider);
        const apiKey = decrypt(credentials.apiKey);

        if (style === "elevenlabs") {
            const snapshot =
                job.configSnapshot &&
                typeof job.configSnapshot === "object" &&
                !Array.isArray(job.configSnapshot)
                    ? (job.configSnapshot as Record<string, unknown>)
                    : {};
            const speakerDiarization =
                typeof snapshot.speaker_diarization === "boolean"
                    ? snapshot.speaker_diarization
                    : true;
            const speakerCount = snapshot.diarization_speaker_count;
            const result = await elevenLabsTranscribe({
                apiKey,
                model: job.model,
                file: audioFile,
                baseUrl: credentials.baseUrl,
                isHosted: env.IS_HOSTED,
                language,
                diarize: speakerDiarization,
                ...(speakerDiarization &&
                typeof speakerCount === "number" &&
                Number.isInteger(speakerCount) &&
                speakerCount >= 1 &&
                speakerCount <= 32
                    ? { numSpeakers: speakerCount }
                    : {}),
                timeoutMs: env.WHISPER_REQUEST_TIMEOUT_MS,
            });
            const segments = normalizeNativeSegments(result.segments);
            return Response.json({
                text: result.text,
                language: result.detectedLanguage,
                segments,
                raw_timestamp_capability: segments ? "native" : "none",
            });
        }

        if (style === "gemini") {
            const result = await geminiTranscribe({
                apiKey,
                model: job.model,
                audioBuffer,
                contentType,
                language,
            });
            return Response.json({
                text: result.text,
                language: result.detectedLanguage,
                segments: null,
                raw_timestamp_capability: "none",
            });
        }

        const client = new OpenAI({
            apiKey,
            baseURL: credentials.baseUrl || undefined,
        });
        if (style === "chat") {
            const result = await chatTranscribe({
                client,
                model: job.model,
                audioBuffer,
                contentType,
                language,
            });
            return Response.json({
                text: result.text,
                language: result.detectedLanguage,
                segments: null,
                raw_timestamp_capability: "none",
            });
        }

        const responseFormat = getResponseFormat(job.model);
        const params = buildTranscriptionParams({
            file: audioFile,
            model: job.model,
            responseFormat,
            language,
        });
        const transcription = await client.audio.transcriptions.create(
            responseFormat === "verbose_json"
                ? { ...params, timestamp_granularities: ["segment"] }
                : params,
            { timeout: env.WHISPER_REQUEST_TIMEOUT_MS },
        );
        const raw = transcription as unknown as {
            text?: unknown;
            language?: unknown;
            segments?: unknown;
        };
        const text =
            typeof transcription === "string"
                ? transcription
                : typeof raw.text === "string"
                  ? raw.text
                  : "";
        const segments = normalizeNativeSegments(raw.segments);
        return Response.json({
            text,
            language: typeof raw.language === "string" ? raw.language : null,
            segments,
            raw_timestamp_capability: segments ? "native" : "none",
        });
    } catch (error) {
        const status =
            error &&
            typeof error === "object" &&
            "status" in error &&
            typeof (error as { status?: unknown }).status === "number"
                ? (error as { status: number }).status
                : 502;
        const safeStatus = status >= 400 && status <= 599 ? status : 502;
        return Response.json(
            {
                error: `Configured transcription provider returned HTTP ${safeStatus}`,
            },
            { status: safeStatus },
        );
    }
}

function normalizeNativeSegments(
    value: unknown,
): Array<{ start: number; end: number; text: string }> | null {
    if (!Array.isArray(value) || value.length === 0) return null;
    const segments = [];
    for (const item of value) {
        if (!item || typeof item !== "object") return null;
        const segment = item as {
            start?: unknown;
            end?: unknown;
            text?: unknown;
            speaker_id?: unknown;
        };
        if (
            typeof segment.start !== "number" ||
            typeof segment.end !== "number" ||
            typeof segment.text !== "string"
        )
            return null;
        segments.push({
            start: segment.start,
            end: segment.end,
            text: segment.text,
            ...(typeof segment.speaker_id === "string"
                ? { speaker_id: segment.speaker_id }
                : {}),
        });
    }
    return segments;
}
