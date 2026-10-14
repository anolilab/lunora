import { describe, expect, it } from "vitest";

import type { SchemaLike } from "../src/ctx-db";
import { runShardMigrations } from "../src/ctx-db-migrations";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * A declared `.index()` now carries the default sort keys (`_creationTime, id`)
 * after its filter expressions, because every filtered read this store emits
 * ends `ORDER BY _creationTime ASC, id ASC`. Without them SQLite cannot walk the
 * index in order and answers `WHERE f = ? ORDER BY … LIMIT n` by sorting every
 * matching row — O(matches) instead of O(limit), and worse as the table grows.
 *
 * These assert it through the query PLAN rather than through timings: the plan
 * is what actually states whether the temp B-tree is gone, and it does not go
 * flaky on a loaded machine.
 */

const schema = {
    tables: {
        messages: {
            indexes: [{ fields: ["channelId"], name: "by_channel" }],
            shape: { authorId: { kind: "string" }, body: { kind: "string" }, channelId: { kind: "string" } },
        },
    },
} as unknown as SchemaLike;

/** The read shape the store emits for `findFirst({ where: { channelId } })`. */
const FILTERED_READ = `SELECT id, _creationTime, "__doc__" FROM "messages" WHERE json_extract(__doc__, '$.channelId') = ? ORDER BY _creationTime ASC, id ASC LIMIT 2`;

/** The read shape `paginate()` / `findMany({ limit })` / `.first()` emit with no filter and no `orderBy` at all. */
const DEFAULT_SORT_READ = `SELECT id, _creationTime, "__doc__" FROM "messages" ORDER BY _creationTime ASC, id ASC LIMIT 21`;

const planOf = (harness: ReturnType<typeof createSqliteExec>, query: string, ...parameters: unknown[]): string =>
    harness
        .raw(`EXPLAIN QUERY PLAN ${query}`, ...parameters)
        .map((step) => String(step["detail"]))
        .join(" | ");

describe("declared index sort keys", () => {
    it("lets a filtered, ordered read run without a temp B-tree", () => {
        expect.assertions(2);

        const harness = createSqliteExec();

        runShardMigrations(harness.sql, schema);

        const plan = planOf(harness, FILTERED_READ, "c1");

        expect(plan).toContain("USING");
        // The whole point: sorting every match to return two rows is what this
        // index shape exists to avoid.
        expect(plan).not.toContain("TEMP B-TREE");
    });

    it("indexes the default sort itself, so an UNFILTERED page is an index walk", () => {
        expect.assertions(3);

        // The row table declares only `id TEXT PRIMARY KEY`, so before this
        // nothing indexed the order EVERY unfiltered read sorts by and SQLite
        // read the whole table into a temp B-tree to return the first 21 rows:
        // 1317.9us over 50k rows against 10.8us on the walk, and O(table) per
        // page rather than O(page). Unlike the declared-index case there is no
        // filter here for an index to be chosen FOR — the ordering is the only
        // reason an index can be used at all.
        const harness = createSqliteExec();

        runShardMigrations(harness.sql, schema);

        const [row] = harness.raw(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'messages__by_creation'`);

        expect(String(row?.["sql"])).toMatch(/_creationTime.*,\s*id\b/su);

        const plan = planOf(harness, DEFAULT_SORT_READ);

        expect(plan).toContain("messages__by_creation");
        expect(plan).not.toContain("TEMP B-TREE");
    });

    it("indexes the sort keys after the declared fields, not before", () => {
        expect.assertions(1);

        const harness = createSqliteExec();

        runShardMigrations(harness.sql, schema);

        const [row] = harness.raw(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'messages_by_channel'`);

        // Order matters: the filter expression has to lead or SQLite cannot seek
        // on it, and the sort keys have to trail or they cannot satisfy ORDER BY.
        expect(String(row?.["sql"])).toMatch(/json_extract\([^)]*channelId[^)]*\).*_creationTime.*, id\b/su);
    });

    it("leaves a UNIQUE index alone, so the constraint keeps rejecting duplicates", () => {
        expect.hasAssertions();

        // Appending the sort keys here would make `(email, _creationTime, id)` the
        // unique tuple — unique for every row — and the constraint would silently
        // stop working. That is data corruption, not a slow query.
        const uniqueSchema = {
            tables: {
                users: {
                    indexes: [{ fields: ["email"], name: "by_email", unique: true }],
                    shape: { email: { kind: "string" } },
                },
            },
        } as unknown as SchemaLike;

        const harness = createSqliteExec();

        runShardMigrations(harness.sql, uniqueSchema);

        const [row] = harness.raw(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'users_by_email'`);

        expect(String(row?.["sql"])).not.toMatch(/_creationTime/u);

        const insert = (id: string, email: string): void => {
            harness.raw(`INSERT INTO "users" (id, _creationTime, "__doc__") VALUES (?, ?, ?)`, id, 1, JSON.stringify({ email }));
        };

        insert("u1", "a@b.c");

        expect(() => {
            insert("u2", "a@b.c");
        }).toThrow(/UNIQUE/iu);
    });

    it("replaces an index a previous version built without the sort keys", () => {
        expect.hasAssertions();

        // `CREATE INDEX IF NOT EXISTS` is a no-op against an index that exists
        // with a DIFFERENT definition, so without an explicit drop an already
        // migrated shard would keep the old shape forever and silently miss the
        // improvement. Simulate that shard by creating the old index first.
        const harness = createSqliteExec();

        harness.raw(`CREATE TABLE "messages" (id TEXT PRIMARY KEY, _creationTime REAL, "__doc__" TEXT)`);
        harness.raw(`CREATE INDEX "messages_by_channel" ON "messages" (json_extract(__doc__, '$.channelId'))`);

        const before = String(harness.raw(`SELECT sql FROM sqlite_master WHERE name = 'messages_by_channel'`)[0]?.["sql"]);

        expect(before).not.toMatch(/_creationTime/u);

        runShardMigrations(harness.sql, schema);

        const after = String(harness.raw(`SELECT sql FROM sqlite_master WHERE name = 'messages_by_channel'`)[0]?.["sql"]);

        expect(after).toMatch(/_creationTime/u);
        expect(planOf(harness, FILTERED_READ, "c1")).not.toContain("TEMP B-TREE");
    });

    it("does not rebuild an index that already has the right shape", () => {
        expect.assertions(1);

        // The drop is keyed on a shape difference, so a second migration pass over
        // an up-to-date shard must not pay for a rebuild. Same statement text
        // across two runs is the observable proxy for "left alone".
        const harness = createSqliteExec();

        runShardMigrations(harness.sql, schema);

        const first = String(harness.raw(`SELECT sql FROM sqlite_master WHERE name = 'messages_by_channel'`)[0]?.["sql"]);

        runShardMigrations(harness.sql, schema);

        expect(String(harness.raw(`SELECT sql FROM sqlite_master WHERE name = 'messages_by_channel'`)[0]?.["sql"])).toBe(first);
    });
});
