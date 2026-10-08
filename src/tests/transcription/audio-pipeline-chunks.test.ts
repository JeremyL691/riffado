import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    style: vi.fn(),
    elevenLabs: vi.fn(),
    gemini: vi.fn(),
    chat: vi.fn(),
    openAITranscribe: vi.fn(),
    openAIConstructed: vi.fn(),
    buildAudioFile: vi.fn(),
    selectedRows: [] as unknown[],
}));

vi.mock("@/db", () => ({
    db: {
        select: vi.fn(() => {
            const row = mocks.selectedRows.shift();
            return {
                from: () => ({
                    where: () => ({
                        limit: async () => (row ? [row] : []),
                    }),
                }),
            };
        }),
    },
}));

vi.mock("@/lib/ai/provider-presets", () => ({
    getTranscriptionStyle: mocks.style,
}));

vi.mock("@/lib/encryption", () => ({
    decrypt: vi.fn(() => "controlled-test-key"),
}));

vi.mock("@/lib/env", () => ({
    env: { IS_HOSTED: false, WHISPER_REQUEST_TIMEOUT_MS: 5000 },
}));

vi.mock("@/lib/transcription/audio-file", () => ({
    buildAudioFile: mocks.buildAudioFile,
}));

vi.mock("@/lib/transcription/audio-pipeline-auth", () => ({
    isAudioPipelineServiceRequest: vi.fn(() => true),
}));

vi.mock("@/lib/transcription/chat-transcribe", () => ({
    chatTranscribe: mocks.chat,
}));

vi.mock("@/lib/transcription/elevenlabs-transcribe", () => ({
    elevenLabsTranscribe: mocks.elevenLabs,
}));

vi.mock("@/lib/transcription/format", () => ({
    buildTranscriptionParams: vi.fn(() => ({
        file: new File(["audio"], "chunk.wav"),
    })),
    getResponseFormat: vi.fn(() => "json"),
}));

vi.mock("@/lib/transcription/gemini-transcribe", () => ({
    geminiTranscribe: mocks.gemini,
}));

vi.mock("openai", () => ({
    OpenAI: vi.fn(function (this: unknown, ...args: unknown[]) {
        mocks.openAIConstructed(...args);
        return {
            audio: {
                transcriptions: { create: mocks.openAITranscribe },
            },
        };
    }),
}));

import { POST } from "@/app/api/internal/audio-pipeline/jobs/[id]/chunks/route";

const bytes = Buffer.from("controlled audio bytes");
const digest = createHash("sha256").update(bytes).digest("hex");

function mockRows(configSnapshot: Record<string, unknown> = {}) {
    mocks.selectedRows.push(
        {
            id: "job-1",
            userId: "user-1",
            recordingId: "recording-1",
            providerId: "credential-1",
            provider: "test-provider",
            model: "test-model",
            language: "en",
            status: "running",
            configSnapshot,
        },
        { deletedAt: null },
        {
            provider: "test-provider",
            apiKey: "encrypted-key",
            baseUrl: "https://provider.invalid/v1",
        },
    );
}

async function postChunk() {
    const form = new FormData();
    form.set("file", new File([bytes], "chunk.wav", { type: "audio/wav" }));
    form.set("chunk_id", "chunk-id");
    form.set("chunk_index", "4");
    form.set("start_sample", "16000");
    form.set("end_sample", "32000");
    form.set("content_sha256", digest);
    return POST(
        new Request("http://riffado.test", { method: "POST", body: form }),
        {
            params: Promise.resolve({ id: "job-1" }),
        },
    );
}

describe("audio-pipeline chunk provider bridge", () => {
    beforeEach(() => {
        mocks.selectedRows.length = 0;
        vi.clearAllMocks();
        mocks.buildAudioFile.mockImplementation(
            (buffer: Buffer, filename: string) => ({
                file: new File([Uint8Array.from(buffer)], filename, {
                    type: "audio/wav",
                }),
                contentType: "audio/wav",
            }),
        );
    });

    it("routes ElevenLabs chunks through its client with the snapshotted diarization settings", async () => {
        mockRows({ speaker_diarization: true, diarization_speaker_count: 3 });
        mocks.style.mockReturnValue("elevenlabs");
        mocks.elevenLabs.mockResolvedValue({
            text: "Speaker 1: hello",
            detectedLanguage: "en",
            segments: [
                {
                    start: 0.2,
                    end: 0.7,
                    text: "hello",
                    speaker_id: "speaker_0",
                },
            ],
        });

        const response = await postChunk();

        expect(response.status).toBe(200);
        expect(mocks.elevenLabs).toHaveBeenCalledWith(
            expect.objectContaining({
                apiKey: "controlled-test-key",
                model: "test-model",
                diarize: true,
                numSpeakers: 3,
                baseUrl: "https://provider.invalid/v1",
                isHosted: false,
            }),
        );
        expect(mocks.openAIConstructed).not.toHaveBeenCalled();
        expect(await response.json()).toMatchObject({
            text: "Speaker 1: hello",
            segments: [
                {
                    start: 0.2,
                    end: 0.7,
                    text: "hello",
                    speaker_id: "speaker_0",
                },
            ],
            raw_timestamp_capability: "native",
        });
    });

    it("defaults old ElevenLabs snapshots to diarization without a speaker hint", async () => {
        mockRows({});
        mocks.style.mockReturnValue("elevenlabs");
        mocks.elevenLabs.mockResolvedValue({
            text: "hello",
            detectedLanguage: null,
        });

        const response = await postChunk();

        expect(response.status).toBe(200);
        expect(mocks.elevenLabs).toHaveBeenCalledWith(
            expect.objectContaining({ diarize: true }),
        );
        expect(mocks.elevenLabs.mock.calls[0][0]).not.toHaveProperty(
            "numSpeakers",
        );
        expect((await response.json()).segments).toBeNull();
    });

    it.each([
        ["gemini", "gemini text"],
        ["chat", "chat text"],
        ["openai", "openai text"],
    ])("keeps the %s bridge on its existing request path", async (style, text) => {
        mockRows({});
        mocks.style.mockReturnValue(style);
        mocks.gemini.mockResolvedValue({ text, detectedLanguage: "en" });
        mocks.chat.mockResolvedValue({ text, detectedLanguage: "en" });
        mocks.openAITranscribe.mockResolvedValue({ text, language: "en" });

        const response = await postChunk();

        expect(response.status).toBe(200);
        expect((await response.json()).text).toBe(text);
        if (style === "gemini") expect(mocks.gemini).toHaveBeenCalledOnce();
        if (style === "chat") expect(mocks.chat).toHaveBeenCalledOnce();
        if (style === "openai")
            expect(mocks.openAITranscribe).toHaveBeenCalledOnce();
        expect(mocks.elevenLabs).not.toHaveBeenCalled();
    });
});
