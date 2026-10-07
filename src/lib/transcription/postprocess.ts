import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
    audioPipelineJobs,
    plaudConnections,
    recordings,
    userSettings,
} from "@/db/schema";
import { generateTitleFromTranscription } from "@/lib/ai/generate-title";
import { encryptText } from "@/lib/encryption/fields";
import { createPlaudClient } from "@/lib/plaud/client-factory";

export async function postProcessTranscription(input: {
    userId: string;
    recordingId: string;
    text: string;
    plaudFileId?: string;
    autoGenerateTitle: boolean;
    syncTitleToPlaud: boolean;
    jobId?: string;
    generation?: number;
}): Promise<void> {
    if (!input.autoGenerateTitle || !input.text.trim()) return;
    try {
        const generatedTitle = await generateTitleFromTranscription(
            input.userId,
            input.text,
        );
        if (!generatedTitle) return;

        if (input.jobId && input.generation !== undefined) {
            const [latest] = await db
                .select({ generation: audioPipelineJobs.generation })
                .from(audioPipelineJobs)
                .where(
                    and(
                        eq(audioPipelineJobs.recordingId, input.recordingId),
                        eq(audioPipelineJobs.userId, input.userId),
                    ),
                )
                .orderBy(desc(audioPipelineJobs.generation))
                .limit(1);
            if (latest?.generation !== input.generation) return;
        }

        const [updated] = await db
            .update(recordings)
            .set({
                filename: encryptText(generatedTitle),
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(recordings.id, input.recordingId),
                    eq(recordings.userId, input.userId),
                    isNull(recordings.deletedAt),
                ),
            )
            .returning({ id: recordings.id });
        if (!updated || !input.syncTitleToPlaud || !input.plaudFileId) return;

        try {
            const [connection] = await db
                .select()
                .from(plaudConnections)
                .where(eq(plaudConnections.userId, input.userId))
                .limit(1);
            if (!connection) return;
            const plaudClient = await createPlaudClient(
                connection.bearerToken,
                connection.apiBase,
                connection.workspaceId,
            );
            await plaudClient.updateFilename(input.plaudFileId, generatedTitle);
            const resolved = plaudClient.workspaceId;
            if (resolved && resolved !== connection.workspaceId) {
                await db
                    .update(plaudConnections)
                    .set({ workspaceId: resolved })
                    .where(
                        and(
                            eq(plaudConnections.id, connection.id),
                            eq(plaudConnections.userId, input.userId),
                        ),
                    );
            }
        } catch (error) {
            console.error("Failed to sync title to Plaud:", error);
        }
    } catch (error) {
        console.error("Failed to generate title:", error);
    }
}

export async function postProcessPipelineTranscription(input: {
    userId: string;
    recordingId: string;
    text: string;
    jobId: string;
    generation: number;
}): Promise<void> {
    const [[settings], [recording]] = await Promise.all([
        db
            .select({
                autoGenerateTitle: userSettings.autoGenerateTitle,
                syncTitleToPlaud: userSettings.syncTitleToPlaud,
            })
            .from(userSettings)
            .where(eq(userSettings.userId, input.userId))
            .limit(1),
        db
            .select({ plaudFileId: recordings.plaudFileId })
            .from(recordings)
            .where(
                and(
                    eq(recordings.id, input.recordingId),
                    eq(recordings.userId, input.userId),
                    isNull(recordings.deletedAt),
                ),
            )
            .limit(1),
    ]);
    await postProcessTranscription({
        ...input,
        plaudFileId: recording?.plaudFileId ?? undefined,
        autoGenerateTitle: settings?.autoGenerateTitle ?? true,
        syncTitleToPlaud: settings?.syncTitleToPlaud ?? false,
    });
}
