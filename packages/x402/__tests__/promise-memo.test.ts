import { describe, expect, it, vi } from "vitest";

import { memoizePromise } from "../../../shared/promise-memo";

/** A promise plus the handles to settle it, so a test can hold an entry in flight. */
const deferred = <T>() => {
    let settle!: (value: T) => void;
    let fail!: (error: unknown) => void;
    const promise = new Promise<T>((resolve, reject) => {
        settle = resolve;
        fail = reject;
    });

    return { promise, reject: fail, resolve: settle };
};

describe("memoizePromise", () => {
    it("runs the work once per key and reuses the promise", async () => {
        expect.assertions(3);

        const map = new Map<string, Promise<string>>();
        const start = vi.fn<() => Promise<string>>(async () => "built");

        await expect(memoizePromise(map, "a", start)).resolves.toBe("built");
        await expect(memoizePromise(map, "a", start)).resolves.toBe("built");

        expect(start).toHaveBeenCalledTimes(1);
    });

    it("coalesces concurrent callers onto one run", async () => {
        expect.assertions(2);

        const map = new Map<string, Promise<string>>();
        const gate = deferred<string>();
        const start = vi.fn<() => Promise<string>>(async () => gate.promise);

        const both = Promise.all([memoizePromise(map, "a", start), memoizePromise(map, "a", start)]);

        gate.resolve("built");

        await expect(both).resolves.toStrictEqual(["built", "built"]);
        expect(start).toHaveBeenCalledTimes(1);
    });

    it("keys independently", async () => {
        expect.assertions(2);

        const map = new Map<string, Promise<string>>();
        const start = vi.fn<() => Promise<string>>(async () => "built");

        await Promise.all([memoizePromise(map, "a", start), memoizePromise(map, "b", start)]);

        expect(start).toHaveBeenCalledTimes(2);
        expect([...map.keys()]).toStrictEqual(["a", "b"]);
    });

    it("does not cache a rejection — the next caller retries", async () => {
        expect.assertions(4);

        const map = new Map<string, Promise<string>>();
        const start = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error("transient")).mockResolvedValueOnce("built");

        await expect(memoizePromise(map, "a", start)).rejects.toThrow("transient");
        expect(map.has("a")).toBe(false);

        await expect(memoizePromise(map, "a", start)).resolves.toBe("built");
        expect(start).toHaveBeenCalledTimes(2);
    });

    it("evicts only its own entry, so a late failure cannot drop a healthy retry", async () => {
        expect.assertions(3);

        const map = new Map<string, Promise<string>>();
        const slowFailure = deferred<string>();

        // First attempt starts and stalls.
        const first = memoizePromise(map, "a", async () => slowFailure.promise);

        // It is forcibly evicted (as a caller bounding the map might), and a
        // second, healthy attempt takes the slot.
        map.delete("a");

        const second = memoizePromise(map, "a", async () => "healthy");

        // Only NOW does the first attempt fail. An unconditional
        // `map.delete(key)` here would evict the healthy entry.
        slowFailure.reject(new Error("transient"));

        await expect(first).rejects.toThrow("transient");
        await expect(second).resolves.toBe("healthy");
        expect(map.get("a")).toBe(second);
    });

    it("bounds the map FIFO when maxEntries is given, evicting on insert only", async () => {
        expect.assertions(3);

        const map = new Map<string, Promise<string>>();

        await memoizePromise(map, "a", async () => "a", 2);
        await memoizePromise(map, "b", async () => "b", 2);

        // A hit adds no entry, so it must not evict one either.
        await memoizePromise(map, "a", async () => "a", 2);

        expect([...map.keys()]).toStrictEqual(["a", "b"]);

        // The third distinct key pushes the oldest out, never past the bound.
        await memoizePromise(map, "c", async () => "c", 2);

        expect([...map.keys()]).toStrictEqual(["b", "c"]);
        expect(map.size).toBe(2);
    });

    it("grows without a bound when maxEntries is omitted", async () => {
        expect.assertions(1);

        const map = new Map<string, Promise<string>>();

        await Promise.all([...Array.from({ length: 5 }).keys()].map(async (index) => memoizePromise(map, `k${String(index)}`, async () => "built")));

        expect(map.size).toBe(5);
    });
});
