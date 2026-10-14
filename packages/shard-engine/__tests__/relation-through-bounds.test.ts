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

        it("fails closed when the join table holds more rows than the cap, even for few distinct owners", async () => {
            expect.assertions(1);

            // Four join rows, all for one owner: one distinct key, but four rows read before the cap could be checked.
            const fetcher = async (tableName: string): Promise<QueryPage> =>
                page(
                    tableName === "tags"
                        ? [{ _id: "t0" }]
                        : Array.from({ length: 4 }, () => {
                              return { postId: "p1" };
                          }),
                );

            await expect(resolve(fetcher)).rejects.toThrow(/matched at least 4 rows, exceeding the 3-key limit/u);
        });
    });
});
