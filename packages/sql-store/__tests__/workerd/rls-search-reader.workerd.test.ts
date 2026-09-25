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
                shape: {
                    body: column("string"),
                    hidden: column("boolean"),
                    // Nullable: absent on every fourth row.
                    label: { _meta: { column: {}, inner: { kind: "string" } }, kind: "optional" },
                    ownerId: column("string"),
                    tier: column("number"),
                },
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

const LABELS = [undefined, "x", "y", undefined] as const;

/** Every row matches "alpha"; the first four also match "solo". */
const corpus = (): Row[] =>
    Array.from({ length: ROWS }, (_, n) => {
        const label = LABELS[n % 4];

        return {
            _id: pad(n),
            body: n < 4 ? "alpha solo" : "alpha",
            hidden: n % 5 === 0,
            ownerId: n % 2 === 0 ? "u1" : "u2",
            tier: n % 3,
            ...(label === undefined ? {} : { label }),
        };
    });

/** A NULL cell never passes `ne` / `notIn`, in SQL or in the matcher. */
const labelIsNot = (row: Row, value: string): boolean => row["label"] !== undefined && row["label"] !== null && row["label"] !== value;

const SOME_IDS = Array.from({ length: 20 }, (_, n) => pad(n * 3 + 2));

interface Policy {
    admits: (row: Row) => boolean;
    pushed: boolean;
    where: WhereInput;
}

const POLICIES: Record<string, Policy> = {
    // `allowAll()` is `{}`: the OR is TRUE whatever its other branch says.
    allowAllBranch: { admits: (row) => row["tier"] === 1, pushed: true, where: { AND: [{ OR: [{}, { tier: 7 }] }, { tier: 1 }] } },
    idIn: { admits: (row) => SOME_IDS.includes(String(row["_id"])), pushed: true, where: { _id: { in: SOME_IDS } } },
    nullableIsNull: {
        admits: (row) => (row["label"] === undefined || row["label"] === null) && row["tier"] === 1,
        pushed: true,
        where: { label: { isNull: true }, tier: 1 },
    },
    nullableNe: { admits: (row) => labelIsNot(row, "x"), pushed: true, where: { label: { ne: "x" } } },
    nullableNotIn: { admits: (row) => labelIsNot(row, "x"), pushed: true, where: { label: { notIn: ["x"] } } },
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

/**
 * D1 caps a statement at 100 bound parameters, and a 16-term search spends up
 * to 17 of them before the policy binds any. The policy's `in` lists have to fit
 * in what is left, and a policy too wide to fit at all is filtered in memory
 * rather than pushed.
 */
describe("global search reader: a pushed policy within D1's parameter cap", () => {
    const WORDS = Array.from({ length: 16 }, (_, n) => `w${String.fromCodePoint(97 + n)}`);

    const setupWide = async (table: string): Promise<ReturnType<typeof createSqlCtxDb>> => {
        let now = 1_700_000_000_000;
        const writer = createSqlCtxDb({
            clock: () => {
                now += 1000;

                return now;
            },
            dialect: d1Dialect,
            exec: d1Exec(() => undefined),
            schema: {
                tables: {
                    [table]: {
                        indexes: [],
                        searchIndexes: [{ field: "body", filterFields: [], name: "by_body" }],
                        shape: { body: column("string"), ownerId: column("string") },
                        shardMode: { kind: "global" },
                    },
                },
            } as never,
        });

        for (let n = 0; n < 30; n += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential inserts keep `_creationTime` in id order
            await writer.insert(table, { _id: pad(n), body: WORDS.join(" "), ownerId: n % 2 === 0 ? "u1" : "u2" }, { allowExplicitId: true });
        }

        return writer;
    };

    const admitted = Array.from({ length: 15 }, (_, n) => pad(28 - n * 2));

    it.each([
        // 40 scalars + a 50-item list + 17 search params: 107 unless the list shrinks.
        ["a 50-item in list beside 40 equality branches", 40],
        // 90 scalars + 17 search params cannot fit however the list is bound.
        ["90 equality branches", 90],
    ])("%s", async (_label, branches) => {
        expect.assertions(1);

        const table = `wide_${String(branches)}`;
        const writer = await setupWide(table);
        const list = ["u1", ...Array.from({ length: 49 }, (_, n) => `l${String(n)}`)];
        const where: WhereInput = {
            OR: [
                { ownerId: { in: list } },
                ...Array.from({ length: branches }, (_, n) => {
                    return { ownerId: `z${String(n)}` };
                }),
            ],
        };
        const rows = await writer
            .query(table)
            .filter(whereFilter(where, (row) => row["ownerId"] === "u1"))
            .withSearchIndex("by_body", (q) => q.search("body", WORDS.join(" ")))
            .take(5);

        expect(rows.map((row) => String(row["_id"]))).toStrictEqual(admitted.slice(0, 5));
    });
});
