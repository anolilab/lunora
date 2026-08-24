import { describe, expect, it } from "vitest";

import { createReferenceHost } from "../src/conformance";

/**
 * The reference host must answer a `PRAGMA` read with its rows.
 *
 * This is a regression test for a bug that was latent rather than theoretical.
 * The host buffered rows only for statements starting with `select`, so every
 * introspecting pragma came back as an empty cursor. That matters because the
 * engine's idempotent migrations are built on exactly this shape:
 *
 * The engine's migrations pragma-check for a column and then `ALTER TABLE … ADD
 * COLUMN` only when it is absent.
 *
 * An empty pragma reads as "the column is missing", so the guard fires the ALTER
 * against a table that already has the column and SQLite raises "duplicate
 * column name" — a migration failure caused entirely by the test host.
 * `runShardMigrations` hit it the moment a second pragma-guarded table existed;
 * the aggregate-companion migration (`__count__`) has the identical shape and
 * simply was never exercised through this host, so it would have hit it next.
 *
 * The distinction the fix rests on: an introspecting pragma (`table_info`,
 * `index_list`) returns rows like a SELECT, while a setter pragma
 * (`PRAGMA foreign_keys = ON`) returns none — and `.all()` on the latter is
 * harmless, so one branch serves both.
 */
describe("createReferenceHost PRAGMA reads", () => {
    it("returns rows for an introspecting pragma", () => {
        expect.assertions(2);

        const host = createReferenceHost();

        try {
            host.shard.sql.exec("CREATE TABLE widgets (id TEXT PRIMARY KEY, label TEXT)");

            const columns = [...host.shard.sql.exec("PRAGMA table_info(widgets)")] as { name: string }[];

            expect(columns.map((column) => column.name)).toStrictEqual(["id", "label"]);
            // `toArray()` is part of the cursor contract every host owes, and the
            // migrations read through it rather than the iterator.
            expect(host.shard.sql.exec("PRAGMA table_info(widgets)").toArray()).toHaveLength(2);
        } finally {
            host.cleanup?.();
        }
    });

    it("supports the pragma-guarded ALTER the engine's migrations are built on", () => {
        expect.assertions(3);

        const host = createReferenceHost();

        try {
            host.shard.sql.exec("CREATE TABLE widgets (id TEXT PRIMARY KEY)");

            const hasColumn = (name: string): boolean =>
                (host.shard.sql.exec("PRAGMA table_info(widgets)").toArray() as { name: string }[]).some((column) => column.name === name);

            expect(hasColumn("runs")).toBe(false);

            host.shard.sql.exec("ALTER TABLE widgets ADD COLUMN runs INTEGER NOT NULL DEFAULT 0");

            expect(hasColumn("runs")).toBe(true);

            // The exact shape of the bug: a second migration pass must see the
            // column and skip the ALTER. Before the fix `hasColumn` answered
            // `false` here and this line threw "duplicate column name: runs".
            expect(() => {
                if (!hasColumn("runs")) {
                    host.shard.sql.exec("ALTER TABLE widgets ADD COLUMN runs INTEGER NOT NULL DEFAULT 0");
                }
            }).not.toThrow();
        } finally {
            host.cleanup?.();
        }
    });

    it("leaves a setter pragma returning no rows", () => {
        expect.assertions(1);

        const host = createReferenceHost();

        try {
            // Routed down the same branch, and correctly yields nothing.
            expect(host.shard.sql.exec("PRAGMA foreign_keys = ON").toArray()).toStrictEqual([]);
        } finally {
            host.cleanup?.();
        }
    });
});
