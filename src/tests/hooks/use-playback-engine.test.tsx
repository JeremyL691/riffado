// @vitest-environment jsdom

import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Recording } from "@/types/recording";

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));

vi.mock("sonner", () => ({ toast: { error: toastError } }));

import { usePlaybackEngine } from "@/hooks/use-playback-engine";

const recording = { id: "recording-for-playback-test" } as Recording;

let controls: ReturnType<typeof usePlaybackEngine> | null = null;
let pausedStates = new WeakMap<HTMLMediaElement, boolean>();
let readyStates = new WeakMap<HTMLMediaElement, number>();

function PlaybackHarness({
    onEnded,
    initialAutoPlayNext,
}: {
    onEnded?: () => void;
    initialAutoPlayNext?: boolean;
}) {
    controls = usePlaybackEngine({ recording, onEnded, initialAutoPlayNext });
    return (
        <audio ref={controls.audioRef}>
            <track kind="captions" />
        </audio>
    );
}

function renderPlaybackHarness() {
    const view = render(<PlaybackHarness />);
    const audio = view.container.querySelector("audio");
    if (!audio || !controls) throw new Error("Playback harness did not mount");
    const getControls = () => {
        if (!controls) throw new Error("Playback harness did not mount");
        return controls;
    };
    return { ...view, audio, getControls };
}

describe("usePlaybackEngine", () => {
    beforeEach(() => {
        controls = null;
        toastError.mockClear();
        vi.spyOn(console, "error").mockImplementation(() => {});
        vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(
            () => {},
        );
        pausedStates = new WeakMap();
        readyStates = new WeakMap();
        Object.defineProperty(HTMLMediaElement.prototype, "paused", {
            configurable: true,
            get() {
                return pausedStates.get(this) ?? true;
            },
        });
        vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(
            function (this: HTMLMediaElement) {
                pausedStates.set(this, false);
                this.dispatchEvent(new Event("play"));
                return Promise.resolve();
            },
        );
        vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(
            function (this: HTMLMediaElement) {
                pausedStates.set(this, true);
                this.dispatchEvent(new Event("pause"));
            },
        );

        const currentTimes = new WeakMap<HTMLMediaElement, number>();
        Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
            configurable: true,
            get() {
                return currentTimes.get(this) ?? 0;
            },
            set(value: number) {
                currentTimes.set(this, value);
            },
        });
        Object.defineProperty(HTMLMediaElement.prototype, "duration", {
            configurable: true,
            get: () => 120,
        });
        Object.defineProperty(HTMLMediaElement.prototype, "readyState", {
            configurable: true,
            get() {
                return readyStates.get(this) ?? HTMLMediaElement.HAVE_METADATA;
            },
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("updates the visible playback time immediately when seeking by timestamp", () => {
        const { audio, getControls } = renderPlaybackHarness();

        act(() => getControls().seekToMilliseconds(40_558));

        expect(audio.currentTime).toBeCloseTo(40.558);
        expect(getControls().currentTime).toBeCloseTo(40.558);
    });

    it("applies a timestamp seek after the audio metadata becomes available", () => {
        const { audio, getControls } = renderPlaybackHarness();
        readyStates.set(audio, HTMLMediaElement.HAVE_NOTHING);

        act(() => getControls().seekToMilliseconds(40_558));

        expect(audio.currentTime).toBe(0);
        expect(getControls().currentTime).toBeCloseTo(40.558);

        act(() => {
            readyStates.set(audio, HTMLMediaElement.HAVE_METADATA);
            audio.dispatchEvent(new Event("loadedmetadata"));
        });

        expect(audio.currentTime).toBeCloseTo(40.558);
        expect(getControls().currentTime).toBeCloseTo(40.558);
    });

    it("ignores stale paused time and seek events, then resumes during playback", () => {
        const { audio, getControls } = renderPlaybackHarness();

        act(() => getControls().seekToMilliseconds(40_558));
        act(() => {
            audio.currentTime = 0;
            audio.dispatchEvent(new Event("timeupdate"));
            audio.dispatchEvent(new Event("seeked"));
        });
        expect(audio.currentTime).toBeCloseTo(40.558);
        expect(getControls().currentTime).toBeCloseTo(40.558);

        act(() => {
            audio.currentTime = 40.558;
            audio.dispatchEvent(new Event("seeked"));
        });
        expect(getControls().currentTime).toBeCloseTo(40.558);

        act(() => {
            pausedStates.set(audio, false);
            audio.dispatchEvent(new Event("play"));
            audio.currentTime = 41.558;
            audio.dispatchEvent(new Event("timeupdate"));
        });

        expect(getControls().currentTime).toBeCloseTo(41.558);
    });

    it("clamps a timestamp seek to the loaded audio duration", () => {
        const { audio, getControls } = renderPlaybackHarness();

        act(() => getControls().seekToMilliseconds(150_000));

        expect(audio.currentTime).toBe(120);
        expect(getControls().currentTime).toBe(120);
    });

    it("sets playing state only after native playback starts", async () => {
        const { audio, getControls } = renderPlaybackHarness();

        await act(async () => getControls().togglePlayPause());

        expect(getControls().isPlaying).toBe(true);
        expect(audio.play).toHaveBeenCalledOnce();

        await act(async () => getControls().togglePlayPause());

        expect(audio.pause).toHaveBeenCalledOnce();
        expect(getControls().isPlaying).toBe(false);
    });

    it("keeps audio playing and uses the latest end callback after a dashboard rerender", async () => {
        const previousOnEnded = vi.fn();
        const currentOnEnded = vi.fn();
        const view = render(
            <PlaybackHarness
                onEnded={previousOnEnded}
                initialAutoPlayNext={true}
            />,
        );
        const audio = view.container.querySelector("audio");
        if (!audio) throw new Error("Playback harness did not mount");
        const getControls = () => {
            if (!controls) throw new Error("Playback harness did not mount");
            return controls;
        };

        expect(audio.load).toHaveBeenCalledOnce();
        await act(async () => getControls().togglePlayPause());
        expect(audio.paused).toBe(false);

        view.rerender(
            <PlaybackHarness
                onEnded={currentOnEnded}
                initialAutoPlayNext={true}
            />,
        );

        expect(audio.load).toHaveBeenCalledOnce();
        expect(audio.paused).toBe(false);
        expect(getControls().isPlaying).toBe(true);

        act(() => audio.dispatchEvent(new Event("ended")));

        expect(previousOnEnded).not.toHaveBeenCalled();
        expect(currentOnEnded).toHaveBeenCalledOnce();
    });

    it("does not show playing when play resolves but the audio remains paused", async () => {
        const { audio, getControls } = renderPlaybackHarness();
        vi.mocked(audio.play).mockResolvedValueOnce();

        await act(async () => getControls().togglePlayPause());

        expect(audio.paused).toBe(true);
        expect(getControls().isPlaying).toBe(false);
    });

    it("clears playing state and reports a rejected play request", async () => {
        const { audio, getControls } = renderPlaybackHarness();
        vi.mocked(audio.play).mockRejectedValueOnce(
            new Error("playback is unavailable"),
        );

        await act(async () => getControls().togglePlayPause());

        expect(getControls().isPlaying).toBe(false);
        expect(toastError).toHaveBeenCalledWith("Failed to play audio");
        expect(console.error).toHaveBeenCalledWith(
            "Error playing audio:",
            expect.any(Error),
        );
    });
});
