import { describe, expect, it } from "vitest";

import type { BadgeVariant } from "../../../src/features/logs/log-level-variant";
import { LEVEL_VARIANT } from "../../../src/features/logs/log-level-variant";
import type { LogLevel } from "../../../src/lib/admin";

/** Every severity `@lunora/do`'s LogLevel enumerates — kept in lockstep with `lib/admin`'s union. */
const ALL_LEVELS: LogLevel[] = ["debug", "error", "fatal", "info", "log", "trace", "warn"];

describe("log level badge variants", () => {
    it("maps every log level to a concrete Badge variant", () => {
        expect.assertions(7);

        const variants: BadgeVariant[] = ["default", "destructive", "outline", "secondary"];

        for (const level of ALL_LEVELS) {
            expect(variants).toContain(LEVEL_VARIANT[level]);
        }
    });

    it("gives error and fatal the same destructive tone (the label distinguishes them)", () => {
        expect.assertions(2);

        expect(LEVEL_VARIANT.error).toBe("destructive");
        expect(LEVEL_VARIANT.fatal).toBe("destructive");
    });

    it("uses the quieter tiers for debug/warn (secondary) and info/log/trace (outline)", () => {
        expect.assertions(5);

        expect(LEVEL_VARIANT.debug).toBe("secondary");
        expect(LEVEL_VARIANT.warn).toBe("secondary");
        expect(LEVEL_VARIANT.info).toBe("outline");
        expect(LEVEL_VARIANT.log).toBe("outline");
        expect(LEVEL_VARIANT.trace).toBe("outline");
    });

    it("has an entry for every level and no stray keys", () => {
        expect.assertions(1);

        expect(new Set(Object.keys(LEVEL_VARIANT))).toEqual(new Set(ALL_LEVELS));
    });
});
