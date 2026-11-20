import { describe, expect, it, vi } from "vitest";

import { BoundedCache, LOOKUP_CACHE_MAX_ENTRIES } from "../src/plans/bounded-cache";
import { createPlanResolver } from "../src/plans/plan-resolver";
import { createCustomDomainResolver } from "../src/targets/cloudflare-wfp/route";
import { answer } from "./_helpers/plan-fixtures";

/**
 * The dispatcher's per-isolate lookup caches are keyed by request hostnames,
 * which anyone can mint. Each must stay bounded however many distinct hosts it
 * is asked about, or a stream of made-up hosts exhausts the isolate.
 */

const flood = async (resolve: (key: string) => Promise<unknown>, count: number): Promise<void> => {
    for (let index = 0; index < count; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- each lookup must settle before the next, as on the request path
        await resolve(`host-${String(index)}`);
    }
};

describe(BoundedCache, () => {
    it("drops the least recently used entry once past its cap", () => {
        const cache = new BoundedCache<number>(2);

        cache.set("a", 1);
        cache.set("b", 2);
        // A read makes `a` the most recent, so `b` is the one to go.
        cache.get("a");
        cache.set("c", 3);

        expect(cache.size).toBe(2);
        expect(cache.get("a")).toBe(1);
        expect(cache.get("b")).toBeUndefined();
        expect(cache.get("c")).toBe(3);
    });
});

describe("dispatcher lookup caches", () => {
    it("bounds the plan cache, so the first of a flood of hosts is looked up again", async () => {
        const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => answer({ plan: "unknown" }));
        const resolve = createPlanResolver({ controlPlaneToken: "t", controlPlaneUrl: "https://cp", fetch, now: () => 0 });

        await flood(resolve, LOOKUP_CACHE_MAX_ENTRIES + 1);
        fetch.mockClear();
        // Still within its TTL: only an eviction makes this a second lookup.
        await resolve("host-0");

        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("bounds the custom-domain cache, negative answers included", async () => {
        const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => answer({}));
        const resolve = createCustomDomainResolver({ controlPlaneToken: "t", controlPlaneUrl: "https://cp", fetch, now: () => 0 });

        await flood(resolve, LOOKUP_CACHE_MAX_ENTRIES + 1);
        fetch.mockClear();
        await resolve("host-0");

        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("keeps a recent host cached through the flood", async () => {
        const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => answer({}));
        const resolve = createCustomDomainResolver({ controlPlaneToken: "t", controlPlaneUrl: "https://cp", fetch, now: () => 0 });

        await flood(resolve, LOOKUP_CACHE_MAX_ENTRIES + 1);
        fetch.mockClear();
        await resolve(`host-${String(LOOKUP_CACHE_MAX_ENTRIES)}`);

        expect(fetch).not.toHaveBeenCalled();
    });
});
