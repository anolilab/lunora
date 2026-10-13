/**
 * `orderBy: [{ score: { sort, nulls } }]` paged through the keyset cursor on real workerd SQLite.
 *
 * The cursor seek and the ORDER BY have to agree about where NULLs sort, or a page boundary inside
 * the NULL run skips or repeats rows. `node:sqlite` and workerd are different SQLite builds, and
 * `NULLS FIRST/LAST` needs a recent one, so the property is asserted here on the engine a Durable
 * Object actually gets.
 */
import type { SchemaLike } from "@lunora/shard-engine";
import { createShardCtxDb, runShardMigrations } from "@lunora/shard-engine";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const schema = {
    tables: {
        items: {
            indexes: [{ fields: ["score"], name: "by_score" }],
            shape: { label: { kind: "string" }, score: { _meta: { column: { notNull: false } }, kind: "number" } },
        },
    },
} as unknown as SchemaLike;

/** Four NULLs and a tie on 3, so a page boundary falls inside the NULL run and inside a tie. */
const ROWS: [string, null | number][] = [
    ["a", null],
    ["b", 3],
    ["c", null],
    ["d", 1],
    ["e", null],
    ["f", 3],
    ["g", 2],
    ["h", null],
];

type Combo = { nulls: "first" | "last"; sort: "asc" | "desc" };

const COMBOS: Combo[] = [
    { nulls: "first", sort: "asc" },
    { nulls: "last", sort: "asc" },
    { nulls: "first", sort: "desc" },
    { nulls: "last", sort: "desc" },
];

/** The order a correct engine must return, computed independently of the SQL. */
const expected = ({ nulls, sort }: Combo): string[] => {
    const created = new Map(ROWS.map(([label], index) => [label, index]));
    const sign = sort === "asc" ? 1 : -1;

    return ROWS.toSorted(([leftLabel, left], [rightLabel, right]) => {
        if (left !== right) {
            if (left === null) {
                return nulls === "first" ? -1 : 1;
            }

            if (right === null) {
                return nulls === "first" ? 1 : -1;
            }

            return (left - right) * sign;
        }

        return ((created.get(leftLabel) ?? 0) - (created.get(rightLabel) ?? 0)) * sign;
    }).map(([label]) => label);
};

describe("orderBy null placement on workerd", () => {
    it("orders and pages every direction and placement exactly like the reference", async () => {
        expect.assertions(8);

        const stub = env.SHARD.get(env.SHARD.idFromName("null-placement"));

        await runInDurableObject(stub, async (_instance, state) => {
            const sql = { exec: state.storage.sql.exec.bind(state.storage.sql) } as never;

            runShardMigrations(sql, schema);

            let now = 1_700_000_000_000;
            const db = createShardCtxDb({
                clock: () => {
                    now += 1000;

                    return now;
                },
                schema,
                sql,
            });

            for (const [label, score] of ROWS) {
                // eslint-disable-next-line no-await-in-loop -- sequential inserts keep `_creationTime` in input order
                await db.insert("items", score === null ? { label } : { label, score });
            }

            for (const combo of COMBOS) {
                // eslint-disable-next-line no-await-in-loop -- one ordering at a time
                const all = await db.findMany("items", { orderBy: [{ score: combo }] });
                const paged: string[] = [];
                let cursor: null | string | undefined;

                for (let guard = 0; guard < ROWS.length + 2; guard += 1) {
                    // eslint-disable-next-line no-await-in-loop -- each page needs the previous page's cursor
                    const page = await db.findMany("items", { cursor, limit: 2, orderBy: [{ score: combo }] });

                    paged.push(...page.page.map((row) => String(row["label"])));

                    if (page.isDone) {
                        break;
                    }

                    cursor = page.continueCursor;
                }

                expect(all.page.map((row) => String(row["label"]))).toStrictEqual(expected(combo));
                expect(paged).toStrictEqual(expected(combo));
            }
        });
    });
});
