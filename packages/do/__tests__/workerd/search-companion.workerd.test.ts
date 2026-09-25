/**
 * The Durable Object's FTS5 search companion on real workerd SQLite.
 *
 * `node:sqlite` builds vary in whether they carry FTS5 at all, and the shard
 * engine's own FTS5 suite can only assert the SQL it renders. This runs that SQL
 * against the SQLite a Durable Object actually gets, and measures what a write
 * costs there: FTS5 cannot index the `__id__` column it joins back on, so a
 * write that finds a document's row by that column reads the whole companion.
 */
import type { SchemaLike, SqlCursor, SqlExec } from "@lunora/shard-engine";
import { backfillSearchIndexes, createShardCtxDb, runShardMigrations } from "@lunora/shard-engine";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const INDEX = { field: "body", filterFields: [], name: "by_body" };
const COMPANION = "docs__fts_by_body";

const schemaWith = (searchIndexes: unknown[]): SchemaLike =>
    ({ tables: { docs: { indexes: [], searchIndexes, shape: { body: { kind: "string" } } } } }) as unknown as SchemaLike;

/** Run `body` inside a fresh Durable Object, handing it that object's SQLite. */
const withSql = async (name: string, body: (sql: SqlStorage) => Promise<void>): Promise<void> => {
    const stub = env.SHARD.get(env.SHARD.idFromName(name));

    await runInDurableObject(stub, async (_instance, state) => {
        await body(state.storage.sql);
    });
};

/** The object's SQLite as a `SqlExec`, adding up `rowsRead` for every write that touches the companion. */
const metered = (sql: SqlStorage): { exec: SqlExec; reset: () => void; rowsRead: () => number } => {
    let total = 0;

    return {
        exec: {
            exec: <Row = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlCursor<Row> => {
                const cursor = sql.exec(query, ...bindings);

                if (query.includes(`"${COMPANION}`) && !query.startsWith("SELECT") && !query.startsWith("CREATE")) {
                    cursor.toArray();
                    total += cursor.rowsRead;
                }

                return cursor as unknown as SqlCursor<Row>;
            },
        },
        reset: () => {
            total = 0;
        },
        rowsRead: () => total,
    };
};

const companionRows = (sql: SqlStorage, id: string): number =>
    sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM "${COMPANION}" WHERE "${COMPANION}"."__id__" = ?`, id).one().n;

describe("durable object fts5 search companion on workerd", () => {
    it("reads a bounded number of companion rows per write, however large the companion", async () => {
        expect.assertions(3);

        const cost = async (size: number): Promise<number> => {
            let measured = -1;

            await withSql(`search-cost-${String(size)}`, async (storage) => {
                const { exec, reset, rowsRead } = metered(storage);

                runShardMigrations(exec, schemaWith([]));

                const plain = createShardCtxDb({ schema: schemaWith([]), sql: exec });

                for (let n = 0; n < size; n += 1) {
                    // eslint-disable-next-line no-await-in-loop -- seeded in order
                    await plain.insert("docs", { _id: `d${String(n).padStart(5, "0")}`, body: `word${String(n)} common` }, { allowExplicitId: true });
                }

                runShardMigrations(exec, schemaWith([INDEX]));
                backfillSearchIndexes(exec, schemaWith([INDEX]));

                const writer = createShardCtxDb({ schema: schemaWith([INDEX]), sql: exec });

                reset();
                await writer.patch("d00005", { body: "changed text" });
                await writer.delete("d00007");
                measured = rowsRead();
            });

            return measured;
        };

        const small = await cost(100);
        const large = await cost(2000);

        // eslint-disable-next-line no-console -- the measurement is the point of this test
        console.info(`DO companion rowsRead for one patch + one delete: 100 rows -> ${String(small)}, 2000 rows -> ${String(large)}`);

        expect(small).toBeGreaterThan(0);
        expect(large).toBeLessThan(50);
        expect(large).toBe(small);
    });

    it("adopts a companion built before the rowid map, dropping a duplicate row", async () => {
        expect.assertions(4);

        await withSql("search-legacy", async (sql) => {
            const exec = sql as unknown as SqlExec;

            runShardMigrations(exec, schemaWith([]));

            const plain = createShardCtxDb({ schema: schemaWith([]), sql: exec });

            await plain.insert("docs", { _id: "a", body: "apple common" }, { allowExplicitId: true });
            await plain.insert("docs", { _id: "b", body: "berry common" }, { allowExplicitId: true });

            // The shape a previous build left: auto rowids, no map, and a doubled row.
            sql.exec(`CREATE VIRTUAL TABLE "${COMPANION}" USING fts5("__text__", "__id__" UNINDEXED)`);
            sql.exec(`INSERT INTO "${COMPANION}" ("__text__", "__id__") VALUES ('apple common', 'a'), ('berry common', 'b'), ('apple common', 'a')`);

            // `staged`, so no backfill page rewrites the rows first: adoption is
            // the only thing that can have dropped the duplicate.
            const staged = schemaWith([{ ...INDEX, staged: true }]);

            runShardMigrations(exec, staged);

            expect(companionRows(sql, "a")).toBe(1);
            expect(companionRows(sql, "b")).toBe(1);

            const writer = createShardCtxDb({ schema: staged, sql: exec });

            await writer.patch("a", { body: "cherry common" });
            await writer.delete("b");

            expect(companionRows(sql, "a")).toBe(1);
            expect(companionRows(sql, "b")).toBe(0);
        });
    });
});
