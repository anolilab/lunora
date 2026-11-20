import { describe, expect, it } from "vitest";

import { DEFAULT_TIME_RANGE_PRESET, rangeForPreset, TIME_RANGE_PRESETS } from "../src/client/time-range";

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

describe(rangeForPreset, () => {
    it("resolves each preset to a `[now − span, now]` window the reads thread as from/to", () => {
        expect(rangeForPreset("1h", NOW)).toStrictEqual({ from: NOW - HOUR, to: NOW });
        expect(rangeForPreset("24h", NOW)).toStrictEqual({ from: NOW - 24 * HOUR, to: NOW });
        expect(rangeForPreset("7d", NOW)).toStrictEqual({ from: NOW - 7 * 24 * HOUR, to: NOW });
    });

    it("always yields from < to", () => {
        for (const spec of TIME_RANGE_PRESETS) {
            const range = rangeForPreset(spec.id, NOW);

            expect(range.from).toBeLessThan(range.to);
        }
    });

    it("exposes exactly the 1h / 24h / 7d presets with 24h as the default", () => {
        expect(TIME_RANGE_PRESETS.map((spec) => spec.id)).toStrictEqual(["1h", "24h", "7d"]);
        expect(DEFAULT_TIME_RANGE_PRESET).toBe("24h");
    });
});
