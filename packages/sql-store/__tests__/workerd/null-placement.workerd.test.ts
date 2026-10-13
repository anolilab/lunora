/**
 * `orderBy: [{ score: { sort, nulls } }]` on a `.global()` table, paged through the keyset cursor
 * against a **real** D1 binding in workerd.
 *
 * D1 is SQLite behind an authorizer, so whether it accepts `NULLS FIRST/LAST` is a question for D1
 * itself, and the cursor seek only works if the ORDER BY it pairs with really puts NULLs where the
 * seek expects. Each test owns a table name: D1 storage is shared across the tests in this file.
 */
import type { SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { env } from "cloudflare:test";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { SqlCtxExec } from "../../src/ctx-db";
import { createSqlCtxDb } from "../../src/ctx-db";
import type { SqlDialect } from "../../src/dialect";

const UNIQUE_VIOLATION_RE = /unique constraint failed/iu;
const SQL_AFFINITY: Record<string, string> = { boolean: "INTEGER", number: "REAL" };

const d1Dialect: SqlDialect = {
    columnType: (kind) => SQL_AFFINITY[kind ?? ""] ?? "TEXT",
    companionTypes: { autoincrementPrimaryKey: "INTEGER PRIMARY KEY AUTOINCREMENT", integer: "INTEGER", key: "TEXT", real: "REAL", text: "TEXT" },
    frameworkColumns: () => [
        { name: "id", type: "TEXT PRIMARY KEY" },
        { name: "_creationTime", type: "REAL NOT NULL" },
    ],
    isUniqueViolation: (error) => error instanceof Error && UNIQUE_VIOLATION_RE.test(error.message),
    maxTableColumns: 100,
    name: "sqlite",
    supportsFts5: false,
    supportsReturning: true,
    tableExists: (table) => sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}`,
};

const col = (kind: string, column: Record<string, unknown> = {}): ValidatorLike => {
    return { _meta: { column: { notNull: true, ...column } }, kind };
};

const d1Exec: SqlCtxExec = {
    all: async (query, parameters) => {
        const result = await env.DB.prepare(query)
            .bind(...parameters)
            .all();

        return result.results;
    },
    run: async (query, parameters) => {
        await env.DB.prepare(query)
            .bind(...parameters)
            .run();
    },
};

const schemaFor = (table: string): SchemaLike =>
    ({
        tables: {
            [table]: {
                indexes: [{ fields: ["score"], name: "by_score" }],
                shape: { label: col("string"), score: col("number", { notNull: false }) },
                shardMode: { kind: "global" },
            },
        },
    }) as never;

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

/** The order a correct store must return, computed independently of the SQL. */
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

describe("orderBy null placement on D1", () => {
    it("orders and pages every direction and placement exactly like the reference", async () => {
        expect.assertions(8);

        const table = "null_placement_items";
        let now = 1_700_000_000_000;
        const writer = createSqlCtxDb({
            clock: () => {
                now += 1000;

                return now;
            },
            dialect: d1Dialect,
            exec: d1Exec,
            schema: schemaFor(table),
        });

        for (const [label, score] of ROWS) {
            // eslint-disable-next-line no-await-in-loop -- sequential inserts keep `_creationTime` in input order
            await writer.insert(table, score === null ? { label } : { label, score });
        }

        for (const combo of COMBOS) {
            // eslint-disable-next-line no-await-in-loop -- one ordering at a time
            const all = await writer.findMany(table, { orderBy: [{ score: combo }] });
            const paged: string[] = [];
            let cursor: null | string | undefined;

            for (let guard = 0; guard < ROWS.length + 2; guard += 1) {
                // eslint-disable-next-line no-await-in-loop -- each page needs the previous page's cursor
                const page = await writer.findMany(table, { cursor, limit: 2, orderBy: [{ score: combo }] });

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
