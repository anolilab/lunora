import type { DatabaseWriterLike, SchemaLike, ValidatorLike } from "@lunora/do";
import { beforeAll, bench, describe } from "vitest";

import { createD1Exec } from "../__tests__/_helpers/node-sqlite-d1";
import { createD1CtxDb as createD1ContextDatabase } from "../src/d1-ctx-db";

/**
 * D1 column-dialect twin of `@lunora/do/keyset-vs-offset`. The win is
 * algorithmic (cursor seek is O(limit), offset-style is O(offset)) and
 * dialect-independent; we bench against D1 too so global tables get the
 * same regression signal as shard-local ones.
 */

const ROW_COUNT = 10_000;
const PAGE_SIZE = 50;
const PAGE_OFFSET = 5000;
const CLOCK = 1_700_000_000_000;

const col = (kind: string): ValidatorLike => {
    return { _meta: { column: { notNull: true } }, kind };
};

const schema: SchemaLike = {
    tables: {
        todos: {
            indexes: [],
            shape: { priority: col("string"), seq: col("number") },
        },
    },
};

const harness = createD1Exec();

harness.ddl(
    `CREATE TABLE "todos" (
        "id" TEXT PRIMARY KEY,
        "_creationTime" INTEGER NOT NULL,
        "priority" TEXT,
        "seq" INTEGER
    )`,
);

const writer: DatabaseWriterLike = createD1ContextDatabase({ clock: () => CLOCK, exec: harness.exec, schema });

let cursor: string;

describe("d1 findMany — keyset vs offset-style at depth 5000", () => {
    // Seed + capture the depth-5000 cursor in beforeAll: CodSpeed's instrumented
    // runner does not pick up module-top-level await state (the seed writes and
    // the cursor walk), so the benches would otherwise hit an empty DB. beforeAll
    // is honored by both the plain `vitest bench` runner and CodSpeed's runner.
    beforeAll(async () => {
        for (let index = 0; index < ROW_COUNT; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential seed: rows insert one at a time to keep deterministic _creationTime ordering
            await writer.insert("todos", { _id: `t${String(index).padStart(5, "0")}`, priority: "medium", seq: index });
        }

        // Walk to PAGE_OFFSET once to capture the cursor.
        let walkedCursor: null | string = null;
        let rowsWalked = 0;

        while (rowsWalked < PAGE_OFFSET) {
            // eslint-disable-next-line no-await-in-loop -- cursor walk: each page depends on the prior page's continueCursor, so it must be sequential
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
        await writer.findMany("todos", { cursor, limit: PAGE_SIZE, orderBy: [{ seq: "asc" }] });
    });

    bench("offset-style: limit 5050 + JS slice (~5050 rows walked)", async () => {
        const page = await writer.findMany("todos", { limit: PAGE_OFFSET + PAGE_SIZE, orderBy: [{ seq: "asc" }] });
        const dropped = page.page.slice(PAGE_OFFSET);

        if (dropped.length === 0 && PAGE_SIZE > 0) {
            throw new Error("bench invariant: offset slice returned 0 rows");
        }
    });

    bench("control: page 1 via findMany (no cursor, ~50 rows walked)", async () => {
        await writer.findMany("todos", { limit: PAGE_SIZE, orderBy: [{ seq: "asc" }] });
    });
});
