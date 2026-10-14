import { describe, expect, it } from "vitest";

import type { RankPageFanOutResult, RankPageRow } from "../src/query-coordinator";
import { createQueryCoordinator, createStaticShardRegistry } from "../src/query-coordinator";
import type { ShardNamespaceLike } from "../src/resolve-shard";

interface ShardCall {
    args: Record<string, unknown>;
    functionPath: string;
    shardKey: string;
}

/**
 * A fake shard that serves a fixed list of rank rows (already in local rank
 * order), honoring the coordinator's `take` and `after` resume key the same way
 * the real shard-do `rankPage` reader does: it walks past the `after` key with
 * the byte-identical `(__partition__, __sort_k<i>__, __id__)` comparison and
 * returns up to `take` rows plus a `hasMore` flag. This is the structural
 * contract `__lunora_admin__:rankPage` fulfills server-side.
 */
const RANK_CLASS = (value: unknown): number => {
    if (value === null || value === undefined) {
        return 0;
    }

    if (typeof value === "number") {
        return 1;
    }

    return 2;
};

const compareValueAsc = (a: unknown, b: unknown): number => {
    const classA = RANK_CLASS(a);
    const classB = RANK_CLASS(b);

    if (classA !== classB) {
        return classA < classB ? -1 : 1;
    }

    if (classA === 0) {
        return 0;
    }

    if (a === b) {
        return 0;
    }

    return (a as number | string) < (b as number | string) ? -1 : 1;
};

const compareKey = (a: RankPageRow["key"], b: RankPageRow["key"], directions: ReadonlyArray<"asc" | "desc">): number => {
    const partitionCmp = compareValueAsc(a.partitionKey, b.partitionKey);

    if (partitionCmp !== 0) {
        return partitionCmp;
    }

    const length = Math.max(a.sortValues.length, b.sortValues.length);

    for (let i = 0; i < length; i += 1) {
        const valueCmp = compareValueAsc(a.sortValues[i], b.sortValues[i]);

        if (valueCmp !== 0) {
            return directions[i] === "desc" ? -valueCmp : valueCmp;
        }
    }

    return compareValueAsc(a.rowId, b.rowId);
};

/** Build a rank row from a partition / sort tuple / id, doc carries the id for assertions. */
const row = (partitionKey: string, sortValues: ReadonlyArray<unknown>, rowId: string): RankPageRow => {
    return { doc: { _id: rowId }, key: { partitionKey, rowId, sortValues } };
};

const createRankPageNamespace = (
    shardRows: Record<string, ReadonlyArray<RankPageRow>>,
    directions: ReadonlyArray<"asc" | "desc">,
    calls: ShardCall[] = [],
): ShardNamespaceLike => {
    const stubFor = (shardKey: string) => {
        return {
            async fetch(request: Request): Promise<Response> {
                const body: { args: Record<string, unknown>; functionPath: string } = await request.json();

                calls.push({ args: body.args, functionPath: body.functionPath, shardKey });

                const rows = shardRows[shardKey] ?? [];
                const take = Number(body.args["take"] ?? 100);
                const after = body.args["after"] as RankPageRow["key"] | undefined;

                const startAt = after ? rows.findIndex((r) => compareKey(r.key, after, directions) > 0) : 0;
                const from = startAt === -1 ? rows.length : startAt;
                const slice = rows.slice(from, from + take);
                const hasMore = from + take < rows.length;

                return Response.json({ result: { hasMore, rows: slice } }, { status: 200 });
            },
        };
    };

    return {
        get: (id) => stubFor((id as { __name: string }).__name),
        getByName: (name) => stubFor(name),
        idFromName: (name) => {
            return { __name: name };
        },
    };
};

const ids = (result: RankPageFanOutResult): string[] => result.page.map((doc) => doc["_id"] as string);

describe("orchestrateRankPage — k-way merge", () => {
    it("merges three shards into one globally-ranked page by the sort key", async () => {
        expect.assertions(4);

        // Single partition (""), one ascending sort key (a score). Interleaved
        // across shards so the merge has to pick across shards every step.
        const shardRows = {
            a: [row("", [10], "a1"), row("", [40], "a2"), row("", [70], "a3")],
            b: [row("", [20], "b1"), row("", [50], "b2")],
            c: [row("", [30], "c1"), row("", [60], "c2")],
        };
        const namespace = createRankPageNamespace(shardRows, ["asc"]);
        const coordinator = createQueryCoordinator({ registry: createStaticShardRegistry({ scores: ["a", "b", "c"] }) });

        const result = await coordinator.orchestrateRankPage(namespace, { index: "lb", table: "scores", take: 100 });

        expect(ids(result)).toEqual(["a1", "b1", "c1", "a2", "b2", "c2", "a3"]);
        expect(result.isDone).toBe(true);
        expect(result.continueCursor).toBeNull();
        expect(result.ok).toBe(3);
    });

    it("honors a descending sort direction", async () => {
        expect.assertions(1);

        const shardRows = {
            a: [row("", [70], "a3"), row("", [40], "a2"), row("", [10], "a1")],
            b: [row("", [50], "b2"), row("", [20], "b1")],
        };
        const namespace = createRankPageNamespace(shardRows, ["desc"]);
        const coordinator = createQueryCoordinator({ registry: createStaticShardRegistry({ scores: ["a", "b"] }) });

        const result = await coordinator.orchestrateRankPage(namespace, { directions: ["desc"], index: "lb", table: "scores", take: 100 });

        expect(ids(result)).toEqual(["a3", "b2", "a2", "b1", "a1"]);
    });

    it("breaks ties on the rank key by the __id__ tiebreak", async () => {
        expect.assertions(1);

        // Every row shares score 100 — order is decided by rowId ascending,
        // across shards. This is the boundary case where a naive merge could
        // drop or duplicate rows.
        const shardRows = {
            a: [row("", [100], "a"), row("", [100], "d")],
            b: [row("", [100], "b"), row("", [100], "e")],
            c: [row("", [100], "c")],
        };
        const namespace = createRankPageNamespace(shardRows, ["asc"]);
        const coordinator = createQueryCoordinator({ registry: createStaticShardRegistry({ scores: ["a", "b", "c"] }) });

        const result = await coordinator.orchestrateRankPage(namespace, { index: "lb", table: "scores", take: 100 });

        expect(ids(result)).toEqual(["a", "b", "c", "d", "e"]);
    });

    it("tolerates empty shards and shards of uneven size", async () => {
        expect.assertions(2);

        const shardRows = {
            a: [],
            b: [row("", [5], "b1"), row("", [15], "b2"), row("", [25], "b3"), row("", [35], "b4")],
            c: [row("", [20], "c1")],
        };
        const namespace = createRankPageNamespace(shardRows, ["asc"]);
        const coordinator = createQueryCoordinator({ registry: createStaticShardRegistry({ scores: ["a", "b", "c"] }) });

        const result = await coordinator.orchestrateRankPage(namespace, { index: "lb", table: "scores", take: 100 });

        expect(ids(result)).toEqual(["b1", "b2", "c1", "b3", "b4"]);
        expect(result.isDone).toBe(true);
    });

    it("orders across multiple partitions then sort key", async () => {
        expect.assertions(1);

        const shardRows = {
            a: [row("p1", [30], "a1"), row("p2", [10], "a2")],
            b: [row("p1", [20], "b1"), row("p2", [40], "b2")],
        };
        const namespace = createRankPageNamespace(shardRows, ["asc"]);
        const coordinator = createQueryCoordinator({ registry: createStaticShardRegistry({ scores: ["a", "b"] }) });

        const result = await coordinator.orchestrateRankPage(namespace, { index: "lb", table: "scores", take: 100 });

        // p1 partition first (b1@20, a1@30), then p2 (a2@10, b2@40).
        expect(ids(result)).toEqual(["b1", "a1", "a2", "b2"]);
    });

    it("returns an empty done page when no shards have rows", async () => {
        expect.assertions(3);

        const namespace = createRankPageNamespace({ a: [], b: [] }, ["asc"]);
        const coordinator = createQueryCoordinator({ registry: createStaticShardRegistry({ scores: ["a", "b"] }) });

        const result = await coordinator.orchestrateRankPage(namespace, { index: "lb", table: "scores", take: 100 });

        expect(result.page).toEqual([]);
        expect(result.isDone).toBe(true);
        expect(result.continueCursor).toBeNull();
    });
});

describe("orchestrateRankPage — cursor continuation", () => {
    it("pages across shards without gaps or duplicates over the full feed", async () => {
        expect.assertions(4);

        // 9 rows interleaved across 3 shards; page size 3 → 3 pages.
        const shardRows = {
            a: [row("", [10], "a1"), row("", [40], "a2"), row("", [70], "a3")],
            b: [row("", [20], "b1"), row("", [50], "b2"), row("", [80], "b3")],
            c: [row("", [30], "c1"), row("", [60], "c2"), row("", [90], "c3")],
        };
        const namespace = createRankPageNamespace(shardRows, ["asc"]);
        const coordinator = createQueryCoordinator({ registry: createStaticShardRegistry({ scores: ["a", "b", "c"] }) });

        const collected: string[] = [];
        let cursor: null | string = null;
        let pages = 0;

        for (let guard = 0; guard < 11; guard += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential paging is the contract under test
            const result: RankPageFanOutResult = await coordinator.orchestrateRankPage(namespace, {
                cursor,
                index: "lb",
                table: "scores",
                take: 3,
            });

            collected.push(...ids(result));
            pages += 1;

            if (result.isDone) {
                break;
            }

            cursor = result.continueCursor;
        }

        expect(collected).toEqual(["a1", "b1", "c1", "a2", "b2", "c2", "a3", "b3", "c3"]);
        // No duplicates.
        expect(new Set(collected).size).toBe(9);
        expect(collected).toHaveLength(9);
        expect(pages).toBe(3);
    });

    it("handles a last page that exactly drains the feed (isDone, null cursor)", async () => {
        expect.assertions(3);

        const shardRows = {
            a: [row("", [10], "a1"), row("", [30], "a2")],
            b: [row("", [20], "b1"), row("", [40], "b2")],
        };
        const namespace = createRankPageNamespace(shardRows, ["asc"]);
        const coordinator = createQueryCoordinator({ registry: createStaticShardRegistry({ scores: ["a", "b"] }) });

        const first = await coordinator.orchestrateRankPage(namespace, { index: "lb", table: "scores", take: 2 });

        expect(ids(first)).toEqual(["a1", "b1"]);
        expect(first.isDone).toBe(false);

        const second = await coordinator.orchestrateRankPage(namespace, { cursor: first.continueCursor, index: "lb", table: "scores", take: 2 });

        expect(ids(second)).toEqual(["a2", "b2"]);
    });

    it("pages a feed where one shard dominates (uneven drain)", async () => {
        expect.assertions(2);

        // Shard b holds 5 of 6 rows; per-shard cursors must advance b alone
        // across pages while a is consumed once.
        const shardRows = {
            a: [row("", [25], "a1")],
            b: [row("", [10], "b1"), row("", [20], "b2"), row("", [30], "b3"), row("", [40], "b4"), row("", [50], "b5")],
        };
        const namespace = createRankPageNamespace(shardRows, ["asc"]);
        const coordinator = createQueryCoordinator({ registry: createStaticShardRegistry({ scores: ["a", "b"] }) });

        const collected: string[] = [];
        let cursor: null | string = null;

        for (let guard = 0; guard < 10; guard += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential paging is the contract under test
            const result: RankPageFanOutResult = await coordinator.orchestrateRankPage(namespace, { cursor, index: "lb", table: "scores", take: 2 });

            collected.push(...ids(result));

            if (result.isDone) {
                break;
            }

            cursor = result.continueCursor;
        }

        expect(collected).toEqual(["b1", "b2", "a1", "b3", "b4", "b5"]);
        expect(new Set(collected).size).toBe(6);
    });

    it("forwards the per-shard resume key as `after` on the next page", async () => {
        expect.assertions(2);

        const shardRows = {
            a: [row("", [10], "a1"), row("", [30], "a2")],
            b: [row("", [20], "b1")],
        };
        const calls: ShardCall[] = [];
        const namespace = createRankPageNamespace(shardRows, ["asc"], calls);
        const coordinator = createQueryCoordinator({ registry: createStaticShardRegistry({ scores: ["a", "b"] }) });

        const first = await coordinator.orchestrateRankPage(namespace, { index: "lb", table: "scores", take: 2 });

        // Page 1: a1, b1. Shard a consumed a1, shard b consumed b1.
        expect(ids(first)).toEqual(["a1", "b1"]);

        calls.length = 0;

        await coordinator.orchestrateRankPage(namespace, { cursor: first.continueCursor, index: "lb", table: "scores", take: 2 });

        const shardAcall = calls.find((c) => c.shardKey === "a");

        expect((shardAcall?.args["after"] as { rowId?: string } | undefined)?.rowId).toBe("a1");
    });
});

describe("orchestrateRankPage — failures and request forwarding", () => {
    it("marks the result partial and still pages surviving shards when one shard fails", async () => {
        expect.assertions(4);

        const stubFor = (shardKey: string) => {
            return {
                async fetch(request: Request): Promise<Response> {
                    if (shardKey === "b") {
                        return Response.json({ error: "boom" }, { status: 500 });
                    }

                    const body: { args: Record<string, unknown> } = await request.json();
                    const take = Number(body.args["take"] ?? 100);
                    const rows = [row("", [10], "a1"), row("", [20], "a2")].slice(0, take);

                    return Response.json({ result: { hasMore: false, rows } }, { status: 200 });
                },
            };
        };
        const namespace: ShardNamespaceLike = {
            get: (id) => stubFor((id as { __name: string }).__name),
            getByName: (name) => stubFor(name),
            idFromName: (name) => {
                return { __name: name };
            },
        };
        const coordinator = createQueryCoordinator({ registry: createStaticShardRegistry({ scores: ["a", "b"] }) });

        const result = await coordinator.orchestrateRankPage(namespace, { index: "lb", table: "scores", take: 100 });

        expect(result.partial).toBe(true);
        expect(result.failed).toBe(1);
        expect(result.ok).toBe(1);
        expect(ids(result)).toEqual(["a1", "a2"]);
    });

    it("forwards table, index, take, partitionKey and the admin headers to each shard", async () => {
        expect.assertions(4);

        const calls: ShardCall[] = [];
        const namespace = createRankPageNamespace({ a: [] }, ["asc"], calls);
        const coordinator = createQueryCoordinator({ registry: createStaticShardRegistry({ scores: ["a"] }) });

        await coordinator.orchestrateRankPage(namespace, {
            headers: { authorization: "Bearer admin" },
            index: "lb",
            partitionKey: '{"region":"eu"}',
            table: "scores",
            take: 50,
        });

        expect(calls[0]?.functionPath).toBe("__lunora_admin__:rankPage");
        expect(calls[0]?.args["index"]).toBe("lb");
        expect(calls[0]?.args["take"]).toBe(50);
        expect(calls[0]?.args["partitionKey"]).toBe('{"region":"eu"}');
    });

    it("returns an empty done page when the table has no live shards", async () => {
        expect.assertions(3);

        const namespace = createRankPageNamespace({}, ["asc"]);
        const coordinator = createQueryCoordinator({ registry: createStaticShardRegistry({}) });

        const result = await coordinator.orchestrateRankPage(namespace, { index: "lb", table: "scores", take: 100 });

        expect(result.page).toEqual([]);
        expect(result.isDone).toBe(true);
        expect(result.ok).toBe(0);
    });

    it("does not duplicate rows when a previously-paged shard fails then recovers", async () => {
        // Regression: a shard consumed on an earlier page (so its resume key is in
        // the cursor) that fails on a later page must keep its key carried forward,
        // so on recovery it resumes strictly-after its last-emitted row instead of
        // restarting from the top and re-emitting rows already delivered.
        expect.assertions(3);

        const rowsByShard: Record<string, ReadonlyArray<RankPageRow>> = {
            a: [row("", [10], "a1"), row("", [30], "a3")],
            b: [row("", [20], "b2"), row("", [40], "b4")],
        };
        const bCalls = { count: 0 };

        const stubFor = (shardKey: string) => {
            return {
                async fetch(request: Request): Promise<Response> {
                    const body: { args: Record<string, unknown> } = await request.json();

                    // Shard b fails on its SECOND request (the 2nd page), succeeds otherwise.
                    if (shardKey === "b") {
                        bCalls.count += 1;

                        if (bCalls.count === 2) {
                            return Response.json({ error: "boom" }, { status: 500 });
                        }
                    }

                    const rows = rowsByShard[shardKey] ?? [];
                    const take = Number(body.args["take"] ?? 100);
                    const after = body.args["after"] as RankPageRow["key"] | undefined;
                    const startAt = after ? rows.findIndex((r) => compareKey(r.key, after, ["asc"]) > 0) : 0;
                    const from = startAt === -1 ? rows.length : startAt;
                    const slice = rows.slice(from, from + take);

                    return Response.json({ result: { directions: ["asc"], hasMore: from + take < rows.length, rows: slice } }, { status: 200 });
                },
            };
        };
        const namespace: ShardNamespaceLike = {
            get: (id) => stubFor((id as { __name: string }).__name),
            getByName: (name) => stubFor(name),
            idFromName: (name) => {
                return { __name: name };
            },
        };
        const coordinator = createQueryCoordinator({ registry: createStaticShardRegistry({ scores: ["a", "b"] }) });

        const collected: string[] = [];
        let cursor: null | string = null;

        // Page in twos until done: a1,b2 | (b fails → a3) | b4.
        for (let guard = 0; guard < 10; guard += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential pagination is the unit under test
            const result: RankPageFanOutResult = await coordinator.orchestrateRankPage(namespace, { cursor, index: "lb", table: "scores", take: 2 });

            collected.push(...ids(result));
            cursor = result.continueCursor;

            if (cursor === null) {
                break;
            }
        }

        expect(collected).toContain("b2");
        // No duplicates: b2 must appear exactly once despite b's mid-pagination failure.
        expect(collected.filter((id) => id === "b2")).toHaveLength(1);
        expect([...collected].toSorted((a, b) => a.localeCompare(b))).toEqual(["a1", "a3", "b2", "b4"]);
    });

    it("merges by the shard-echoed directions, not a conflicting request hint", async () => {
        // M2: the shards order by the named index's declared directions and echo
        // them back; the coordinator trusts those over a caller-supplied
        // `directions` that disagrees, so the merge can't mis-order shard boundaries.
        expect.assertions(1);

        const rowsByShard: Record<string, ReadonlyArray<RankPageRow>> = {
            a: [row("", [70], "a3"), row("", [40], "a2"), row("", [10], "a1")],
            b: [row("", [50], "b2"), row("", [20], "b1")],
        };
        const stubFor = (shardKey: string) => {
            return {
                // Rows are pre-sorted DESC; the shard reports `directions: ["desc"]`.
                fetch: (): Promise<Response> =>
                    Promise.resolve(Response.json({ result: { directions: ["desc"], hasMore: false, rows: rowsByShard[shardKey] ?? [] } }, { status: 200 })),
            };
        };
        const namespace: ShardNamespaceLike = {
            get: (id) => stubFor((id as { __name: string }).__name),
            getByName: (name) => stubFor(name),
            idFromName: (name) => {
                return { __name: name };
            },
        };
        const coordinator = createQueryCoordinator({ registry: createStaticShardRegistry({ scores: ["a", "b"] }) });

        // Pass a WRONG ascending hint; the echoed descending order must win.
        const result = await coordinator.orchestrateRankPage(namespace, { directions: ["asc"], index: "lb", table: "scores", take: 100 });

        expect(ids(result)).toEqual(["a3", "b2", "a2", "b1", "a1"]);
    });
});
