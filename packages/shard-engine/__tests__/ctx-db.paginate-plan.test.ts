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
 * ## What this file does NOT claim
 *
 * Not "seek instead of scan". This store never emits a bare `col < ?`: the
 * lexicographic seek is always `(col < ?) OR (col = ? AND …)`, and the OR is
 * what denies SQLite the range bound — measured on a plain 50k-row table with a
 * covering `(priority, id)` index, `priority < ?` alone plans
 * `SEARCH … (priority<?)` at 3.9us while the two-branch seek that this code
 * actually emits plans `SCAN` at 462us, arm or no arm. Dropping the arm takes
 * that to 828us -> 728us on the same fixture; it does not restore the bound.
 * Asserting a plan shape this emitter cannot produce would be a green gate that
 * guards nothing, so what is asserted here is the branch the fix removes.
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

/** Index probes in a plan — the rows the pivot's disjuncts each cost one of. */
const indexProbes = (plan: string[]): string[] => plan.filter((detail) => detail.includes("USING INDEX") || detail.includes("USING COVERING INDEX"));

describe("ctx-db paginate — seek plan over a non-nullable ordered column", () => {
    beforeEach(() => {
        harnesses = [];
    });

    afterEach(() => {
        for (const harness of harnesses) {
            harness.close();
        }
    });

    it("drops the NULL arm, and with it one index probe, when the column is declared notNull", async () => {
        expect.assertions(5);

        const declared = await seekPlan(false);
        const nullable = await seekPlan(true);

        // The arm, in the emitted SQL. `notNull` says the null group is empty, so
        // there is nothing for the arm to reach and it is removed outright.
        expect(declared.sql).not.toContain("IS NULL");
        expect(nullable.sql).toContain("IS NULL");

        // The arm, in the plan. Each disjunct of the pivot costs its own index
        // probe under `MULTI-INDEX OR`; the arm is a whole extra one, on the
        // dominant "newest first" read shape (`nonNullWanted` is false for every
        // descending pivot of the forward seek, so the arm landed on all of them).
        expect(indexProbes(nullable.plan)).toHaveLength(indexProbes(declared.plan).length + 1);

        // Both still read through the declared index rather than the table — the
        // fix removes a branch, it does not change which index answers the page.
        expect(indexProbes(declared.plan).join(" ")).toContain("entries_by_priority");
        expect(indexProbes(declared.plan)).not.toHaveLength(0);
    }, 30_000);
});
