"use client";

import {
    ChevronDown,
    ChevronUp,
    FileText,
    Languages,
    ListChecks,
    Loader2,
    RefreshCw,
    Sparkles,
    Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { TranscribeInBrowserButton } from "@/components/dashboard/transcribe-in-browser-button";
import {
    RichMarkdown,
    SpeakerTranscript,
} from "@/components/recordings/rich-content";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { useTranscriptionSummary } from "@/hooks/use-transcription-summary";
import type { Recording } from "@/types/recording";

interface Transcription {
    text?: string;
    language?: string;
}

/** A transcript variant for a single source (Plaud, the user's own, etc.). */
export interface TranscriptOption {
    source: string;
    text: string;
    language?: string;
    provider?: string;
    model?: string;
}

interface TranscriptionPanelProps {
    recording: Recording;
    /** Back-compat single transcript. Used only when `transcripts` is absent. */
    transcription?: Transcription;
    /** All transcripts for the recording, one per source, primary first. When
     * more than one is present a source switcher is shown. */
    transcripts?: TranscriptOption[];
    isTranscribing: boolean;
    onTranscribe: () => void;
    /** Refresh handler called after a browser-side transcription completes. */
    onTranscribeComplete?: () => void;
    onSeekTimestamp?: (milliseconds: number) => void;
    playbackTimeMs?: number;
}

interface TimelineSegment {
    start_ms: number;
    end_ms: number;
    text: string;
}

interface PipelineState {
    job: {
        id: string;
        status: string;
        phase: string;
        progress: number;
        errorType: string | null;
        error: string | null;
        updatedAt: string;
    } | null;
    timeline: TimelineSegment[] | null;
    timestampSource: string | null;
    transcription: { text: string; language?: string; source: string } | null;
}

function transcriptSourceLabel(source: string): string {
    if (source === "plaud") return "Plaud";
    if (source === "mixed") return "Mix";
    return "Your provider";
}

export function TranscriptionPanel({
    recording,
    transcription,
    transcripts,
    isTranscribing,
    onTranscribe,
    onTranscribeComplete,
    onSeekTimestamp,
    playbackTimeMs,
}: TranscriptionPanelProps) {
    const [pipelineState, setPipelineState] = useState<PipelineState | null>(
        null,
    );
    const observedActiveJobs = useRef(new Set<string>());
    const suppliedTranscriptList: TranscriptOption[] =
        transcripts && transcripts.length > 0
            ? transcripts
            : transcription?.text
              ? [
                    {
                        source: "riffado",
                        text: transcription.text,
                        language: transcription.language,
                    },
                ]
              : [];
    const pipelineTranscriptReady = ["completed", "needs_alignment"].includes(
        pipelineState?.job?.status ?? "",
    )
        ? (pipelineState?.transcription ?? null)
        : null;
    const transcriptList: TranscriptOption[] = pipelineTranscriptReady
        ? [
              ...suppliedTranscriptList.filter((t) => t.source !== "riffado"),
              pipelineTranscriptReady,
          ]
        : suppliedTranscriptList;

    const [activeSource, setActiveSource] = useState<string | undefined>(
        undefined,
    );
    const activeTranscript =
        transcriptList.find((t) => t.source === activeSource) ??
        transcriptList[0];
    const [pipelineBusy, setPipelineBusy] = useState(false);

    useEffect(() => {
        if (pipelineTranscriptReady?.text.trim()) {
            setActiveSource((current) => current ?? "riffado");
        }
    }, [pipelineTranscriptReady?.text]);

    const refreshPipelineState = useCallback(
        async (signal?: AbortSignal): Promise<PipelineState | null> => {
            try {
                const response = await fetch(
                    `/api/recordings/${recording.id}/audio-pipeline`,
                    { signal },
                );
                if (!response.ok) return null;
                const state = (await response.json()) as PipelineState;
                setPipelineState(state);
                return state;
            } catch {
                return null;
            }
        },
        [recording.id],
    );

    useEffect(() => {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let active = true;
        const poll = async () => {
            const state = await refreshPipelineState(controller.signal);
            if (!active || controller.signal.aborted) return;
            const job = state?.job;
            if (
                job &&
                ["queued", "submitted", "running", "paused"].includes(
                    job.status,
                )
            ) {
                observedActiveJobs.current.add(job.id);
            }
            if (
                job &&
                [
                    "completed",
                    "needs_alignment",
                    "failed",
                    "cancelled",
                ].includes(job.status)
            ) {
                const wasActive = observedActiveJobs.current.delete(job.id);
                if (
                    wasActive &&
                    ["completed", "needs_alignment"].includes(job.status)
                ) {
                    if (state?.transcription?.text.trim())
                        setActiveSource("riffado");
                    onTranscribeComplete?.();
                }
            }
            timer = setTimeout(
                poll,
                job &&
                    ["queued", "submitted", "running", "paused"].includes(
                        job.status,
                    )
                    ? 2_000
                    : isTranscribing
                      ? 500
                      : 5_000,
            );
        };
        void poll();
        return () => {
            active = false;
            controller.abort();
            if (timer) clearTimeout(timer);
        };
    }, [refreshPipelineState, isTranscribing, onTranscribeComplete]);

    const activeJob = pipelineState?.job;
    const isPipelineRunning =
        activeJob &&
        ["queued", "submitted", "running"].includes(activeJob.status);
    const isPipelineActive =
        isPipelineRunning || activeJob?.status === "paused";
    const timeline =
        activeTranscript?.source === "riffado" ? pipelineState?.timeline : null;

    const performPipelineAction = async (action: "retry" | "cancel") => {
        if (pipelineBusy) return;
        setPipelineBusy(true);
        try {
            const response = await fetch(
                `/api/recordings/${recording.id}/audio-pipeline`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action }),
                },
            );
            if (!response.ok) {
                toast.error(
                    action === "retry"
                        ? "Could not retry transcription"
                        : "Could not cancel transcription",
                );
                return;
            }
            toast.success(
                action === "retry" ? "Retry queued" : "Transcription cancelled",
            );
            await refreshPipelineState();
        } catch {
            toast.error(
                action === "retry"
                    ? "Could not retry transcription"
                    : "Could not cancel transcription",
            );
        } finally {
            setPipelineBusy(false);
        }
    };

    const {
        summaryData,
        isSummarizing,
        summaryExpanded,
        setSummaryExpanded,
        summaryPreset,
        setSummaryPreset,
        summaryPromptOptions,
        handleSummarize,
        handleDeleteSummary,
    } = useTranscriptionSummary({
        recordingId: recording?.id,
        transcriptionText: activeTranscript?.text,
    });

    return (
        <div className="space-y-4">
            {/* Transcription Card */}
            <Card>
                <CardHeader>
                    <div className="flex items-center justify-between">
                        <CardTitle className="flex items-center gap-2">
                            <FileText className="size-5" />
                            Transcription
                        </CardTitle>
                        <div className="flex items-center gap-2">
                            {activeTranscript?.text && (
                                <Button
                                    onClick={onTranscribe}
                                    size="sm"
                                    variant="outline"
                                    disabled={
                                        isTranscribing ||
                                        Boolean(isPipelineActive)
                                    }
                                >
                                    <RefreshCw className="size-4 mr-2" />
                                    Re-transcribe
                                </Button>
                            )}
                            {!activeTranscript?.text && !isTranscribing && (
                                <>
                                    <Button
                                        onClick={onTranscribe}
                                        size="sm"
                                        disabled={
                                            isTranscribing ||
                                            Boolean(isPipelineActive)
                                        }
                                    >
                                        <Sparkles className="size-4 mr-2" />
                                        Transcribe
                                    </Button>
                                    <TranscribeInBrowserButton
                                        recordingId={recording.id}
                                        disabled={isTranscribing}
                                        onComplete={
                                            // Falling back to `onTranscribe` here
                                            // would kick off a redundant SERVER
                                            // transcription right after a
                                            // successful browser one, possibly
                                            // overwriting it. Callers that care
                                            // about refreshing after a browser
                                            // transcription must pass
                                            // `onTranscribeComplete` explicitly.
                                            onTranscribeComplete ?? (() => {})
                                        }
                                    />
                                </>
                            )}
                        </div>
                    </div>
                </CardHeader>
                <CardContent>
                    {isTranscribing && !activeTranscript?.text ? (
                        <div className="flex flex-col items-center justify-center py-12">
                            <div className="animate-spin size-8 border-2 border-primary border-t-transparent rounded-full mb-4" />
                            <p className="text-sm text-muted-foreground">
                                Transcribing audio…
                            </p>
                        </div>
                    ) : activeTranscript?.text ? (
                        <div className="space-y-4">
                            {isTranscribing || isPipelineRunning ? (
                                <div
                                    className="space-y-2 rounded-md border p-3"
                                    aria-live="polite"
                                >
                                    <div className="flex items-center justify-between gap-3">
                                        <p className="text-sm font-medium">
                                            {isTranscribing
                                                ? "Queueing transcription…"
                                                : pipelinePhaseLabel(
                                                      activeJob?.phase ??
                                                          "queued",
                                                  )}
                                        </p>
                                        {isPipelineRunning && (
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                disabled={pipelineBusy}
                                                onClick={() =>
                                                    void performPipelineAction(
                                                        "cancel",
                                                    )
                                                }
                                            >
                                                Cancel
                                            </Button>
                                        )}
                                    </div>
                                    {isPipelineRunning && (
                                        <progress
                                            className="h-2 w-full accent-primary"
                                            max={1}
                                            value={Math.max(
                                                0,
                                                Math.min(
                                                    1,
                                                    activeJob?.progress ?? 0,
                                                ),
                                            )}
                                            aria-label="Audio preprocessing progress"
                                        />
                                    )}
                                </div>
                            ) : null}
                            {activeJob?.status === "failed" && (
                                <div
                                    className="flex flex-col gap-3 rounded-md border border-destructive/40 p-3 sm:flex-row sm:items-center sm:justify-between"
                                    role="alert"
                                >
                                    <div>
                                        <p className="text-sm font-medium">
                                            Transcription failed
                                        </p>
                                        {activeJob.error && (
                                            <p className="text-sm text-muted-foreground">
                                                {activeJob.error}
                                            </p>
                                        )}
                                    </div>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={pipelineBusy}
                                        onClick={() =>
                                            void performPipelineAction("retry")
                                        }
                                    >
                                        Retry
                                    </Button>
                                </div>
                            )}
                            {activeJob?.status === "needs_alignment" && (
                                <p
                                    className="rounded-md border p-3 text-sm"
                                    aria-live="polite"
                                >
                                    Transcript saved. The provider returned no
                                    validated timestamps, so playback
                                    positioning is unavailable.
                                </p>
                            )}
                            {activeJob?.status === "paused" && (
                                <div
                                    className="flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
                                    aria-live="polite"
                                >
                                    <p className="text-sm">
                                        Paused because the pipeline needs more
                                        disk space. It will resume automatically
                                        when space is available.
                                    </p>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={pipelineBusy}
                                        onClick={() =>
                                            void performPipelineAction("cancel")
                                        }
                                    >
                                        Cancel
                                    </Button>
                                </div>
                            )}
                            {transcriptList.length > 1 && (
                                <div className="flex items-center gap-2 border-b pb-2">
                                    {transcriptList.map((t) => (
                                        <button
                                            key={t.source}
                                            type="button"
                                            onClick={() =>
                                                setActiveSource(t.source)
                                            }
                                            className={`px-3 py-1 text-xs rounded-md transition-colors ${
                                                t.source ===
                                                activeTranscript.source
                                                    ? "bg-primary text-primary-foreground"
                                                    : "bg-muted text-muted-foreground hover:text-foreground"
                                            }`}
                                        >
                                            {transcriptSourceLabel(t.source)}
                                        </button>
                                    ))}
                                </div>
                            )}
                            <div className="bg-muted rounded-lg p-4 max-h-96 overflow-y-auto">
                                {timeline?.length ? (
                                    <ol className="space-y-1">
                                        {timeline.map((segment, index) => {
                                            const isActive =
                                                playbackTimeMs !== undefined &&
                                                playbackTimeMs >=
                                                    segment.start_ms &&
                                                playbackTimeMs < segment.end_ms;
                                            return (
                                                <li
                                                    key={`${segment.start_ms}-${index}`}
                                                >
                                                    <button
                                                        type="button"
                                                        disabled={
                                                            !onSeekTimestamp
                                                        }
                                                        aria-current={
                                                            isActive
                                                                ? "time"
                                                                : undefined
                                                        }
                                                        onClick={() => {
                                                            onSeekTimestamp?.(
                                                                segment.start_ms,
                                                            );
                                                        }}
                                                        className={`w-full rounded px-2 py-1 text-left text-sm leading-relaxed hover:bg-background/70 disabled:cursor-default ${isActive ? "bg-background font-medium" : ""}`}
                                                    >
                                                        <span className="mr-2 font-mono text-xs text-muted-foreground">
                                                            {formatTimestamp(
                                                                segment.start_ms,
                                                            )}
                                                        </span>
                                                        {segment.text}
                                                    </button>
                                                </li>
                                            );
                                        })}
                                    </ol>
                                ) : (
                                    <SpeakerTranscript
                                        text={activeTranscript.text}
                                        className="text-sm"
                                    />
                                )}
                            </div>
                            <div className="flex items-center gap-4 text-xs text-muted-foreground pt-2 border-t">
                                <span className="px-2 py-0.5 rounded bg-muted font-medium">
                                    {transcriptSourceLabel(
                                        activeTranscript.source,
                                    )}
                                </span>
                                {activeTranscript.language && (
                                    <div className="flex items-center gap-1">
                                        <Languages className="size-3" />
                                        <span>
                                            Language:{" "}
                                            {activeTranscript.language}
                                        </span>
                                    </div>
                                )}
                                <div>
                                    {activeTranscript.text.trim()
                                        ? activeTranscript.text
                                              .trim()
                                              .split(/\s+/).length
                                        : 0}{" "}
                                    words
                                </div>
                                <div>
                                    {activeTranscript.text.length} characters
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className="flex flex-col items-center justify-center py-10 text-center">
                            {isPipelineRunning ? (
                                <div className="w-full max-w-md space-y-3 rounded-md border p-4 text-left">
                                    <div className="flex items-center justify-between gap-3">
                                        <p className="text-sm font-medium">
                                            {pipelinePhaseLabel(
                                                activeJob?.phase ?? "queued",
                                            )}
                                        </p>
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            disabled={pipelineBusy}
                                            onClick={() =>
                                                void performPipelineAction(
                                                    "cancel",
                                                )
                                            }
                                        >
                                            Cancel
                                        </Button>
                                    </div>
                                    <progress
                                        className="h-2 w-full accent-primary"
                                        max={1}
                                        value={Math.max(
                                            0,
                                            Math.min(
                                                1,
                                                activeJob?.progress ?? 0,
                                            ),
                                        )}
                                        aria-label="Audio preprocessing progress"
                                    />
                                </div>
                            ) : activeJob?.status === "paused" ? (
                                <div
                                    className="flex flex-col gap-3 rounded-md border p-4 text-left sm:flex-row sm:items-center sm:justify-between"
                                    aria-live="polite"
                                >
                                    <p className="text-sm">
                                        Paused because the pipeline needs more
                                        disk space. It will resume automatically
                                        when space is available.
                                    </p>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={pipelineBusy}
                                        onClick={() =>
                                            void performPipelineAction("cancel")
                                        }
                                    >
                                        Cancel
                                    </Button>
                                </div>
                            ) : activeJob?.status === "failed" ? (
                                <div className="space-y-3" role="alert">
                                    <FileText className="mx-auto size-10 text-muted-foreground" />
                                    <p className="text-sm font-medium">
                                        Transcription failed
                                    </p>
                                    {activeJob.error && (
                                        <p className="text-sm text-muted-foreground">
                                            {activeJob.error}
                                        </p>
                                    )}
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={pipelineBusy}
                                        onClick={() =>
                                            void performPipelineAction("retry")
                                        }
                                    >
                                        Retry
                                    </Button>
                                </div>
                            ) : (
                                <>
                                    <FileText className="size-10 text-muted-foreground mb-3" />
                                    <p className="text-sm text-muted-foreground">
                                        No transcription yet. Use the Transcribe
                                        button above.
                                    </p>
                                </>
                            )}
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* Summary Card -- only show when a transcript exists */}
            {activeTranscript?.text && (
                <Card>
                    <CardHeader>
                        <div className="flex items-center justify-between">
                            <CardTitle className="flex items-center gap-2">
                                <ListChecks className="size-5" />
                                Summary
                            </CardTitle>
                            <div className="flex items-center gap-2">
                                {!isSummarizing && (
                                    <Select
                                        value={summaryPreset}
                                        onValueChange={setSummaryPreset}
                                    >
                                        <SelectTrigger className="w-[160px] h-8 text-xs">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {summaryPromptOptions.map(
                                                (preset) => (
                                                    <SelectItem
                                                        key={preset.id}
                                                        value={preset.id}
                                                    >
                                                        {preset.name}
                                                    </SelectItem>
                                                ),
                                            )}
                                        </SelectContent>
                                    </Select>
                                )}
                                <Button
                                    onClick={handleSummarize}
                                    size="sm"
                                    variant={
                                        summaryData ? "outline" : "default"
                                    }
                                    disabled={isSummarizing}
                                >
                                    {isSummarizing ? (
                                        <>
                                            <Loader2 className="size-4 mr-2 animate-spin" />
                                            Generating…
                                        </>
                                    ) : summaryData ? (
                                        <>
                                            <RefreshCw className="size-4 mr-2" />
                                            Re-generate
                                        </>
                                    ) : (
                                        <>
                                            <Sparkles className="size-4 mr-2" />
                                            Summarize
                                        </>
                                    )}
                                </Button>
                            </div>
                        </div>
                    </CardHeader>
                    <CardContent>
                        {isSummarizing ? (
                            <div className="flex flex-col items-center justify-center py-8">
                                <Loader2 className="size-8 animate-spin text-primary mb-4" />
                                <p className="text-sm text-muted-foreground">
                                    Generating summary…
                                </p>
                            </div>
                        ) : summaryData?.summary ? (
                            <div className="space-y-4">
                                <button
                                    type="button"
                                    onClick={() =>
                                        setSummaryExpanded(!summaryExpanded)
                                    }
                                    className="flex items-center gap-1 text-sm font-medium hover:text-primary transition-colors"
                                >
                                    {summaryExpanded ? (
                                        <ChevronUp className="size-4" />
                                    ) : (
                                        <ChevronDown className="size-4" />
                                    )}
                                    {summaryExpanded
                                        ? "Collapse"
                                        : "Expand summary"}
                                </button>

                                {summaryExpanded && (
                                    <div className="space-y-4">
                                        {/* Summary text */}
                                        <div className="bg-muted rounded-lg p-4 text-sm">
                                            <RichMarkdown
                                                content={summaryData.summary}
                                            />
                                        </div>

                                        {/* Key points */}
                                        {summaryData.keyPoints &&
                                            summaryData.keyPoints.length >
                                                0 && (
                                                <div>
                                                    <h4 className="text-sm font-medium mb-2">
                                                        Key Points
                                                    </h4>
                                                    <ul className="space-y-1">
                                                        {summaryData.keyPoints.map(
                                                            (point) => {
                                                                const key = `kp-${point.slice(0, 32)}`;
                                                                return (
                                                                    <li
                                                                        key={
                                                                            key
                                                                        }
                                                                        className="text-sm text-muted-foreground flex items-start gap-2"
                                                                    >
                                                                        <span className="text-primary mt-1.5 size-1.5 rounded-full bg-primary shrink-0" />
                                                                        {point}
                                                                    </li>
                                                                );
                                                            },
                                                        )}
                                                    </ul>
                                                </div>
                                            )}

                                        {/* Action items */}
                                        {summaryData.actionItems &&
                                            summaryData.actionItems.length >
                                                0 && (
                                                <div>
                                                    <h4 className="text-sm font-medium mb-2">
                                                        Action Items
                                                    </h4>
                                                    <ul className="space-y-1">
                                                        {summaryData.actionItems.map(
                                                            (item) => {
                                                                const key = `ai-${item.slice(0, 32)}`;
                                                                return (
                                                                    <li
                                                                        key={
                                                                            key
                                                                        }
                                                                        className="text-sm text-muted-foreground flex items-start gap-2"
                                                                    >
                                                                        <ListChecks className="size-3.5 mt-0.5 text-primary shrink-0" />
                                                                        {item}
                                                                    </li>
                                                                );
                                                            },
                                                        )}
                                                    </ul>
                                                </div>
                                            )}

                                        {/* Meta + Delete */}
                                        <div className="flex items-center justify-between pt-2 border-t">
                                            <div className="flex items-center gap-3 text-xs text-muted-foreground">
                                                {summaryData.provider && (
                                                    <span className="px-2 py-0.5 rounded bg-muted">
                                                        {summaryData.provider}
                                                    </span>
                                                )}
                                                {summaryData.model && (
                                                    <span className="px-2 py-0.5 rounded bg-muted font-mono">
                                                        {summaryData.model}
                                                    </span>
                                                )}
                                            </div>
                                            <Button
                                                onClick={handleDeleteSummary}
                                                size="sm"
                                                variant="ghost"
                                                className="text-destructive hover:text-destructive"
                                            >
                                                <Trash2 className="size-4 mr-1" />
                                                Delete
                                            </Button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div className="flex flex-col items-center justify-center py-8 text-center">
                                <ListChecks className="size-10 text-muted-foreground mb-3" />
                                <p className="text-sm text-muted-foreground">
                                    No summary yet. Click "Summarize" to
                                    generate one.
                                </p>
                            </div>
                        )}
                    </CardContent>
                </Card>
            )}
        </div>
    );
}

function formatTimestamp(milliseconds: number): string {
    const totalSeconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function pipelinePhaseLabel(phase: string): string {
    const labels: Record<string, string> = {
        queued: "Waiting to process audio",
        download: "Reading original audio",
        decode: "Preparing audio",
        vad: "Detecting speech",
        chunking: "Preparing speech segments",
        transcribing: "Transcribing speech",
        completed: "Transcription complete",
        needs_alignment: "Transcript saved without timestamps",
        paused_disk: "Paused for disk space",
        failed: "Transcription failed",
        cancelled: "Transcription cancelled",
    };
    return labels[phase] ?? "Processing transcription";
}
