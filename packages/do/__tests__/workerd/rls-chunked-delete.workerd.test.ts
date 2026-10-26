/**
 * Chunked `deleteAll` / `deleteWhere` under `rls()` over the real `createShardCtxDb` writer on a live Durable Object's
 * SQLite. The writer publishes `deleteRereadTables`; the RLS wrapper re-locates the rows of those tables instead of
 * trusting the page image, so a row a set-null cascade just made policy-denied is refused (a `deleteAll`), while a
 * row a delete trigger pushed out of a `deleteWhere` filter is skipped — it is no longer a target of the erase.
 *
 * Not covered: a `.global()` table's re-read against real D1. The test worker binds no D1 database, so only the
 * published set is asserted for the global table; the page-to-delete race itself is covered with a fake writer in
 * `@lunora/server`.
 *
 * `rls()` is imported by relative source path because `@lunora/do` does not depend on `@lunora/server` (the same
 * route the shared `through-cases` fixture takes).
 */
import type { SchemaLike } from "@lunora/shard-engine";
import { createShardCtxDb, runShardMigrations } from "@lunora/shard-engine";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Leaf modules, not the `@lunora/server` barrel: the barrel re-exports packages this workerd job
// does not build (`@lunora/scheduler`, …), while these two reach only errors, shard-engine, values
// and search-core, all upstream of `@lunora/do`.
import { initLunora } from "../../../server/src/builder/index";
import { definePolicies, definePolicy, rls } from "../../../server/src/rls/index";

const lunora = initLunora.dataModel<Record<string, never>>().create();

// A node's delete is allowed only while it still has a parent; an item's only while it is not locked.
const policies = definePolicies([
    definePolicy({ on: "delete", table: "nodes", when: ({ row }: { row?: Record<string, unknown> }) => row?.["parentId"] != null }),
    definePolicy({ on: "delete", table: "items", when: ({ row }: { row?: Record<string, unknown> }) => row?.["state"] !== "locked" }),
    definePolicy({ on: "delete", table: "plain", when: () => true }),
]);

const schema = {
    tables: {
        // `.global()` is listed from the schema alone; the test worker has no D1 to read it against.
        g: { indexes: [], shape: { v: { kind: "string" } }, shardMode: { kind: "global" } },
        // Deleting a node nulls its children's `parentId` (self-referential set null).
        items: {
            indexes: [],
            shape: { nextId: { kind: "string" }, state: { kind: "string" } },
            // Deleting an item locks the item it points at, through the raw writer.
            triggerMap: {
                lockNext: {
                    handler: async (
                        context: { db: { patch: (id: string, patch: Record<string, unknown>) => Promise<void> } },
                        event: { previous?: Record<string, unknown> },
                    ) => {
                        const next = event.previous?.["nextId"];

                        if (typeof next === "string") {
                            await context.db.patch(next, { state: "locked" });
                        }
                    },
                    op: "delete",
                    timing: "after",
                },
            },
        },
        nodes: {
            indexes: [],
            relationMap: { parent: { field: "parentId", kind: "one", onDelete: "set null", references: "_id", table: "nodes" } },
            shape: { parentId: { kind: "string" } },
        },
        plain: { indexes: [], shape: { tag: { kind: "string" } } },
    },
} as unknown as SchemaLike;

type Writer = ReturnType<typeof createShardCtxDb>;

const withWriter = async (name: string, run: (writer: Writer) => Promise<void>): Promise<void> => {
    const stub = env.SHARD.get(env.SHARD.idFromName(`rls-chunked-delete-${name}`));

    await runInDurableObject(stub, async (_instance, state) => {
        const sql = { exec: state.storage.sql.exec.bind(state.storage.sql) } as never;

        runShardMigrations(sql, schema);
        // A mutation's writer: the transaction is open, so only listed tables re-locate (mirrors the DO dispatch).
        await run(createShardCtxDb({ inTransaction: () => true, schema, sql }));
    });
};

const eraseWith = (writer: Writer, erase: (db: any) => Promise<unknown>): Promise<unknown> => {
    const handler = lunora.mutation.use(rls(policies) as never).mutation(async ({ ctx }) => erase((ctx as { db: unknown }).db));

    return (handler as any).handler(
        {
            auth: {
                getIdentity: async () => {
                    return { roles: [], userId: "u1" };
                },
                userId: "u1",
            },
            db: writer,
        },
        {},
    );
};

describe("rls chunked deletes on workerd", () => {
    it("publishes the tables whose page image cannot be trusted", async () => {
        expect.assertions(1);

        await withWriter("published", async (writer) => {
            expect([...(writer.deleteRereadTables ?? [])].toSorted((left, right) => left.localeCompare(right))).toStrictEqual(["g", "items", "nodes"]);
        });
    });

    it("refuses the child a set-null cascade just orphaned, and keeps it", async () => {
        expect.assertions(3);

        await withWriter("nodes", async (writer) => {
            // Parent id sorts first: a same-millisecond insert ties on `_creationTime`, and the erase then pages by id.
            await writer.insert("nodes", { _id: "a", parentId: "root" }, { allowExplicitId: true });
            await writer.insert("nodes", { _id: "b", parentId: "a" }, { allowExplicitId: true });

            await expect(eraseWith(writer, (db) => db.deleteAll("nodes"))).rejects.toMatchObject({ code: "FORBIDDEN" });

            await expect(writer.get("nodes", "a")).resolves.toBeNull();

            const orphan = await writer.get("nodes", "b");

            expect(orphan?.["parentId"]).toBeNull();
        });
    });

    it("skips the row a delete trigger just locked — it left the caller's filter — and keeps it", async () => {
        expect.assertions(3);

        await withWriter("items", async (writer) => {
            await writer.insert("items", { _id: "i1", nextId: "i2", state: "open" }, { allowExplicitId: true });
            await writer.insert("items", { _id: "i2", state: "open" }, { allowExplicitId: true });

            // Deleting i1 fires the trigger, which locks i2. i2 no longer matches `{ state: "open" }`, so the
            // re-location's filtered read misses it and it is skipped (not deleted, not an abort).
            await expect(eraseWith(writer, (db) => db.deleteWhere("items", { state: "open" }))).resolves.toStrictEqual({ deleted: 1 });

            await expect(writer.get("items", "i1")).resolves.toBeNull();

            const locked = await writer.get("items", "i2");

            expect(locked?.["state"]).toBe("locked");
        });
    });

    it("erases a table outside the set in chunks and counts every row", async () => {
        expect.assertions(3);

        await withWriter("plain", async (writer) => {
            for (const id of ["a", "b", "c"]) {
                // eslint-disable-next-line no-await-in-loop -- seed in order
                await writer.insert("plain", { _id: id, tag: "x" }, { allowExplicitId: true });
            }

            await expect(eraseWith(writer, (db) => db.deleteAll("plain", { chunkSize: 2 }))).resolves.toStrictEqual({ deleted: 3 });
            await expect(writer.findMany("plain", {})).resolves.toMatchObject({ page: [] });
            expect(writer.deleteRereadTables?.has("plain")).toBe(false);
        });
    });
});
