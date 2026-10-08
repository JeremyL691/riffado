"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { Recording } from "@/types/recording";

export const PLAYBACK_SPEED_OPTIONS = [
    { label: "0.5x", value: 0.5 },
    { label: "0.75x", value: 0.75 },
    { label: "1x", value: 1.0 },
    { label: "1.25x", value: 1.25 },
    { label: "1.5x", value: 1.5 },
    { label: "2x", value: 2.0 },
] as const;

interface Options {
    recording: Recording;
    /** Called when audio finishes playing AND autoPlayNext is on. */
    onEnded?: () => void;
    initialPlaybackSpeed?: number;
    initialVolume?: number;
    initialAutoPlayNext?: boolean;
}

/**
 * Owns the HTMLAudioElement and all of its lifecycle: src swap on
 * recording change, listener wiring (timeupdate / loadedmetadata /
 * durationchange / ended / seeked), and the derived playback state
 * (isPlaying, currentTime, duration, volume, playbackSpeed).
 *
 * Returns a stable `audioRef` (attach to a hidden <audio>), the
 * derived state, and imperative handlers (toggle, seek, cycleSpeed,
 * toggleMute). Keyboard bindings live in usePlaybackKeyboard so the
 * test surface for "given an audio element, control playback" stays
 * separate from "given a player UI, react to keys".
 */
export function usePlaybackEngine({
    recording,
    onEnded,
    initialPlaybackSpeed = 1.0,
    initialVolume = 75,
    initialAutoPlayNext = false,
}: Options) {
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [volume, setVolume] = useState(initialVolume);
    const [playbackSpeed, setPlaybackSpeed] = useState(initialPlaybackSpeed);
    const [autoPlayNext] = useState(initialAutoPlayNext);
    const audioRef = useRef<HTMLAudioElement>(null);
    const onEndedRef = useRef(onEnded);
    const autoPlayNextRef = useRef(autoPlayNext);
    const pendingSeekTimeRef = useRef<number | null>(null);
    const pendingSeekRetryRef = useRef(false);

    useEffect(() => {
        onEndedRef.current = onEnded;
        autoPlayNextRef.current = autoPlayNext;
    }, [autoPlayNext, onEnded]);

    // Reset transport state and re-point src whenever the recording
    // *id* changes. Filename edits must not remount playback.
    useEffect(() => {
        setCurrentTime(0);
        setDuration(0);
        setIsPlaying(false);
        pendingSeekTimeRef.current = null;
        pendingSeekRetryRef.current = false;
        if (audioRef.current) {
            audioRef.current.currentTime = 0;
            audioRef.current.src = `/api/recordings/${recording.id}/audio`;
            audioRef.current.load();
        }
    }, [recording.id]);

    useEffect(() => {
        if (audioRef.current) {
            audioRef.current.volume = volume / 100;
        }
    }, [volume]);

    useEffect(() => {
        if (audioRef.current) {
            audioRef.current.playbackRate = playbackSpeed;
        }
    }, [playbackSpeed]);

    // Keep listeners attached to the same audio element for its lifetime.
    // The recording-id effect above owns source changes; refs keep the
    // ended callback current without reloading audio on parent renders.
    useEffect(() => {
        if (!audioRef.current) return;
        const audio = audioRef.current;

        const updateTime = () => {
            const pendingSeekTime = pendingSeekTimeRef.current;
            if (
                pendingSeekTime !== null &&
                Math.abs(audio.currentTime - pendingSeekTime) > 0.25 &&
                audio.paused
            ) {
                return;
            }
            pendingSeekTimeRef.current = null;
            pendingSeekRetryRef.current = false;
            setCurrentTime(audio.currentTime);
        };
        const updateDuration = () => {
            if (audio.duration && !Number.isNaN(audio.duration)) {
                setDuration(audio.duration);
                const pendingSeekTime = pendingSeekTimeRef.current;
                if (
                    pendingSeekTime !== null &&
                    audio.readyState >= HTMLMediaElement.HAVE_METADATA
                ) {
                    const target = Math.min(audio.duration, pendingSeekTime);
                    pendingSeekTimeRef.current = target;
                    if (Math.abs(audio.currentTime - target) <= 0.25) {
                        pendingSeekTimeRef.current = null;
                        pendingSeekRetryRef.current = false;
                        setCurrentTime(audio.currentTime);
                    } else {
                        pendingSeekRetryRef.current = false;
                        audio.currentTime = target;
                    }
                }
            }
        };
        const handleEnded = () => {
            setIsPlaying(false);
            if (autoPlayNextRef.current && onEndedRef.current) {
                onEndedRef.current();
            }
        };
        const handlePlay = () => {
            setIsPlaying(true);
        };
        const handlePause = () => setIsPlaying(false);
        const handleSeeked = () => {
            const pendingSeekTime = pendingSeekTimeRef.current;
            if (
                pendingSeekTime !== null &&
                Math.abs(audio.currentTime - pendingSeekTime) > 0.25
            ) {
                if (!pendingSeekRetryRef.current) {
                    pendingSeekRetryRef.current = true;
                    audio.currentTime = pendingSeekTime;
                }
                return;
            }
            pendingSeekTimeRef.current = null;
            pendingSeekRetryRef.current = false;
            setCurrentTime(audio.currentTime);
        };

        audio.addEventListener("timeupdate", updateTime);
        audio.addEventListener("loadedmetadata", updateDuration);
        audio.addEventListener("durationchange", updateDuration);
        audio.addEventListener("ended", handleEnded);
        audio.addEventListener("play", handlePlay);
        audio.addEventListener("pause", handlePause);
        audio.addEventListener("seeked", handleSeeked);

        if (audio.duration && !Number.isNaN(audio.duration)) {
            setDuration(audio.duration);
        }

        return () => {
            audio.removeEventListener("timeupdate", updateTime);
            audio.removeEventListener("loadedmetadata", updateDuration);
            audio.removeEventListener("durationchange", updateDuration);
            audio.removeEventListener("ended", handleEnded);
            audio.removeEventListener("play", handlePlay);
            audio.removeEventListener("pause", handlePause);
            audio.removeEventListener("seeked", handleSeeked);
        };
    }, []);

    const togglePlayPause = useCallback(async () => {
        const audio = audioRef.current;
        if (!audio) return;
        if (isPlaying || !audio.paused) {
            audio.pause();
            setIsPlaying(false);
        } else {
            audio.playbackRate = playbackSpeed;
            try {
                await audio.play();
                setIsPlaying(!audio.paused);
            } catch (error) {
                setIsPlaying(false);
                console.error("Error playing audio:", error);
                toast.error("Failed to play audio");
            }
        }
    }, [isPlaying, playbackSpeed]);

    const seekToSeconds = useCallback((timeSeconds: number) => {
        const audio = audioRef.current;
        if (!audio || !Number.isFinite(timeSeconds)) return;
        const audioDuration = audio.duration;
        const newTime = Math.max(
            0,
            Number.isFinite(audioDuration) && audioDuration > 0
                ? Math.min(audioDuration, timeSeconds)
                : timeSeconds,
        );
        if (Math.abs(audio.currentTime - newTime) <= Number.EPSILON) {
            pendingSeekTimeRef.current = null;
            pendingSeekRetryRef.current = false;
            setCurrentTime(audio.currentTime);
            return;
        }
        pendingSeekTimeRef.current = newTime;
        pendingSeekRetryRef.current = false;
        setCurrentTime(newTime);
        if (audio.readyState < HTMLMediaElement.HAVE_METADATA) return;
        audio.currentTime = newTime;
    }, []);

    const seekToMilliseconds = useCallback(
        (milliseconds: number) => {
            if (!Number.isFinite(milliseconds)) return;
            seekToSeconds(milliseconds / 1000);
        },
        [seekToSeconds],
    );

    /**
     * Seek to a ratio in [0, 1] of the audio's duration. Used by both
     * the slider (which translates 0-100 -> 0-1 itself) and the
     * waveform click handler. Centralising means seek semantics stay
     * identical regardless of which control the user touches.
     */
    const seekToRatio = useCallback(
        (ratio: number) => {
            const audio = audioRef.current;
            if (!audio) return;
            const audioDuration = audio.duration;
            if (!audioDuration || Number.isNaN(audioDuration)) {
                audio.load();
                return;
            }
            seekToSeconds(ratio * audioDuration);
        },
        [seekToSeconds],
    );

    /**
     * Seek by signed seconds offset (used by keyboard left/right).
     * Clamps to [0, duration].
     */
    const seekRelative = useCallback(
        (deltaSeconds: number) => {
            const audio = audioRef.current;
            if (!audio || duration <= 0) return;
            const newTime = Math.max(
                0,
                Math.min(duration, currentTime + deltaSeconds),
            );
            seekToSeconds(newTime);
        },
        [currentTime, duration, seekToSeconds],
    );

    const cycleSpeed = useCallback(() => {
        const currentIndex = PLAYBACK_SPEED_OPTIONS.findIndex(
            (opt) => opt.value === playbackSpeed,
        );
        const nextIndex = (currentIndex + 1) % PLAYBACK_SPEED_OPTIONS.length;
        const nextSpeed = PLAYBACK_SPEED_OPTIONS[nextIndex].value;
        setPlaybackSpeed(nextSpeed);
        if (audioRef.current) {
            audioRef.current.playbackRate = nextSpeed;
        }
    }, [playbackSpeed]);

    // Mute toggle stashes the previous volume so unmute restores it.
    // A pure 0/75 toggle would be surprising for users who set their
    // own preferred level.
    const previousVolumeRef = useRef<number>(volume > 0 ? volume : 75);
    useEffect(() => {
        if (volume > 0) previousVolumeRef.current = volume;
    }, [volume]);
    const toggleMute = useCallback(() => {
        setVolume((v) => (v > 0 ? 0 : previousVolumeRef.current || 75));
    }, []);

    return {
        audioRef,
        isPlaying,
        currentTime,
        duration,
        volume,
        setVolume,
        playbackSpeed,
        togglePlayPause,
        seekToMilliseconds,
        seekToRatio,
        seekRelative,
        cycleSpeed,
        toggleMute,
    };
}
