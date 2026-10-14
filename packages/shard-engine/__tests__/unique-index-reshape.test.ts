import { describe, expect, it } from "vitest";

import type { SchemaLike } from "../src/ctx-db";
import { runShardMigrations } from "../src/ctx-db-migrations";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Re-declaring a UNIQUE index over different columns is a destructive DDL path:
 * the shape check drops the old index so the new one can be created. If the
 * table already holds rows that are duplicates under the NEW column list, the
 * create then fails — and the drop has already happened, so the table is left
 * with NO unique constraint at all. Worse, the failed migration re-runs on every
 * wake and fails the same way, so nothing closes the gap.
 *
 * The guard probes for those duplicates BEFORE dropping, so the old constraint
 * stays in force and the operator is told what to de-duplicate.
 */
const withUnique = (field: string): SchemaLike => {
    return {
        tables: {
            posts: {
                indexes: [{ fields: [field], name: "by_key", unique: true }],
                shape: { slug: { kind: "string" }, status: { kind: "string" } },
            },
        },
    };
};

describe("unique index re-shape", () => {
    it("refuses the drop when existing rows violate the new column list, keeping the old constraint", () => {
        expect.assertions(3);

        const harness = createSqliteExec();

        try {
            runShardMigrations(harness.sql, withUnique("slug"));

            // Distinct under `slug`, duplicates under `status`.
            harness.raw(`INSERT INTO "posts" (id, _creationTime, __doc__) VALUES (?, ?, ?)`, "p1", 1, JSON.stringify({ slug: "a", status: "draft" }));
            harness.raw(`INSERT INTO "posts" (id, _creationTime, __doc__) VALUES (?, ?, ?)`, "p2", 2, JSON.stringify({ slug: "b", status: "draft" }));

            expect(() => {
                runShardMigrations(harness.sql, withUnique("status"));
            }).toThrow(/cannot be re-created/u);

            // The original index survives, still on `slug` — not dropped and not
            // replaced by a half-applied migration.
            const rows = harness.raw(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`, "posts_by_key");
            const held = rows[0]?.["sql"];
            const ddl = typeof held === "string" ? held : "";

            expect(ddl).toContain("slug");
            expect(ddl).not.toContain("status");
        } finally {
            harness.close();
        }
    });

    it("re-shapes a unique index over an optional column that many rows leave unset", () => {
        expect.assertions(3);

        const harness = createSqliteExec();

        try {
            runShardMigrations(harness.sql, withUnique("slug"));

            // `status` is optional, and most of these rows never set it, so
            // `json_extract(__doc__, '$.status')` is NULL for them. `GROUP BY`
            // folds those NULLs into ONE group of five; a SQLite UNIQUE index
            // counts them as five distinct keys and accepts the lot. Probing with
            // a bare `GROUP BY` reads the fold as a duplicate and refuses a
            // create that would have succeeded — on every wake, since the
            // migration re-runs, so the shard never opens again.
            for (const [position, status] of ["published", undefined, undefined, undefined, "archived", undefined, undefined].entries()) {
                const index = String(position);

                harness.raw(
                    `INSERT INTO "posts" (id, _creationTime, __doc__) VALUES (?, ?, ?)`,
                    `p${index}`,
                    position,
                    JSON.stringify(status === undefined ? { slug: `s${index}` } : { slug: `s${index}`, status }),
                );
            }

            runShardMigrations(harness.sql, withUnique("status"));

            const rows = harness.raw(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`, "posts_by_key");

            expect(typeof rows[0]?.["sql"] === "string" ? rows[0]["sql"] : "").toContain("status");

            // The rebuilt constraint is real: the unset rows coexist, and a
            // second `published` is still rejected.
            expect(harness.raw(`SELECT COUNT(*) AS n FROM "posts"`)[0]?.["n"]).toBe(7);
            expect(() => {
                harness.raw(
                    `INSERT INTO "posts" (id, _creationTime, __doc__) VALUES (?, ?, ?)`,
                    "dupe",
                    99,
                    JSON.stringify({ slug: "sx", status: "published" }),
                );
            }).toThrow(/UNIQUE/u);
        } finally {
            harness.close();
        }
    });

    it("re-shapes a unique index normally when nothing violates the new columns", () => {
        expect.assertions(1);

        const harness = createSqliteExec();

        try {
            runShardMigrations(harness.sql, withUnique("slug"));

            // Distinct under BOTH columns, so the re-shape is safe and must proceed.
            harness.raw(`INSERT INTO "posts" (id, _creationTime, __doc__) VALUES (?, ?, ?)`, "p1", 1, JSON.stringify({ slug: "a", status: "draft" }));
            harness.raw(`INSERT INTO "posts" (id, _creationTime, __doc__) VALUES (?, ?, ?)`, "p2", 2, JSON.stringify({ slug: "b", status: "published" }));

            runShardMigrations(harness.sql, withUnique("status"));

            const rows = harness.raw(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`, "posts_by_key");

            const held = rows[0]?.["sql"];

            expect(typeof held === "string" ? held : "").toContain("status");
        } finally {
            harness.close();
        }
    });
});
