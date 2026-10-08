import { describe, expect, it } from "vitest";
import {
    dateGroupFallbackLabel,
    formatRecordingDateTimeRange,
} from "@/lib/format-date";

describe("dateGroupFallbackLabel", () => {
    it("uses the UTC month so server and browser time zones render the same placeholder", () => {
        expect(dateGroupFallbackLabel("2026-10-01T00:30:00.000Z")).toBe(
            "October 2026",
        );
    });
});

describe("formatRecordingDateTimeRange", () => {
    it("shows the recorded date with start and end times", () => {
        const start = new Date(2026, 8, 7, 11, 27);

        expect(formatRecordingDateTimeRange(start, 25 * 60 * 1000)).toBe(
            "Sep 7, 2026 · 11:27 AM–11:52 AM",
        );
    });

    it("shows both dates when a recording crosses midnight", () => {
        const start = new Date(2026, 8, 7, 23, 50);

        expect(formatRecordingDateTimeRange(start, 20 * 60 * 1000)).toBe(
            "Sep 7, 2026 · 11:50 PM–Sep 8, 2026 · 12:10 AM",
        );
    });
});
