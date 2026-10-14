import type { ColumnMetaLike, DatabaseWriterLike, SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createD1CtxDb as createD1ContextDatabase } from "../src/d1-ctx-db";
import { createD1Exec } from "./_helpers/node-sqlite-d1";

/**
 * Reverse cross-backend relation loading: a `.global()` (D1) parent loading a
 * shard-local child relation. The child's rows live across every shard DO, so
 * the D1 ctx-db routes the child's read/count to the injected
 * `crossShardReader` / `crossShardCounter` (wired by the host to the Query
 * Coordinator's RLS-correct fan-out). Here those capabilities are faked so the
 * routing + grouping is exercised without a real coordinator.
 */
const col = (kind: string, column: Partial<ColumnMetaLike> = {}): ValidatorLike => {
    return { _meta: { column: { notNull: true, ...column } }, kind };
};

// `globals` (global, D1) → `local` (shard-local, root): a `one` (owner) + a
// `many` (items) relation, both pointing at the cross-backend child.
const reverseSchema: SchemaLike = {
    tables: {
        globals: {
            indexes: [],
            relationMap: {
                items: { field: "globalId", kind: "many", references: "_id", table: "local" },
                owner: { field: "ownerId", kind: "one", references: "_id", table: "local" },
            },
            shape: { ownerId: col("string", { notNull: false }) },
            shardMode: { kind: "global" },
        },
        local: { indexes: [], shape: { globalId: col("string"), name: col("string") }, shardMode: { kind: "root" } },
    },
};

let harness: ReturnType<typeof createD1Exec>;

const seedParent = async (writer: DatabaseWriterLike): Promise<void> => {
    harness.ddl(`CREATE TABLE "globals" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "_version" INTEGER, "ownerId" TEXT)`);
    await writer.insert("globals", { _id: "g1", ownerId: "l1" }, { allowExplicitId: true });
};

describe("d1 reverse cross-backend relation loading", () => {
    beforeEach(() => {
        harness = createD1Exec();
    });

    afterEach(() => {
        harness.close();
    });

    it("loads a `one` shard-local relation through the injected crossShardReader", async () => {
        expect.assertions(2);

        const reads: string[] = [];
        const writer = createD1ContextDatabase({
            crossShardReader: async (table) => {
                reads.push(table);

                return { continueCursor: null, isDone: true, page: [{ _id: "l1", globalId: null, name: "Local One" }] };
            },
            exec: harness.exec,
            schema: reverseSchema,
        });

        await seedParent(writer);
        const { page } = await writer.findMany("globals", { with: { owner: true } });

        expect(reads).toEqual(["local"]);
        expect(page[0]).toMatchObject({ _id: "g1", owner: { _id: "l1", name: "Local One" } });
    });

    it("carries the child's RLS filters ACROSS the hop (folded `where` + `relationPolicies`)", async () => {
        expect.assertions(2);

        // The hop is a JSON envelope, so the relation loader's two RLS carriers
        // can't ride along as functions/extra args. Dropping them is not lossy —
        // the serving shard reads through its RAW ctx-db, so an unfiltered
        // `where` returns every child row for the FK regardless of the policy.
        let seen: Record<string, unknown> | undefined;

        const writer = createD1ContextDatabase({
            crossShardReader: async (_table, args) => {
                seen = args as unknown as Record<string, unknown>;

                return { continueCursor: null, isDone: true, page: [] };
            },
            exec: harness.exec,
            schema: reverseSchema,
        });

        await seedParent(writer);
        await writer.findMany("globals", {
            relationBaseWhere: (table) => (table === "local" ? { ownerId: "u1" } : undefined),
            with: { items: true },
        });

        // The child's own read policy is ANDed into the `where` that crosses.
        expect(seen?.["where"]).toEqual({ AND: [{ ownerId: "u1" }, { globalId: { in: ["g1"] } }] });
        // …and the function form is projected to data for the NESTED `with` hops.
        expect(seen?.["relationPolicies"]).toEqual({ local: { ownerId: "u1" } });
    });

    it("rEFUSES a masked read with a nested `with` across the hop instead of serving it unmasked", async () => {
        expect.assertions(2);

        // A mask policy can't be projected into data the way `relationBaseWhere`
        // can (a custom `MaskFn` closes over the request), so the nested rows would
        // be hydrated on the serving shard where no mask exists. This hop's OWN
        // rows still mask fine — only the nested level is refused.
        let reads = 0;

        const writer = createD1ContextDatabase({
            crossShardReader: async () => {
                reads += 1;

                return { continueCursor: null, isDone: true, page: [] };
            },
            exec: harness.exec,
            schema: reverseSchema,
        });

        await seedParent(writer);

        await expect(
            writer.findMany("globals", {
                relationMask: (_table, rows) => rows,
                with: { items: { with: { owner: true } } },
            }),
        ).rejects.toMatchObject({ code: "MASK_UNSUPPORTED" });

        // Refused before the fan-out went out, not after the rows came back.
        expect(reads).toBe(0);
    });

    it("still serves a masked read with NO nested `with` across the hop", async () => {
        expect.assertions(1);

        const writer = createD1ContextDatabase({
            crossShardReader: async () => {
                return { continueCursor: null, isDone: true, page: [{ _id: "l2", globalId: "g1", name: "A" }] };
            },
            exec: harness.exec,
            schema: reverseSchema,
        });

        await seedParent(writer);

        const { page } = await writer.findMany("globals", {
            relationMask: (table, rows) =>
                table === "local"
                    ? rows.map((row) => {
                          return { ...row, name: null };
                      })
                    : rows,
            with: { items: true },
        });

        expect((page[0]?.["items"] as Record<string, unknown>[])[0]?.["name"]).toBeNull();
    });

    it("loads + groups a `many` shard-local relation through the injected crossShardReader", async () => {
        expect.assertions(1);

        const writer = createD1ContextDatabase({
            crossShardReader: async () => {
                return {
                    continueCursor: null,
                    isDone: true,
                    page: [
                        { _id: "l2", globalId: "g1", name: "A" },
                        { _id: "l3", globalId: "g1", name: "B" },
                    ],
                };
            },
            exec: harness.exec,
            schema: reverseSchema,
        });

        await seedParent(writer);
        const { page } = await writer.findMany("globals", { with: { items: true } });

        expect(page[0]?.["items"]).toHaveLength(2);
    });

    it("caps a `many` relation by its per-relation `limit` (best-effort across shards)", async () => {
        expect.assertions(1);

        const writer = createD1ContextDatabase({
            crossShardReader: async () => {
                return {
                    continueCursor: null,
                    isDone: true,
                    page: [
                        { _id: "l2", globalId: "g1", name: "A" },
                        { _id: "l3", globalId: "g1", name: "B" },
                        { _id: "l4", globalId: "g1", name: "C" },
                    ],
                };
            },
            exec: harness.exec,
            schema: reverseSchema,
        });

        await seedParent(writer);
        const { page } = await writer.findMany("globals", { with: { items: { limit: 2 } } });

        expect(page[0]?.["items"]).toHaveLength(2);
    });

    it("loads a `_count` of a shard-local relation through the injected crossShardCounter", async () => {
        expect.assertions(2);

        const counts: string[] = [];
        const writer = createD1ContextDatabase({
            crossShardCounter: async (table) => {
                counts.push(table);

                return 3;
            },
            exec: harness.exec,
            schema: reverseSchema,
        });

        await seedParent(writer);
        const { page } = await writer.findMany("globals", { with: { _count: { items: true } } });

        expect(counts).toEqual(["local"]);
        expect(page[0]?.["_count"]).toEqual({ items: 3 });
    });

    it("throws a clear cross-backend error when the cross-shard reader is absent", async () => {
        expect.assertions(1);

        const writer = createD1ContextDatabase({ exec: harness.exec, schema: reverseSchema });

        await seedParent(writer);

        await expect(writer.findMany("globals", { with: { owner: true } })).rejects.toThrow(/cannot load the shard-local relation 'local'/u);
    });

    it("throws a clear cross-backend error when the cross-shard counter is absent", async () => {
        expect.assertions(1);

        const writer = createD1ContextDatabase({ exec: harness.exec, schema: reverseSchema });

        await seedParent(writer);

        await expect(writer.findMany("globals", { with: { _count: { items: true } } })).rejects.toThrow(/cannot load the shard-local relation 'local'/u);
    });
});
