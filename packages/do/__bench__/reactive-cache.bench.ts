import { bench, describe } from "vitest";

import { createDependencyTracker } from "../src/dependency-tracker";
import { ReactiveCache, reactiveCacheKey } from "../src/reactive-cache";

/**
 * The reactive cache earns its keep when query handlers are non-trivial: a
 * memoized return collapses N ms of work into a single Map lookup + ref. The
 * bench measures three paths so the win and the miss-overhead are both
 * visible:
 *
 * - **hit** — `cache.run(key, deps, handler)` returns the stored result
 * without invoking `handler`. The cost is the key lookup + LRU touch.
 * - **miss** — same call when the key isn't cached: `handler` runs, the
 * result is stored, the dep set is committed. This is the cost users
 * pay on the first call (and every call when the cache is OFF).
 * - **baseline (no cache)** — running `handler` directly so the cache
 * overhead is visible in absolute terms. Subtract this from `miss` to
 * see what the wrapper itself costs.
 *
 * `handler` is a small async work-unit (an awaited Promise that walks a
 * 100-element array) — enough that the cache hit / miss difference is
 * measurable but not so heavy that the miss path dominates the readout.
 */

const SYNTHETIC_WORK_SIZE = 100;

const syntheticHandler = async (): Promise<number> => {
    // A tiny await + map keeps the JIT honest and mirrors the shape of a
    // small query handler (loop over result rows, sum a field).
    await Promise.resolve();

    let sum = 0;

    for (let index = 0; index < SYNTHETIC_WORK_SIZE; index += 1) {
        sum += index;
    }

    return sum;
};

// Setup inline (vitest bench doesn't await beforeAll cleanly — same shape as
// the existing dispatch/broadcast-delta benches).
const primedCache = new ReactiveCache({ maxEntries: 1024 });
const primedKey = reactiveCacheKey("primed:handler", { id: "p1" }, null);

await primedCache.run(primedKey, createDependencyTracker().collect(), syntheticHandler);

// Tiny cache for the miss path so every iteration evicts the previous entry.
const missCache = new ReactiveCache({ maxEntries: 1 });
let missCounter = 0;

describe("ReactiveCache.run — hit vs miss vs no-cache", () => {
    bench("hit: cache.run returns memoized result", async () => {
        await primedCache.run(primedKey, createDependencyTracker().collect(), syntheticHandler);
    });

    bench("miss: cache.run runs handler + stores result (eviction-forced)", async () => {
        missCounter += 1;
        const key = reactiveCacheKey("miss:handler", { n: missCounter }, null);

        await missCache.run(key, createDependencyTracker().collect(), syntheticHandler);
    });

    bench("baseline: handler invoked directly (no cache wrapper)", async () => {
        await syntheticHandler();
    });
});
