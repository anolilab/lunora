import { describe, expect, it, vi } from "vitest";

import { createPointReadBatcher } from "../src/point-read-batcher";

/** A fetch that records each call and answers from `rows`. */
const stubFetch = (rows: Record<string, string> = {}) => {
    const calls: { ids: string[]; table: string }[] = [];

    const fetchMany = vi.fn<(table: string, ids: string[]) => Promise<Map<string, { id: string; name: string | undefined }>>>(async (table, ids) => {
        calls.push({ ids: [...ids], table });

        return new Map(ids.filter((id) => id in rows).map((id) => [id, { id, name: rows[id] }] as const));
    });

    return { calls, fetchMany };
};

describe("createPointReadBatcher", () => {
    it("collapses same-tick reads into one fetch", async () => {
        expect.assertions(3);

        const { calls, fetchMany } = stubFetch({ a: "A", b: "B", c: "C" });
        const batcher = createPointReadBatcher(fetchMany);

        // The idiomatic join: N gets started in the same tick.
        const rows = await Promise.all(["a", "b", "c"].map(async (id) => batcher.load("users", id)));

        expect(fetchMany).toHaveBeenCalledTimes(1);
        expect(calls[0]?.ids).toStrictEqual(["a", "b", "c"]);
        expect(rows.map((row) => row?.["name"])).toStrictEqual(["A", "B", "C"]);
    });

    it("resolves a missing row to undefined without disturbing its neighbours", async () => {
        expect.assertions(2);

        const { fetchMany } = stubFetch({ a: "A" });
        const batcher = createPointReadBatcher(fetchMany);

        const [found, missing] = await Promise.all([batcher.load("users", "a"), batcher.load("users", "ghost")]);

        expect(found?.["name"]).toBe("A");
        expect(missing).toBeUndefined();
    });

    it("asks for a duplicated id once but answers both callers", async () => {
        expect.assertions(2);

        const { calls, fetchMany } = stubFetch({ a: "A" });
        const batcher = createPointReadBatcher(fetchMany);

        const [first, second] = await Promise.all([batcher.load("users", "a"), batcher.load("users", "a")]);

        expect(calls[0]?.ids).toStrictEqual(["a"]);
        expect([first?.["name"], second?.["name"]]).toStrictEqual(["A", "A"]);
    });

    it("keeps separate tables in separate fetches", async () => {
        expect.assertions(2);

        const { calls, fetchMany } = stubFetch({ a: "A", b: "B" });
        const batcher = createPointReadBatcher(fetchMany);

        await Promise.all([batcher.load("users", "a"), batcher.load("posts", "b")]);

        expect(fetchMany).toHaveBeenCalledTimes(2);
        expect(calls.map((call) => call.table).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["posts", "users"]);
    });

    it("does not batch across ticks", async () => {
        expect.assertions(1);

        const { fetchMany } = stubFetch({ a: "A", b: "B" });
        const batcher = createPointReadBatcher(fetchMany);

        await batcher.load("users", "a");
        await batcher.load("users", "b");

        expect(fetchMany).toHaveBeenCalledTimes(2);
    });

    it("splits an oversized fan-out into capped chunks", async () => {
        expect.assertions(1);

        const { calls, fetchMany } = stubFetch();
        const batcher = createPointReadBatcher(fetchMany, { maxBatch: 2 });

        await Promise.all(["a", "b", "c", "d", "e"].map(async (id) => batcher.load("users", id)));

        expect(calls.map((call) => call.ids.length)).toStrictEqual([2, 2, 1]);
    });

    it("fails every id in a batch when the fetch throws", async () => {
        expect.assertions(1);

        const boom = new Error("d1 unavailable");
        const batcher = createPointReadBatcher(async () => {
            throw boom;
        });

        const results = await Promise.allSettled([batcher.load("users", "a"), batcher.load("users", "b")]);

        expect(results.map((result) => result.status)).toStrictEqual(["rejected", "rejected"]);
    });
});
