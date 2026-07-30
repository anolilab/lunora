import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Exercises `for await (const row of ctx.db.query(t)…)` — LUNORA_GAPS #6.
 *
 * Run against a real SQLite engine rather than the SQL-string fake: the whole
 * point of the iterator is that it pages through the keyset seek, and only a
 * genuine engine gets the cursor boundaries right.
 */
const todosSchema: SchemaLike = {
    tables: {
        todos: {
            indexes: [{ fields: ["seq"], name: "by_seq" }],
            shape: {
                projectId: { kind: "string" },
                seq: { kind: "number" },
            },
        },
    },
};

let harness: ReturnType<typeof createSqliteExec>;

const setupWriter = (): DatabaseWriterLike => {
    runShardMigrations(harness.sql, todosSchema);

    return createShardContextDatabase({
        clock: () => 1_700_000_000_000,
        schema: todosSchema,
        sql: harness.sql,
    });
};

/** Insert `count` rows with ascending `seq`, so order is checkable. */
const seed = async (database: DatabaseWriterLike, count: number): Promise<void> => {
    for (let index = 0; index < count; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- sequential inserts keep `_creationTime` and `seq` in step.
        await database.insert("todos", { projectId: "p1", seq: index });
    }
};

describe("ctx.db reader — lazy iteration", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("yields every row, in the same order as .collect()", async () => {
        expect.assertions(2);

        const database = setupWriter();

        // 300 rows spans more than one internal page (128), so this also proves
        // the cursor is threaded across page boundaries rather than restarting.
        await seed(database, 300);

        const iterated: number[] = [];

        for await (const row of database.query("todos").withIndex("by_seq")) {
            iterated.push(row["seq"] as number);
        }

        const collectedRows = await database.query("todos").withIndex("by_seq").collect();
        const collected = collectedRows.map((row) => row["seq"] as number);

        expect(iterated).toHaveLength(300);
        expect(iterated).toStrictEqual(collected);
    });

    it('honours .order("desc") and .filter() exactly as the other terminals do', async () => {
        expect.assertions(2);

        const database = setupWriter();

        await seed(database, 10);

        const descending: number[] = [];

        for await (const row of database.query("todos").withIndex("by_seq").order("desc")) {
            descending.push(row["seq"] as number);
        }

        expect(descending).toStrictEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);

        const even: number[] = [];

        // Indexed: with every `_creationTime` tied under the fixed test clock, an
        // UNindexed read has no defined order to assert against.
        for await (const row of database
            .query("todos")
            .withIndex("by_seq")
            .filter((document) => (document["seq"] as number) % 2 === 0)) {
            even.push(row["seq"] as number);
        }

        expect(even).toStrictEqual([0, 2, 4, 6, 8]);
    });

    it("stops reading when the consumer breaks out", async () => {
        expect.assertions(5);

        // This is the whole reason the iterator exists. A userland merged-index
        // stream needs the HEAD of each branch; materialising with `.take(1024)`
        // meant one row cost 1,024 reads per branch (LUNORA_GAPS #6).
        const database = setupWriter();

        await seed(database, 1000);

        let seen = 0;

        for await (const row of database.query("todos").withIndex("by_seq")) {
            expect(row).toBeDefined();

            seen += 1;

            if (seen === 3) {
                break;
            }
        }

        expect(seen).toBe(3);

        // A `break` must leave the reader reusable rather than half-consumed —
        // each iteration starts a fresh page walk.
        const again: number[] = [];

        for await (const row of database.query("todos").withIndex("by_seq")) {
            again.push(row["seq"] as number);

            if (again.length === 2) {
                break;
            }
        }

        expect(again).toStrictEqual([0, 1]);
    });

    it("yields nothing for an empty table", async () => {
        expect.assertions(1);

        const database = setupWriter();
        const rows: unknown[] = [];

        for await (const row of database.query("todos")) {
            rows.push(row);
        }

        expect(rows).toStrictEqual([]);
    });
});
