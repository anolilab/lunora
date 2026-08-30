import { describe, expect, it } from "vitest";

import { cacheFooterText } from "../../../src/features/home/home-panel";
import type { TFunction } from "../../../src/i18n/i18n-context";
import type { CacheStats } from "../../../src/lib/admin";

/** Identity translator — English ids are the rendered text, so this is the real output. */
const t: TFunction = (id) => id;

const stats = (over: Partial<CacheStats> = {}): CacheStats => {
    return { bytes: 0, entries: 0, evictions: 0, hits: 0, misses: 0, ...over };
};

describe("cacheFooterText", () => {
    it("says the cache is not enabled rather than rendering nothing", () => {
        expect.assertions(1);

        expect(cacheFooterText(t, null)).toBe("cache not enabled");
    });

    it("distinguishes an enabled-but-unused cache from a disabled one", () => {
        expect.assertions(1);

        expect(cacheFooterText(t, stats({ entries: 3 }))).toBe("no cache traffic yet");
    });

    it("reports the hit rate once the cache has served traffic", () => {
        expect.assertions(1);

        expect(cacheFooterText(t, stats({ hits: 3, misses: 1 }))).toBe("75% cache hit");
    });
});
