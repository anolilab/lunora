import type { DatabaseWriterLike, QueryPage, SchemaLike } from "@lunora/shard-engine";
import { RELATION_FUNCTION_PREFIX } from "@lunora/shard-engine";
import { describe, expect, it, vi } from "vitest";

import { serveRelationFanout } from "../src/relation-fanout";

/**
 * Unit cover for the reverse cross-backend relation per-shard reader. This is the
 * body of the codegen-emitted `ShardDO.runRelationFanoutRead` override, extracted
 * into `@lunora/do` precisely so the guard branches and the read/count dispatch
 * are testable without compiling generated output.
 */
const schema: SchemaLike = {
    tables: {
        // `.global()` table — must be rejected (it lives in D1, not a shard).
        channels: { indexes: [], shape: {}, shardMode: { kind: "global" } },
        // Shard-local child the reverse relation reads across shards.
        local: { indexes: [], shape: {}, shardMode: { kind: "root" } },
    },
};

const pageOf = (rows: Record<string, unknown>[]): QueryPage => {
    return { continueCursor: null, isDone: true, page: rows };
};

/** Minimal `DatabaseWriterLike` stub — `serveRelationFanout` only calls `findMany`/`count`. */
const stubWriter = (impl: Pick<DatabaseWriterLike, "count" | "findMany">): DatabaseWriterLike => impl as DatabaseWriterLike;

const READ = `${RELATION_FUNCTION_PREFIX}read`;
const COUNT = `${RELATION_FUNCTION_PREFIX}count`;

describe("serveRelationFanout", () => {
    it("serves `:read` as the bare child-row array, forwarding where/orderBy/with", async () => {
        expect.assertions(3);

        const findMany = vi.fn<DatabaseWriterLike["findMany"]>(async () => pageOf([{ _id: "l1" }, { _id: "l2" }]));
        const db = stubWriter({ count: async () => 0, findMany });

        const result = await serveRelationFanout(schema, db, READ, {
            orderBy: [{ name: "asc" }],
            table: "local",
            where: { globalId: { in: ["g1"] } },
            with: { owner: true },
        });

        expect(result).toEqual([{ _id: "l1" }, { _id: "l2" }]);
        expect(findMany).toHaveBeenCalledWith(
            "local",
            expect.objectContaining({ orderBy: [{ name: "asc" }], where: { globalId: { in: ["g1"] } }, with: { owner: true } }),
        );
        // The page envelope is unwrapped — callers fan out bare arrays for `concat`.
        expect(Array.isArray(result)).toBe(true);
    });

    it("rebuilds `relationBaseWhere` from `relationPolicies` so NESTED `with` hops stay RLS-filtered", async () => {
        expect.assertions(2);

        // `database` here is the RAW ctx-db — it applies no read policy of its own.
        // The nested hops' policies arrive as data and must be turned back into the
        // `relationBaseWhere` the relation loader threads down each level, or a
        // deep `with` chain reads children the caller has no policy over.
        const findMany = vi.fn<DatabaseWriterLike["findMany"]>(async () => pageOf([]));
        const db = stubWriter({ count: async () => 0, findMany });

        await serveRelationFanout(schema, db, READ, {
            relationPolicies: { local: { ownerId: "u1" } },
            table: "local",
            where: { globalId: { in: ["g1"] } },
            with: { owner: true },
        });

        const relationBaseWhere = findMany.mock.calls[0]?.[1]?.relationBaseWhere;

        expect(relationBaseWhere?.("local")).toEqual({ ownerId: "u1" });
        expect(relationBaseWhere?.("unpoliced")).toBeUndefined();
    });

    it("serves `:count` as a bare number, forwarding the where filter", async () => {
        expect.assertions(2);

        const count = vi.fn<DatabaseWriterLike["count"]>(async () => 7);
        const db = stubWriter({ count, findMany: async () => pageOf([]) });

        const result = await serveRelationFanout(schema, db, COUNT, { table: "local", where: { globalId: "g1" } });

        expect(result).toBe(7);
        expect(count).toHaveBeenCalledWith("local", { globalId: "g1" });
    });

    it("rejects an unknown table with a 404", async () => {
        expect.assertions(1);

        const db = stubWriter({ count: async () => 0, findMany: async () => pageOf([]) });

        await expect(serveRelationFanout(schema, db, READ, { table: "nope" })).rejects.toMatchObject({ status: 404 });
    });

    it("rejects a `.global()` table — it lives in D1, not a shard — with a 400", async () => {
        expect.assertions(2);

        const findMany = vi.fn<DatabaseWriterLike["findMany"]>(async () => pageOf([]));
        const db = stubWriter({ count: async () => 0, findMany });

        await expect(serveRelationFanout(schema, db, READ, { table: "channels" })).rejects.toMatchObject({ status: 400 });
        // The guard fires before any read.
        expect(findMany).not.toHaveBeenCalled();
    });
});
