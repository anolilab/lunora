import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sqliteDialect } from "@lunora/d1";
import type { SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import type { SqlCtxExec } from "@lunora/sql-store";
import { createSqlCtxDb } from "@lunora/sql-store";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createNodeGlobalStore, createNodeSqlExec } from "../src/node-global-store";

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

            const document = await writer.get("notes", id);

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

            const document = await second.writer({ schema }).get("notes", id);

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

            const writerA = createSqlCtxDb({ dialect: sqliteDialect, exec: gated, schema: searchSchema }).patch("docs", "x", { body: "two" });

            await reachedHold;
            await createSqlCtxDb({ dialect: sqliteDialect, exec, schema: searchSchema }).patch("docs", "x", { body: "three" });
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

    it("commits a row and its counter together, and keeps other writers out of the open transaction", async () => {
        expect.assertions(4);

        const tallies = {
            tables: {
                tallies: {
                    aggregateIndexes: [{ by: ["org"], name: "countByOrg", on: "tallies", op: "count" }],
                    indexes: [],
                    shape: { org: col("string") },
                    shardMode: { kind: "global" },
                },
            },
        } as never as SchemaLike;
        const store = createNodeGlobalStore();

        try {
            await store.migrate(tallies);

            let armed = false;
            let release: () => void = () => undefined;
            const held = new Promise<void>((resolve) => {
                release = resolve;
            });
            let reachedCompanion: () => void = () => undefined;
            const atCompanion = new Promise<void>((resolve) => {
                reachedCompanion = resolve;
            });
            // Parks the companion write inside the transaction, then fails it.
            const failing = (inner: SqlCtxExec): SqlCtxExec => {
                return {
                    ...inner,
                    // The sqlite dialect sends a write's companion statements as one `batch`.
                    batch: async (statements) => {
                        if (armed && statements.some((statement) => statement.sql.includes("__agg_"))) {
                            reachedCompanion();
                            await held;

                            throw new Error("injected companion failure");
                        }

                        await inner.batch?.(statements);
                    },
                    ...(inner.transaction === undefined
                        ? {}
                        : {
                              transaction: async <T>(work: (tx: SqlCtxExec) => Promise<T>): Promise<T> =>
                                  await (inner.transaction as NonNullable<SqlCtxExec["transaction"]>)(async (tx) => await work(failing(tx))),
                          }),
                };
            };
            let issued: () => void = () => undefined;
            const bystanderIssued = new Promise<void>((resolve) => {
                issued = resolve;
            });
            const writer = createSqlCtxDb({ clock: () => 1, dialect: sqliteDialect, exec: failing(store.exec), schema: tallies });
            const bystander = createSqlCtxDb({
                clock: () => 1,
                dialect: sqliteDialect,
                exec: {
                    ...store.exec,
                    all: async (statement, parameters) => {
                        if (armed) {
                            issued();
                        }

                        return await store.exec.all(statement, parameters);
                    },
                    run: async (statement, parameters) => {
                        if (armed) {
                            issued();
                        }

                        return await store.exec.run(statement, parameters);
                    },
                    transaction: async (work) => {
                        if (armed) {
                            issued();
                        }

                        return await (store.exec.transaction as NonNullable<SqlCtxExec["transaction"]>)(work);
                    },
                },
                schema: tallies,
            });

            await writer.insert("tallies", { org: "a" });
            // Provisioned and backfilled already, so its next insert goes straight to the row write.
            await bystander.count("tallies", { org: "b" });
            armed = true;

            const failed = writer.insert("tallies", { org: "a" });

            await atCompanion;

            // Issued while the failing insert's transaction is open; it must not land in it and be rolled back with it.
            const other = bystander.insert("tallies", { org: "b" });

            await bystanderIssued;
            release();

            await expect(failed).rejects.toThrow("injected companion failure");

            await other;

            expect(store.database.prepare("SELECT org FROM tallies ORDER BY org").all()).toStrictEqual([{ org: "a" }, { org: "b" }]);
            await expect(bystander.count("tallies", { org: "a" })).resolves.toBe(1);
            await expect(bystander.count("tallies", { org: "b" })).resolves.toBe(1);
        } finally {
            store.dispose();
        }
    });
});

describe("createNodeSqlExec — one connection, several wrappers", () => {
    it("keeps a second wrapper's write out of the first wrapper's open transaction", async () => {
        expect.assertions(2);

        const database = new Database(":memory:");

        try {
            database.exec("CREATE TABLE notes (body TEXT)");

            const first = createNodeSqlExec(database);
            const second = createNodeSqlExec(database);
            let release: () => void = () => undefined;
            const held = new Promise<void>((resolve) => {
                release = resolve;
            });
            let entered: () => void = () => undefined;
            const inside = new Promise<void>((resolve) => {
                entered = resolve;
            });
            const rolledBack = (first.transaction as NonNullable<SqlCtxExec["transaction"]>)(async (tx) => {
                await tx.run("INSERT INTO notes (body) VALUES (?)", ["rolled back"]);
                entered();
                await held;

                throw new Error("abort");
            });

            await inside;

            // Issued while the first wrapper's transaction is open: it must wait for it, not land inside it.
            const survivor = second.run("INSERT INTO notes (body) VALUES (?)", ["kept"]);

            release();

            await expect(rolledBack).rejects.toThrow("abort");

            await survivor;

            expect(database.prepare("SELECT body FROM notes").all()).toStrictEqual([{ body: "kept" }]);
        } finally {
            database.close();
        }
    });

    it("leaves a transaction the caller opened on the connection alone when its own begin is refused", async () => {
        expect.assertions(3);

        const database = new Database(":memory:");

        try {
            database.exec("CREATE TABLE notes (body TEXT)");
            database.exec("BEGIN");
            database.prepare("INSERT INTO notes (body) VALUES (?)").run("caller's");

            const exec = createNodeSqlExec(database);

            // SQLite refuses a nested BEGIN; that refusal is not a transaction this wrapper owns.
            await expect(
                (exec.transaction as NonNullable<SqlCtxExec["transaction"]>)(async () => {
                    await Promise.resolve();
                }),
            ).rejects.toThrow(/within a transaction/u);

            expect(database.inTransaction).toBe(true);

            database.exec("COMMIT");

            expect(database.prepare("SELECT body FROM notes").all()).toStrictEqual([{ body: "caller's" }]);
        } finally {
            database.close();
        }
    });
});
