import { bench, describe } from "vitest";

import createSqliteExec from "../__tests__/_helpers/node-sqlite";

/**
 * `rankPage` selects a page of ids from the rank companion table, then has to
 * hydrate the documents from the base table.
 *
 * - **n-plus-one** — one `SELECT ... WHERE id = ?` per page row (the prior
 * implementation): N separate statements for an N-row page.
 * - **in-batch** — one `SELECT ... WHERE id IN (?, ?, ...)` plus an id->doc
 * map re-projected in page order (the new implementation): 1 statement.
 *
 * Page size: 100 rows (the rankPage default). The win is collapsing 100
 * prepared statements + round-trips into one.
 */

const PAGE_SIZE = 100;
const TOTAL_ROWS = 1000;

const harness = createSqliteExec();

harness.raw(`CREATE TABLE "messages" (id TEXT PRIMARY KEY, _creationTime INTEGER, __doc__ TEXT)`);

for (let index = 0; index < TOTAL_ROWS; index += 1) {
    harness.raw(
        `INSERT INTO "messages" (id, _creationTime, __doc__) VALUES (?, ?, ?)`,
        `m-${String(index).padStart(5, "0")}`,
        index,
        JSON.stringify({ body: `message ${String(index)}`, seq: index }),
    );
}

// The page of ids the rank companion would have returned, in page order.
const pageIds = Array.from({ length: PAGE_SIZE }, (_, index) => `m-${String(index * 7).padStart(5, "0")}`);
const placeholders = pageIds.map(() => "?").join(", ");

describe("rankPage hydration — per-row N+1 vs single IN(...) batch", () => {
    bench("n+1: one SELECT per page row", () => {
        const docs: Record<string, unknown>[] = [];

        for (const id of pageIds) {
            const [row] = harness.raw(`SELECT id, _creationTime, __doc__ FROM "messages" WHERE id = ?`, id);

            if (row) {
                docs.push(row);
            }
        }

        if (docs.length !== PAGE_SIZE) {
            throw new Error("bench invariant: incomplete page");
        }
    });

    bench("in-batch: single IN(...) query + id->doc re-projection", () => {
        const rows = harness.raw(`SELECT id, _creationTime, __doc__ FROM "messages" WHERE id IN (${placeholders})`, ...pageIds);

        const byId = new Map<string, Record<string, unknown>>();

        for (const row of rows) {
            byId.set(row["id"] as string, row);
        }

        const docs: Record<string, unknown>[] = [];

        for (const id of pageIds) {
            const row = byId.get(id);

            if (row) {
                docs.push(row);
            }
        }

        if (docs.length !== PAGE_SIZE) {
            throw new Error("bench invariant: incomplete page");
        }
    });
});
