/**
 * Shared dashboard time-range presets (GAPS.md ring 3 "time-range picker"). Pure
 * range math, kept out of the React provider so it unit-tests under the node
 * vitest env. The presets thread a `[from, to]` epoch-ms window into the Traces,
 * Logs, and Metrics reads (all of which already take `from`/`to`).
 */

/** The supported quick-range presets. */
export type TimeRangePreset = "1h" | "7d" | "24h";

/** A resolved absolute window (epoch ms). */
export interface TimeRange {
    from: number;
    to: number;
}

/** One preset button: its id, label, and look-back span in ms. */
export interface TimeRangePresetSpec {
    id: TimeRangePreset;
    label: string;
    ms: number;
}

const HOUR_MS = 60 * 60 * 1000;

/** Preset specs, in the order the picker renders them. `24h` is the default. */
export const TIME_RANGE_PRESETS: readonly TimeRangePresetSpec[] = [
    { id: "1h", label: "1h", ms: HOUR_MS },
    { id: "24h", label: "24h", ms: 24 * HOUR_MS },
    { id: "7d", label: "7d", ms: 7 * 24 * HOUR_MS },
];

/** The default preset when none is chosen. */
export const DEFAULT_TIME_RANGE_PRESET: TimeRangePreset = "24h";

/** Resolve a preset to an absolute `[now − span, now]` window. Falls back to the default span for an unknown id. */
export const rangeForPreset = (preset: TimeRangePreset, now: number): TimeRange => {
    const spec = TIME_RANGE_PRESETS.find((candidate) => candidate.id === preset) ?? TIME_RANGE_PRESETS[1];

    return { from: now - spec.ms, to: now };
};
