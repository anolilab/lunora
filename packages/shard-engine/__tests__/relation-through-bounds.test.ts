import { describe, expect, it, vi } from "vitest";

import { THROUGH_SCHEMA } from "../../../shared/through-cases";
import type { SchemaLike } from "../src/ctx-db";
import { resolveRelationPredicates } from "../src/relation-predicates";
import { MAX_LINK_ROWS, resolveWith } from "../src/relations";
import type { QueryArgs, QueryPage, ResolveWithOptions } from "../src/schema-types";

/**
 * What a many-to-many read asks the store for, with the store stubbed out: every hop must be bounded, so a join
 * table with a lot of rows cannot be materialised just to count keys or to find the targets of one page.
 */
const schema = THROUGH_SCHEMA as unknown as SchemaLike;

type Fetcher = ResolveWithOptions["fetcher"];
type GroupedCounter = ResolveWithOptions["groupedCounter"];

const page = (rows: Record<string, unknown>[]): QueryPage => {
    return { continueCursor: null, isDone: true, page: rows };
};

const links = (count: number): Record<string, unknown>[] =>
    Array.from({ length: count }, (_, index) => {
        return { _id: `l${String(index)}`, postId: "p1", tagId: `t${String(index)}` };
    });

describe("many-to-many read bounds", () => {
    it("reads the join rows of a page with a limit, even when the caller caps the relation", async () => {
        expect.assertions(2);

        const fetcher = vi.fn<Fetcher>(async (tableName: string, _args: QueryArgs) =>
            page(tableName === "post_tags" ? links(2) : [{ _id: "t0", label: "red" }]),
        );
        const parents: Record<string, unknown>[] = [{ _id: "p1" }];

        await resolveWith({ fetcher, groupedCounter: vi.fn<GroupedCounter>(), parents, schema, tableName: "posts", with: { tags: { limit: 1 } } });

        expect(fetcher.mock.calls.find(([tableName]) => tableName === "post_tags")?.[1].limit).toBe(MAX_LINK_ROWS + 1);
        expect(parents[0]?.["tags"]).toHaveLength(1);
    });

    it("fails closed rather than drop links when a page links more than the ceiling", async () => {
        expect.assertions(1);

        const fetcher = async (tableName: string): Promise<QueryPage> => page(tableName === "post_tags" ? links(MAX_LINK_ROWS + 1) : []);

        await expect(
            resolveWith({ fetcher, groupedCounter: vi.fn<GroupedCounter>(), parents: [{ _id: "p1" }], schema, tableName: "posts", with: { tags: true } }),
        ).rejects.toThrow(/more than 10000 join rows/u);
    });

    it("counts readable targets with one grouped count when the target shares the parent's store", async () => {
        expect.assertions(3);

        const fetcher = vi.fn<Fetcher>(async (tableName: string) => page(tableName === "post_tags" ? links(2) : []));
        const groupedCounter = vi.fn<GroupedCounter>(async () => new Map<unknown, number>([["t0", 1]]));
        const parents: Record<string, unknown>[] = [{ _id: "p1" }];

        await resolveWith({ fetcher, groupedCounter, parents, schema, tableName: "posts", with: { _count: { tags: true } } });

        // Only the join rows were read; the targets were counted, not hydrated.
        expect(fetcher.mock.calls.map(([tableName]) => tableName)).toStrictEqual(["post_tags"]);
        expect(groupedCounter).toHaveBeenCalledWith("tags", "_id", ["t0", "t1"], undefined);
        expect(parents[0]?.["_count"]).toStrictEqual({ tags: 1 });
    });

    it("reads the target rows instead when the target lives in another store", async () => {
        expect.assertions(2);

        const crossBackend = {
            tables: { ...THROUGH_SCHEMA.tables, tags: { ...THROUGH_SCHEMA.tables.tags, shardMode: { kind: "global" } } },
        } as unknown as SchemaLike;
        const fetcher = vi.fn<Fetcher>(async (tableName: string) => page(tableName === "post_tags" ? links(2) : [{ _id: "t0", label: "red" }]));
        const groupedCounter = vi.fn<GroupedCounter>();
        const parents: Record<string, unknown>[] = [{ _id: "p1" }];

        await resolveWith({ fetcher, groupedCounter, parents, schema: crossBackend, tableName: "posts", with: { _count: { tags: true } } });

        expect(groupedCounter).not.toHaveBeenCalled();
        expect(parents[0]?.["_count"]).toStrictEqual({ tags: 1 });
    });

    describe("some / every / none", () => {
        const resolve = async (fetcher: (tableName: string, args: QueryArgs) => Promise<QueryPage>) =>
            resolveRelationPredicates({ tags: { some: { label: "red" } } }, { fetcher, maxRelationKeys: 3, schema, tableName: "posts" });

        it("bounds each hop to one row past the key cap", async () => {
            expect.assertions(2);

            const fetcher = vi.fn<Fetcher>(async (tableName: string, _args: QueryArgs) => page(tableName === "tags" ? [{ _id: "t0" }] : [{ postId: "p1" }]));

            await expect(resolve(fetcher)).resolves.toStrictEqual({ _id: { in: ["p1"] } });
            expect(fetcher.mock.calls.map(([, args]) => args.limit)).toStrictEqual([4, 4]);
        });

        it("resolves when the join table holds more rows than the cap for few distinct owners", async () => {
            expect.assertions(1);

            // Four join rows, all for one owner: one distinct key, well under a cap of three.
            const fetcher = async (tableName: string): Promise<QueryPage> =>
                page(
                    tableName === "tags"
                        ? [{ _id: "t0" }]
                        : Array.from({ length: 4 }, () => {
                              return { postId: "p1" };
                          }),
                );

            await expect(resolve(fetcher)).resolves.toStrictEqual({ _id: { in: ["p1"] } });
        });

        it("walks every page of join rows, so an owner that only appears on a later page still matches", async () => {
            expect.assertions(2);

            const fetcher = vi.fn<Fetcher>(async (tableName: string, args: QueryArgs): Promise<QueryPage> => {
                if (tableName === "tags") {
                    return page([{ _id: "t0" }]);
                }

                return args.cursor === undefined
                    ? {
                          continueCursor: "c1",
                          isDone: false,
                          page: Array.from({ length: 4 }, () => {
                              return { postId: "p1" };
                          }),
                      }
                    : page([{ postId: "p2" }]);
            });

            await expect(resolve(fetcher)).resolves.toStrictEqual({ _id: { in: ["p1", "p2"] } });
            expect(fetcher.mock.calls.filter(([tableName]) => tableName === "post_tags")[1]?.[1].cursor).toBe("c1");
        });

        it("fails closed once the distinct owners pass the cap, without reading the rest of the join table", async () => {
            expect.assertions(2);

            // Page two crosses the cap of three (four distinct owners), so the third page is never read.
            const joinPages: QueryPage[] = [
                { continueCursor: "c1", isDone: false, page: [{ postId: "p1" }, { postId: "p2" }] },
                { continueCursor: "c2", isDone: false, page: [{ postId: "p3" }, { postId: "p4" }] },
                page([{ postId: "p5" }]),
            ];
            let joinReads = 0;
            const fetcher = async (tableName: string): Promise<QueryPage> => {
                if (tableName === "tags") {
                    return page([{ _id: "t0" }]);
                }

                joinReads += 1;

                return joinPages[joinReads - 1] ?? page([]);
            };

            await expect(resolve(fetcher)).rejects.toThrow(/matched at least 4 distinct keys, exceeding the 3-key limit/u);
            expect(joinReads).toBe(2);
        });

        it("refuses a page larger than the limit it asked for, rather than trusting a store that ignored it", async () => {
            expect.assertions(1);

            const fetcher = async (tableName: string): Promise<QueryPage> =>
                tableName === "tags"
                    ? page([{ _id: "t0" }])
                    : page(
                          Array.from({ length: 5 }, (_, index) => {
                              return { postId: `p${String(index)}` };
                          }),
                      );

            await expect(resolve(fetcher)).rejects.toThrow(/did not honour the page limit/u);
        });

        it("refuses a page that is not final but names no cursor, rather than stopping short", async () => {
            expect.assertions(1);

            const fetcher = async (tableName: string): Promise<QueryPage> =>
                tableName === "tags" ? page([{ _id: "t0" }]) : { continueCursor: null, isDone: false, page: [{ postId: "p1" }] };

            await expect(resolve(fetcher)).rejects.toThrow(/no cursor to continue from/u);
        });

        it("refuses a cursor that does not advance, rather than re-reading the same page forever", async () => {
            expect.assertions(1);

            const fetcher = async (tableName: string): Promise<QueryPage> =>
                tableName === "tags" ? page([{ _id: "t0" }]) : { continueCursor: "c1", isDone: false, page: [{ postId: "p1" }] };

            await expect(resolve(fetcher)).rejects.toThrow(/cursor that did not advance/u);
        });
    });
});
