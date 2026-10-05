import { describe, expect, it } from "vitest";

import { collectAll } from "../lunora/paginate";

/**
 * Draining a `findMany` query (the control-plane sweeps that must visit every row).
 * The bug this guards against is silent: reading one page and reporting success,
 * so every organization past the 1000-row page boundary is skipped.
 */

/** A fake table that hands out `size`-row pages of `total` numbered rows. */
const pagedTable = (total: number, size: number) => {
    const calls: (null | string)[] = [];

    const fetchPage = async (cursor: null | string): Promise<{ continueCursor: null | string; isDone: boolean; page: unknown[] }> => {
        calls.push(cursor);

        const offset = cursor === null ? 0 : Number(cursor);
        const page = Array.from({ length: Math.min(size, total - offset) }, (_, index) => offset + index);
        const next = offset + page.length;

        return { continueCursor: next >= total ? null : String(next), isDone: next >= total, page };
    };

    return { calls, fetchPage };
};

describe(collectAll, () => {
    it("returns the single page when the query is already done", async () => {
        const table = pagedTable(3, 10);

        await expect(collectAll(table.fetchPage)).resolves.toStrictEqual([0, 1, 2]);
        expect(table.calls).toStrictEqual([null]);
    });

    it("follows continueCursor across every page", async () => {
        const table = pagedTable(7, 3);

        await expect(collectAll(table.fetchPage)).resolves.toStrictEqual([0, 1, 2, 3, 4, 5, 6]);
        expect(table.calls).toStrictEqual([null, "3", "6"]);
    });

    it("stops on a null cursor even if the page never says it is done", async () => {
        const pages = [
            { continueCursor: "1", isDone: false, page: ["a"] },
            { continueCursor: null, isDone: false, page: ["b"] },
        ];
        let index = 0;

        await expect(
            collectAll(async () => {
                const page = pages[index];

                index += 1;

                return page;
            }),
        ).resolves.toStrictEqual(["a", "b"]);
    });

    it("stops at the runaway cap rather than looping forever", async () => {
        let calls = 0;

        // A query that never reports done — the shape a broken cursor produces.
        const rows = await collectAll(async () => {
            calls += 1;

            return { continueCursor: String(calls), isDone: false, page: [calls] };
        });

        expect(calls).toBe(100);
        expect(rows).toHaveLength(100);
    });

    it("returns an empty list for an empty table", async () => {
        const table = pagedTable(0, 10);

        await expect(collectAll(table.fetchPage)).resolves.toStrictEqual([]);
    });
});
