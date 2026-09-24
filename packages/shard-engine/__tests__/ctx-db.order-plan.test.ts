import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike, SqlExec } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * What an ordered read COSTS, asserted on the query plan a real `node:sqlite`
 * builds for the statement the store actually emits.
 *
 * Two sort-key defects lived here, and both are invisible at toy scale — a few
 * hundred rows sort so fast that a temp B-tree and an index walk are the same
 * wall clock. The plan is what states which one ran, so that is what these
 * assert; the timings are in the commit that fixed them.
 *
 * A repeated eq-pinned field: `where: { channel }` +
 * `orderBy: [{ channel }, { priority }]` names a column that holds ONE value
 * across every returned row, so it contributes nothing to the order — but SQLite
 * will not drop an equality-pinned term from an ORDER BY over an expression
 * index, and sorted every match into a temp B-tree. The fluent reader has
 * dropped these since `unpinnedIndexFields`; the object form did not.
 *
 * A UNIQUE index: it is created WITHOUT the `(…, _creationTime, id)` sort keys
 * every other index carries — deliberately, since they would join what is unique
 * — so splicing `_creationTime` into the ORDER BY made the index unusable for
 * the sort and every ordered read over it a full-table sort.
 *
 * Correctness rides along in the same fixture: a plan change that skipped or
 * repeated rows across a page boundary would still produce a fast plan, so the
 * unique-index case pages the WHOLE table and counts what came back.
 */

const schema = {
    tables: {
        m: {
            indexes: [
                { fields: ["channel", "priority"], name: "by_channel_priority" },
                { fields: ["email"], name: "by_email", unique: true },
            ],
            shape: {
                channel: { _meta: { column: { notNull: true } }, kind: "string" },
                email: { _meta: { column: { notNull: true } }, kind: "string" },
                priority: { _meta: { column: { notNull: true } }, kind: "number" },
            },
        },
    },
} as unknown as SchemaLike;

/**
 * Rows in the fixture, and channels to spread them over.
 *
 * 10k / 5 puts 2,000 rows behind every `channel` equality. That is the number
 * that matters: the defect is "sort every MATCH to return `limit` of them", so a
 * fixture whose matches number in the dozens reproduces nothing, and this repo
 * has shipped the same class of bug twice behind exactly that fixture. The
 * planner also needs a table big enough to prefer a declared index over a scan.
 */
const ROW_COUNT = 10_000;
const CHANNELS = 5;
const BATCH = 500;

let harness: ReturnType<typeof createSqliteExec>;
let seen: { params: unknown[]; text: string }[];
/** `insertManyUnsafe` is optional on the surface; the seed loop needs it, so require it here. */
let writer: DatabaseWriterLike & Required<Pick<DatabaseWriterLike, "insertManyUnsafe">>;

/** The ordered row SELECT the reader emits — the only statement whose ORDER BY is under test. */
const lastOrderedRead = (): { params: unknown[]; text: string } => {
    const statement = seen.findLast((entry) => entry.text.startsWith("SELECT id, _creationTime") && entry.text.includes("ORDER BY"));

    if (statement === undefined) {
        throw new Error("no ordered row SELECT was issued");
    }

    return statement;
};

const planOf = (statement: { params: unknown[]; text: string }): string =>
    harness
        .raw(`EXPLAIN QUERY PLAN ${statement.text}`, ...statement.params)
        .map((row) => String(row["detail"]))
        .join(" | ");

describe("ctx-db ordered reads — index walk vs temp B-tree", () => {
    beforeEach(async () => {
        harness = createSqliteExec();
        seen = [];

        const recordingSql: SqlExec = {
            exec: (query: string, ...params: unknown[]) => {
                seen.push({ params, text: query });

                return harness.sql.exec(query, ...params);
            },
        };

        runShardMigrations(harness.sql, schema);

        writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: recordingSql }) as typeof writer;

        for (let start = 0; start < ROW_COUNT; start += BATCH) {
            const rows = Array.from({ length: BATCH }, (_, offset) => {
                const index = start + offset;

                return { channel: `c${String(index % CHANNELS)}`, email: `e${String(index).padStart(6, "0")}`, priority: index % 100 };
            });

            // eslint-disable-next-line no-await-in-loop -- a seed loop: each batch must land before the next is built.
            await writer.insertManyUnsafe("m", rows, { limit: BATCH });
        }

        seen.length = 0;
    }, 60_000);

    afterEach(() => {
        harness.close();
    });

    it("drops an eq-pinned field from `orderBy` so the declared index answers the sort", async () => {
        expect.assertions(5);

        const pinnedInOrder = await writer.findMany("m", {
            limit: 20,
            orderBy: [{ channel: "desc" }, { priority: "desc" }],
            where: { channel: "c1" },
        });
        const pinnedStatement = lastOrderedRead();

        // The pinned column is gone from the emitted sort — it is a constant
        // across every returned row, so this changes no answer.
        expect(pinnedStatement.text).not.toContain(`json_extract(__doc__, '$.channel') DESC`);
        expect(planOf(pinnedStatement)).toContain("SEARCH m USING INDEX m_by_channel_priority");
        expect(planOf(pinnedStatement)).not.toContain("TEMP B-TREE");

        // …and the answer is the same one the un-repeated `orderBy` gives, which
        // is the whole justification for dropping it.
        seen.length = 0;

        const withoutPinned = await writer.findMany("m", { limit: 20, orderBy: [{ priority: "desc" }], where: { channel: "c1" } });

        expect(pinnedInOrder.page.map((row) => row["_id"])).toStrictEqual(withoutPinned.page.map((row) => row["_id"]));
        expect(pinnedInOrder.page).toHaveLength(20);
    }, 60_000);

    it("omits the `_creationTime` tiebreak over a UNIQUE index, which carries no sort keys", async () => {
        expect.assertions(3);

        await writer.findMany("m", { limit: 20, orderBy: [{ email: "desc" }] });
        const statement = lastOrderedRead();

        // The UNIQUE index is `(email)` alone, so `_creationTime` between `email`
        // and `id` is a column the index does not have and the sort cannot use it.
        expect(statement.text).not.toContain("_creationTime DESC");
        expect(statement.text).toContain(`ORDER BY json_extract(__doc__, '$.email') DESC, id DESC`);
        expect(planOf(statement)).toContain("m_by_email");
    }, 60_000);

    it("keeps the fluent unique-index page an index walk", async () => {
        expect.assertions(2);

        await writer.query("m").withIndex("by_email").order("desc").paginate({ cursor: null, numItems: 20 });

        const statement = lastOrderedRead();

        expect(statement.text).not.toContain("_creationTime DESC");
        expect(planOf(statement)).toContain("m_by_email");
    }, 60_000);

    it("still pages every row exactly once over the unique index", async () => {
        expect.assertions(3);

        // Dropping a sort key is only safe while the remaining keys still order
        // the rows totally. If they did not, a page boundary would skip or repeat
        // — fast and wrong, which no plan assertion catches.
        const ids = new Set<unknown>();
        let cursor: null | string = null;
        let pages = 0;

        for (;;) {
            // eslint-disable-next-line no-await-in-loop -- keyset pagination is inherently sequential: each page needs the previous cursor.
            const page: { continueCursor: null | string; isDone: boolean; page: Record<string, unknown>[] } = await writer.findMany("m", {
                cursor,
                limit: 1000,
                orderBy: [{ email: "desc" }],
            });

            for (const row of page.page) {
                ids.add(row["_id"]);
            }

            pages += 1;
            cursor = page.continueCursor;

            if (page.isDone || cursor === null || pages > 20) {
                break;
            }
        }

        expect(ids.size).toBe(ROW_COUNT);
        expect(pages).toBeLessThanOrEqual(20);
        expect(cursor === null || pages <= 20).toBe(true);
    }, 60_000);
});
