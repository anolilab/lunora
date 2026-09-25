/**
 * A read policy on a `.global()` table's search reader, against a **real** D1
 * binding in workerd.
 *
 * `rls()` guards `ctx.db.query(t)` with `reader.filter(whereFilter(policy,
 * matcher))`, which is what these tests install. They pin both halves:
 *
 * - **the boundary** — every terminal returns exactly the rows the policy
 * admits, for a policy the reader pushes into its SQL and for one it cannot;
 * - **the cost** — `meta.rows_read` and rows handed back for a guarded `take(5)`
 * over 510 matches.
 *
 * Each test owns its table; D1 storage is shared across this file.
 */
import type { SchemaLike, TableReaderLike, ValidatorLike, WhereInput } from "@lunora/shard-engine";
import { whereFilter } from "@lunora/shard-engine";
import { env } from "cloudflare:test";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { SqlCtxExec } from "../../src/ctx-db";
import { createSqlCtxDb } from "../../src/ctx-db";
import type { SqlDialect } from "../../src/dialect";

const UNIQUE_VIOLATION_RE = /unique constraint failed/iu;
const SQL_AFFINITY: Record<string, string> = { boolean: "INTEGER", number: "REAL" };

/** `@lunora/d1`'s dialect, FTS5 included — the layout D1 actually uses. */
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
    supportsFts5: true,
    supportsReturning: true,
    tableExists: (table) => sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}`,
};

const ROWS = 510;

type Row = Record<string, unknown>;

interface Meter {
    handedBack: number;
    rowsRead: number;
}

const column = (kind: string): ValidatorLike => {
    return { _meta: { column: { notNull: true } }, kind };
};

const schemaFor = (table: string): SchemaLike =>
    ({
        tables: {
            [table]: {
                indexes: [],
                searchIndexes: [{ field: "body", filterFields: [], name: "by_body" }],
                shape: { body: column("string"), hidden: column("boolean"), ownerId: column("string"), tier: column("number") },
                shardMode: { kind: "global" },
            },
        },
    }) as never;

/** A `SqlCtxExec` over the D1 binding that meters what every read costs. */
const d1Exec = (onRead: (rowsRead: number, handedBack: number) => void): SqlCtxExec => {
    return {
        all: async (query, parameters) => {
            const result = await env.DB.prepare(query)
                .bind(...parameters)
                .all();

            onRead(result.meta.rows_read, result.results.length);

            return result.results;
        },
        batch: async (statements) => {
            await env.DB.batch(statements.map((statement) => env.DB.prepare(statement.sql).bind(...statement.params)));
        },
        run: async (query, parameters) => {
            await env.DB.prepare(query)
                .bind(...parameters)
                .run();
        },
    };
};

const pad = (n: number): string => `r${String(n).padStart(4, "0")}`;

/** Every row matches "alpha"; the first four also match "solo". */
const corpus = (): Row[] =>
    Array.from({ length: ROWS }, (_, n) => {
        return { _id: pad(n), body: n < 4 ? "alpha solo" : "alpha", hidden: n % 5 === 0, ownerId: n % 2 === 0 ? "u1" : "u2", tier: n % 3 };
    });

interface Policy {
    admits: (row: Row) => boolean;
    pushed: boolean;
    where: WhereInput;
}

const POLICIES: Record<string, Policy> = {
    not: { admits: (row) => row["tier"] === 1 && row["hidden"] !== true, pushed: false, where: { NOT: { hidden: true }, tier: 1 } },
    number: { admits: (row) => row["tier"] === 1, pushed: true, where: { tier: 1 } },
    string: { admits: (row) => row["ownerId"] === "u1" && row["tier"] === 1, pushed: true, where: { ownerId: "u1", tier: { in: [1] } } },
};

/** Relevance ties break on `_creationTime DESC`, and rows are inserted in id order. */
const expectedIds = (policy: Policy, term: "alpha" | "solo"): string[] =>
    corpus()
        .filter((row) => policy.admits(row) && (term === "alpha" || String(row["body"]).includes("solo")))
        .map((row) => String(row["_id"]))
        .toReversed();

const setup = async (table: string): Promise<{ meter: Meter; writer: ReturnType<typeof createSqlCtxDb> }> => {
    const meter: Meter = { handedBack: 0, rowsRead: 0 };
    let now = 1_700_000_000_000;
    const writer = createSqlCtxDb({
        clock: () => {
            now += 1000;

            return now;
        },
        dialect: d1Dialect,
        exec: d1Exec((rowsRead, handedBack) => {
            meter.rowsRead += rowsRead;
            meter.handedBack += handedBack;
        }),
        schema: schemaFor(table),
    });

    for (const row of corpus()) {
        // eslint-disable-next-line no-await-in-loop -- sequential inserts keep `_creationTime` in id order
        await writer.insert(table, row, { allowExplicitId: true });
    }

    return { meter, writer };
};

const idsOf = (rows: ReadonlyArray<Row>): string[] => rows.map((row) => String(row["_id"]));

describe("global search reader behind a read policy (D1, workerd)", () => {
    it.each(Object.keys(POLICIES))("every terminal returns exactly the rows a %s policy admits", async (name) => {
        expect.hasAssertions();

        const policy = POLICIES[name]!;
        const table = `boundary_${name}`;
        const { writer } = await setup(table);
        const guarded = (term: "alpha" | "solo"): TableReaderLike =>
            writer
                .query(table)
                .filter(whereFilter(policy.where, policy.admits))
                .withSearchIndex("by_body", (q) => q.search("body", term));
        const exactly = (rows: ReadonlyArray<Row>, expected: ReadonlyArray<string>): void => {
            expect(rows.every((row) => policy.admits(row))).toBe(true);
            expect(idsOf(rows)).toStrictEqual(expected);
        };
        const all = expectedIds(policy, "alpha");
        const solo = expectedIds(policy, "solo");

        exactly(await guarded("alpha").take(5), all.slice(0, 5));
        const first = await guarded("alpha").first();

        exactly([first as Row], all.slice(0, 1));

        const unique = await guarded("solo").unique();

        expect(unique?.["_id"] ?? null).toBe(solo[0] ?? null);

        exactly(await guarded("alpha").collect(), all);

        const paged: Row[] = [];
        let cursor: null | string = null;

        for (;;) {
            // eslint-disable-next-line no-await-in-loop -- each page's cursor comes from the previous one
            const page = await guarded("alpha").paginate({ cursor, numItems: 40 });

            paged.push(...page.page);

            if (page.isDone) {
                break;
            }

            cursor = page.continueCursor;
        }

        exactly(paged, all);

        const iterated: Row[] = [];

        for await (const row of guarded("alpha")) {
            iterated.push(row);
        }

        exactly(iterated, all);
    });

    it.each(Object.keys(POLICIES))("a guarded take(5) under a %s policy", async (name) => {
        expect.assertions(2);

        const policy = POLICIES[name]!;
        const table = `cost_${name}`;
        const { meter, writer } = await setup(table);

        // Warm the migration pass, so only the terminal is counted.
        await writer
            .query(table)
            .withSearchIndex("by_body", (q) => q.search("body", "solo"))
            .take(1);

        meter.handedBack = 0;
        meter.rowsRead = 0;

        const rows = await writer
            .query(table)
            .filter(whereFilter(policy.where, policy.admits))
            .withSearchIndex("by_body", (q) => q.search("body", "alpha"))
            .take(5);

        expect(rows).toHaveLength(5);

        // Pushed: the five rows plus the index-coverage probe. Not pushed: every
        // match, plus the probe, for the policy to filter. Before the push-down
        // every policy read the 511.
        expect(meter.handedBack).toBe(policy.pushed ? 6 : ROWS + 1);
    });
});
