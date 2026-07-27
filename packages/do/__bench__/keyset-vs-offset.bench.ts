import type { SchemaLike } from "@lunora/shard-engine";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "@lunora/shard-engine";
import { beforeAll, bench, describe } from "vitest";

import createSqliteExec from "../__tests__/_helpers/node-sqlite";

/**
 * §1.2's keyset cursor seek is O(limit) per page; an offset-style
 * pagination walks `offset + limit` rows. Apples-to-apples across the same
 * `findMany` API:
 *
 * - **keyset** — second page with `cursor: &lt;seq=4999, _id=t04999>` and
 * `limit: 50`. SQLite walks ~50 rows via the SEEK predicate the keyset
 * helper compiles (`(seq, _id) > (?, ?)`).
 * - **offset-style** — same depth modelled as `limit: 5050` without a
 * cursor, then drop the first 5000 rows JS-side. Mirrors what
 * callers using the legacy `.take(...)` path would pay at page 100.
 * - **first page** — control: keyset behaves the same on page 1, so
 * this should look ~identical to the keyset case and confirm the
 * cost is in the row scan, not the abstraction.
 *
 * Row count: 10 000. SQLite is `:memory:`.
 */

const ROW_COUNT = 10_000;
const PAGE_SIZE = 50;
const PAGE_OFFSET = 5000;

const schema: SchemaLike = {
    tables: {
        todos: {
            indexes: [{ fields: ["seq"], name: "by_seq" }],
            shape: {
                priority: { kind: "string" },
                seq: { kind: "number" },
            },
        },
    },
};

const harness = createSqliteExec();

runShardMigrations(harness.sql, schema);

const writer = createShardContextDatabase({ schema, sql: harness.sql });

// Assigned in beforeAll once the seed + cursor walk have run.
let cursor: string;

describe("findMany — keyset vs offset-style at depth 5000", () => {
    // Seed + build the cursor in beforeAll: CodSpeed's instrumented runner
    // (@codspeed/vitest-plugin) runs each bench against the suite's
    // beforeAll/beforeEach hooks but does NOT pick up module-top-level await
    // state, so a top-level seed leaves the bench querying an empty DB.
    // beforeAll is honored in both the plain `vitest bench` runner and CodSpeed.
    beforeAll(async () => {
        for (let index = 0; index < ROW_COUNT; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential seed writes into the same DB
            await writer.insert("todos", { _id: `t${String(index).padStart(5, "0")}`, priority: "medium", seq: index });
        }

        // Walk to PAGE_OFFSET once to capture the cursor pointing at row 5000.
        let walkedCursor: null | string = null;
        let rowsWalked = 0;

        while (rowsWalked < PAGE_OFFSET) {
            // eslint-disable-next-line no-await-in-loop -- sequential keyset walk to capture cursor
            const page = await writer.findMany("todos", {
                cursor: walkedCursor,
                limit: PAGE_OFFSET - rowsWalked,
                orderBy: [{ seq: "asc" }],
            });

            rowsWalked += page.page.length;
            walkedCursor = page.continueCursor;

            if (page.isDone) {
                break;
            }
        }

        if (!walkedCursor) {
            throw new Error("bench setup: failed to build cursor at offset 5000");
        }

        cursor = walkedCursor;
    });

    bench("keyset: page 101 via cursor seek (~50 rows walked)", async () => {
        await writer.findMany("todos", {
            cursor,
            limit: PAGE_SIZE,
            orderBy: [{ seq: "asc" }],
        });
    });

    bench("offset-style: limit 5050 + JS slice (~5050 rows walked)", async () => {
        const page = await writer.findMany("todos", {
            limit: PAGE_OFFSET + PAGE_SIZE,
            orderBy: [{ seq: "asc" }],
        });

        // Drop the leading PAGE_OFFSET rows JS-side — what naïve "take last
        // page" pagination has to do without a keyset cursor. Slice result
        // assigned to a sink so eslint doesn't drop it as dead.
        const dropped = page.page.slice(PAGE_OFFSET);

        if (dropped.length === 0 && PAGE_SIZE > 0) {
            throw new Error("bench invariant: offset slice returned 0 rows");
        }
    });

    bench("control: page 1 via findMany (no cursor, ~50 rows walked)", async () => {
        await writer.findMany("todos", {
            limit: PAGE_SIZE,
            orderBy: [{ seq: "asc" }],
        });
    });
});
