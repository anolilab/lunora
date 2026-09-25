import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sqliteDialect } from "@lunora/d1";
import type { SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import type { SqlCtxExec } from "@lunora/sql-store";
import { createSqlCtxDb } from "@lunora/sql-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createNodeGlobalStore } from "../src/node-global-store";

/**
 * End-to-end coverage for the `.global()` backend on the Node target.
 *
 * `@lunora/sql-store` already proves the dialect-blind store core against a
 * hand-rolled SQLite dialect, and `@lunora/d1` proves the D1 binding. What is
 * unproven until here is that *this package's* assembly — the reference
 * `sqliteDialect` bound to a `better-sqlite3` exec, in its own database file —
 * actually provisions tables and round-trips documents. `globalTables` moves
 * from `unsupported` to a real rating on the strength of this file, so it
 * asserts behaviour rather than wiring.
 */

const col = (kind: string, extra: Record<string, unknown> = {}): ValidatorLike => {
    return { _meta: { column: { notNull: true, ...extra } }, kind };
};

const schema: SchemaLike = {
    tables: {
        notes: {
            indexes: [],
            shape: {
                archived: col("boolean"),
                body: col("string"),
                priority: col("number"),
                slug: col("string", { unique: true }),
            },
            shardMode: { kind: "global" },
        },
    },
} as never;

describe("createNodeGlobalStore", () => {
    let workdir: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-platform-node-global-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("provisions the schema's global tables and round-trips a document", async () => {
        expect.assertions(3);

        const store = createNodeGlobalStore();

        try {
            await store.migrate(schema);

            const writer = store.writer({ schema });
            const id = await writer.insert("notes", { archived: false, body: "hello", priority: 3, slug: "a" });

            expect(typeof id).toBe("string");

            const document = await writer.get(id);

            // Booleans and numbers come back in their JS forms, not as the
            // INTEGER/REAL SQLite stored them as — the value codec is wired.
            expect(document).toMatchObject({ archived: false, body: "hello", priority: 3, slug: "a" });
            expect(document?._id).toBe(id);
        } finally {
            store.dispose();
        }
    });

    it("is idempotent: migrating twice over the same file does not throw or lose rows", async () => {
        expect.assertions(1);

        const path = join(workdir, "global.sqlite3");
        const first = createNodeGlobalStore({ path });

        await first.migrate(schema);

        const id = await first.writer({ schema }).insert("notes", { archived: false, body: "kept", priority: 1, slug: "keep" });

        first.dispose();

        // A dev server re-runs migrations on every boot, so the second pass has
        // to be a no-op over an existing file rather than a failure or a reset.
        const second = createNodeGlobalStore({ path });

        try {
            await second.migrate(schema);

            const document = await second.writer({ schema }).get(id);

            expect(document).toMatchObject({ body: "kept", slug: "keep" });
        } finally {
            second.dispose();
        }
    });

    it("leaves no search entry unreachable when two writers of one document interleave", async () => {
        expect.assertions(2);

        const searchSchema: SchemaLike = {
            tables: {
                docs: {
                    indexes: [],
                    searchIndexes: [{ field: "body", filterFields: [], name: "by_body" }],
                    shape: { body: col("string") },
                    shardMode: { kind: "global" },
                },
            },
        } as never;
        const store = createNodeGlobalStore();

        try {
            await store.migrate(searchSchema);
            await store.writer({ schema: searchSchema }).insert("docs", { _id: "x", body: "one" }, { allowExplicitId: true });

            // Writer A is held just before it re-points the document's mapping,
            // and writer B rewrites the same document meanwhile. The store's own
            // exec, gated: a batch is held whole, as it runs whole.
            let release!: () => void;
            let reached!: () => void;
            const released = new Promise<void>((resolve) => {
                release = resolve;
            });
            const reachedHold = new Promise<void>((resolve) => {
                reached = resolve;
            });
            const gate = async (statements: ReadonlyArray<{ params: ReadonlyArray<unknown>; sql: string }>): Promise<void> => {
                if (statements.some(({ params, sql }) => sql.startsWith(`INSERT OR REPLACE INTO "docs__fts_by_body__ids"`) && params.includes("x"))) {
                    reached();
                    await released;
                }
            };
            const { exec } = store;
            const gated: SqlCtxExec = {
                all: exec.all,
                ...(exec.batch === undefined
                    ? {}
                    : {
                          batch: async (statements) => {
                              await gate(statements);
                              await exec.batch?.(statements);
                          },
                      }),
                run: async (sql, params) => {
                    await gate([{ params, sql }]);

                    return exec.run(sql, params);
                },
            };

            const writerA = createSqlCtxDb({ dialect: sqliteDialect, exec: gated, schema: searchSchema }).patch("x", { body: "two" });

            await reachedHold;
            await createSqlCtxDb({ dialect: sqliteDialect, exec, schema: searchSchema }).patch("x", { body: "three" });
            release();
            await writerA;

            const count = (where: string): number =>
                (store.database.prepare(`SELECT COUNT(*) AS n FROM "docs__fts_by_body" AS f WHERE ${where}`).get() as { n: number }).n;

            expect(count(`f."__id__" = 'x'`)).toBe(1);
            // An entry the map does not point at can never be reached again.
            expect(
                count(
                    `f."__id__" <> '' AND NOT EXISTS (SELECT 1 FROM "docs__fts_by_body__ids" AS k WHERE k."__rowid__" = f.rowid AND k."__id__" = f."__id__")`,
                ),
            ).toBe(0);
        } finally {
            store.dispose();
        }
    });
});
