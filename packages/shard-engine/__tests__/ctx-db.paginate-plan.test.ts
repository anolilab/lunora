import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike, SqlExec } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * What the keyset seek COSTS, asserted on the query plan a real `node:sqlite`
 * builds for it — the companion to `ctx-db.paginate-nullable.test.ts`, which
 * asserts what it returns.
 *
 * The seek emits an `OR <col> IS NULL` arm on the pivot column of a descending
 * page, because NULLs sort last descending and no comparator reaches them (see
 * `pivotCondition`). That arm is a third disjunct the planner has to answer with
 * a third index probe, and it is pure waste on a column the schema declares
 * `notNull` — there is no null group to reach. Two schemas differing ONLY in
 * that declaration, over the same rows and the same declared index, isolate it.
 *
 * The arm is not merely one extra probe. It is what costs the read its RANGE
 * BOUND: `buildSeek` states the leading column's bound redundantly
 * (`priority <= ?`) alongside the disjunction, and a bare comparator is
 * something the planner can turn into a seek — but `(col < ? OR col IS NULL)`
 * is a second disjunction, not a bound, so the seek collapses back to a walk of
 * the whole index. The two plans differ in exactly that word:
 *
 * ```
 * notNull   SEARCH entries USING INDEX entries_by_priority (<expr><?)
 * nullable  SCAN   entries USING INDEX entries_by_priority
 * ```
 *
 * Both are asserted, so a regression in either direction is loud: dropping the
 * redundant bound loses the SEARCH, and emitting the arm unconditionally loses
 * it on every descending page — the dominant "newest first" read shape.
 */
const columnKind = (kind: string, notNull: boolean) => {
    return { _meta: { column: { notNull } }, kind };
};

/** The same table twice: `nullable` swaps ONLY how `priority` is declared. */
const planSchema = (nullable: boolean): SchemaLike => {
    return {
        tables: {
            entries: {
                indexes: [{ fields: ["priority"], name: "by_priority" }],
                shape: {
                    label: columnKind("string", true),
                    // `v.optional(inner)` is one of the two spellings of nullable —
                    // and the one that keeps `notNull: true` in its own column meta.
                    priority: nullable ? columnKind("optional", true) : columnKind("number", true),
                },
            },
        },
    };
};

/** Rows per fixture. Large enough that the planner prefers the declared index over a table scan, small enough to seed in well under a second. */
const ROW_COUNT = 2000;

let harnesses: ReturnType<typeof createSqliteExec>[];

/**
 * Seed a table, page once to mint a cursor, then return the SQL + query plan of
 * the page-2 read — the statement whose `WHERE` is the keyset seek.
 */
const seekPlan = async (nullable: boolean): Promise<{ plan: string[]; sql: string }> => {
    const schema = planSchema(nullable);
    const harness = createSqliteExec();

    harnesses.push(harness);

    const seen: { params: unknown[]; text: string }[] = [];
    const recordingSql: SqlExec = {
        exec: (query: string, ...params: unknown[]) => {
            seen.push({ params, text: query });

            return harness.sql.exec(query, ...params);
        },
    };

    runShardMigrations(recordingSql, schema);

    const writer: DatabaseWriterLike = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: recordingSql });

    for (let index = 0; index < ROW_COUNT; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- the writer is async per row; a seed loop is the only way to fill the fixture.
        await writer.insert("entries", { _id: `r${String(index).padStart(6, "0")}`, label: "x", priority: index % 200 }, { allowExplicitId: true });
    }

    const first = await writer.findMany("entries", { limit: 20, orderBy: [{ priority: "desc" }] });

    seen.length = 0;

    await writer.findMany("entries", { cursor: first.continueCursor, limit: 20, orderBy: [{ priority: "desc" }] });

    const page = seen.find((statement) => statement.text.includes("ORDER BY"));

    if (page === undefined) {
        throw new Error("no ordered SELECT was issued for page 2");
    }

    const plan = harness.raw(`EXPLAIN QUERY PLAN ${page.text}`, ...page.params).map((row) => String(row["detail"]));

    return { plan, sql: page.text };
};

describe("ctx-db paginate — seek plan over a non-nullable ordered column", () => {
    beforeEach(() => {
        harnesses = [];
    });

    afterEach(() => {
        for (const harness of harnesses) {
            harness.close();
        }
    });

    it("seeks a range on the declared index when the column is notNull, and walks it when it is not", async () => {
        expect.assertions(6);

        const declared = await seekPlan(false);
        const nullable = await seekPlan(true);

        // The arm, in the emitted SQL. `notNull` says the null group is empty, so
        // there is nothing for the arm to reach and it is removed outright — and
        // the redundant leading bound rides the same gate.
        expect(declared.sql).not.toContain("IS NULL");
        expect(declared.sql).toContain(`json_extract(__doc__, '$.priority') <= ?`);
        expect(nullable.sql).toContain("IS NULL");
        expect(nullable.sql).not.toContain(`json_extract(__doc__, '$.priority') <= ?`);

        // The plan. `(<expr><?)` is the range bound: the page reads only the
        // slice of the index below the cursor instead of walking all of it.
        expect(declared.plan.join(" | ")).toContain("SEARCH entries USING INDEX entries_by_priority (<expr><?)");
        // Pinned so a revert is loud rather than slow: with the arm present the
        // planner has no bound to seek on and falls back to the walk.
        expect(nullable.plan.join(" | ")).toContain("SCAN entries USING INDEX entries_by_priority");
    }, 30_000);
});
