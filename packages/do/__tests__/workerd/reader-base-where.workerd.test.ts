/**
 * The fluent reader's `baseWhere` (#822) on real workerd SQLite.
 *
 * `rls()` hands the reader its read policy so the policy lands in the SQL of
 * every terminal instead of an in-memory `.filter()` that forced a read of the
 * whole index range. `node:sqlite` builds with `SQLITE_DQS=0`, so a reference
 * that resolves to nothing fails loudly there and reads as a string literal
 * here — this runs the plain, keyset-page, FTS5 and geo statements the policy
 * joins into on the SQLite a Durable Object actually gets, and counts
 * `rowsRead` for the bounded ones.
 */
import type { SchemaLike, SqlCursor, SqlExec } from "@lunora/shard-engine";
import { createShardCtxDb, runShardMigrations } from "@lunora/shard-engine";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const schema = {
    tables: {
        notes: {
            geoIndexes: [{ field: "location", name: "by_location" }],
            indexes: [
                { fields: ["userId", "status"], name: "by_user_and_status" },
                { fields: ["status"], name: "by_status" },
            ],
            searchIndexes: [{ field: "body", filterFields: [], name: "by_body" }],
            shape: {
                body: { kind: "string" },
                location: { kind: "geoPoint" },
                status: { kind: "string" },
                userId: { kind: "string" },
            },
        },
    },
} as unknown as SchemaLike;

const POLICY = { baseWhere: { userId: "u1" } };

/** The object's SQLite as a `SqlExec`, adding up `rowsRead` for every SELECT against `notes`. */
const metered = (sql: SqlStorage): { exec: SqlExec; rowsRead: () => number } => {
    let total = 0;

    return {
        exec: {
            exec: <Row = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlCursor<Row> => {
                const cursor = sql.exec(query, ...bindings);

                if (query.startsWith("SELECT") && query.includes(`FROM "notes"`)) {
                    const rows = cursor.toArray();

                    total += cursor.rowsRead;

                    return { one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator](), toArray: () => rows } as unknown as SqlCursor<Row>;
                }

                return cursor as unknown as SqlCursor<Row>;
            },
        },
        rowsRead: () => total,
    };
};

describe("reader baseWhere on workerd", () => {
    it("pushes the policy into every terminal, keeping LIMIT and excluding hidden rows", async () => {
        expect.assertions(8);

        const stub = env.SHARD.get(env.SHARD.idFromName("reader-base-where"));

        await runInDurableObject(stub, async (_instance, state) => {
            const { exec, rowsRead } = metered(state.storage.sql);

            runShardMigrations(exec, schema);

            const db = createShardCtxDb({ schema, sql: exec });
            const location = { lat: 52.52, lng: 13.405 };

            for (let n = 0; n < 300; n += 1) {
                // eslint-disable-next-line no-await-in-loop -- seeded in order
                await db.insert("notes", { body: `shared ${String(n)}`, location, status: "active", userId: n % 2 === 0 ? "u1" : "u2" });
            }

            const range = () => db.query("notes", POLICY).withIndex("by_status", (q) => q.eq("status", "active"));
            const before = rowsRead();
            const take = await range().take(5);
            const takeRows = rowsRead() - before;

            // Half the range is u2's; the LIMIT still returns five of u1's, read in about five rows.
            expect(take.map((row) => row["userId"])).toStrictEqual(["u1", "u1", "u1", "u1", "u1"]);
            expect(takeRows).toBeLessThan(20);

            // Keyset pages across cursor boundaries: every admitted row exactly once.
            const paged: unknown[] = [];
            let cursor: null | string = null;

            for (let pages = 0; pages < 100; pages += 1) {
                // eslint-disable-next-line no-await-in-loop -- each page's cursor comes from the previous one
                const page = await range().paginate({ cursor, numItems: 7 });

                paged.push(...page.page.map((row) => row["_id"]));

                if (page.isDone || page.continueCursor === null) {
                    break;
                }

                cursor = page.continueCursor;
            }

            const all = await range().collect();

            expect(paged).toStrictEqual(all.map((row) => row["_id"]));
            expect(all).toHaveLength(150);
            expect(all.every((row) => row["userId"] === "u1")).toBe(true);

            const hits = await db
                .query("notes", POLICY)
                .withSearchIndex("by_body", (q) => q.search("body", "shared"))
                .take(10);
            const near = await db
                .query("notes", POLICY)
                .withGeoIndex("by_location", (q) => q.near(location, 1000))
                .collect();

            expect(hits.every((row) => row["userId"] === "u1")).toBe(true);
            expect(hits).toHaveLength(10);
            expect(near.every((row) => row["userId"] === "u1") && near.length === 150).toBe(true);
        });
    });
});
