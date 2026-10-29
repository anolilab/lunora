import { describe, expect, it, vi } from "vitest";

import { createDiscoveryCache } from "../src/discovery-cache";

describe(createDiscoveryCache, () => {
    it("computes once per key and recomputes after clear", () => {
        expect.assertions(4);

        const cache = createDiscoveryCache();
        const compute = vi.fn<() => object>(() => {
            return {};
        });

        expect(cache.memo("a", compute)).toBe(cache.memo("a", compute));
        expect(compute).toHaveBeenCalledTimes(1);

        cache.memo("b", compute);
        cache.clear();
        cache.memo("a", compute);

        expect(compute).toHaveBeenCalledTimes(3);
        expect(cache.memo("a", compute)).toBeDefined();
    });
});
