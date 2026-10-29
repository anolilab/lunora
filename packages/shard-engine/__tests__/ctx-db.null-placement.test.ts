import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SchemaLike, ValidatorLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import { normalizeOrderKeys } from "../src/query-args";
import { compileOrderByText, selectPageSql } from "../src/reader-keyset";
import type { OrderByInput } from "../src/schema-types";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * `orderBy: [{ score: { sort, nulls } }]` against a real SQLite engine: the EXPLAIN plan, the
 * validation of a placement, and the default placement. Paging across a NULL run is the conformance
 * suite's case, not this file's.
 */
const col = (kind: string, column: Record<string, unknown> = {}): ValidatorLike => {
    return { _meta: { column: { notNull: true, ...column } }, kind };
};

const schema: SchemaLike = {
    tables: {
        items: {
            indexes: [{ fields: ["score"], name: "by_score" }],
            // `score` is nullable: absent on some rows.
            shape: { label: col("string"), score: col("number", { notNull: false }) },
        },
    },
};

/** Four NULLs, a tie on 3, so a page boundary lands inside the NULL run and inside a tie. */
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

let harness: ReturnType<typeof createSqliteExec>;

const seed = async (): Promise<ReturnType<typeof createShardContextDatabase>> => {
    runShardMigrations(harness.sql, schema);

    let now = 1_700_000_000_000;
    const writer = createShardContextDatabase({
        clock: () => {
            now += 1000;

            return now;
        },
        schema,
        sql: harness.sql,
    });

    for (const [label, score] of ROWS) {
        // eslint-disable-next-line no-await-in-loop -- sequential inserts keep `_creationTime` in input order
        await writer.insert("items", score === null ? { label } : { label, score });
    }

    return writer;
};

const labelsOf = (page: Record<string, unknown>[]): string[] => page.map((row) => String(row["label"]));

// Paging and the unpaged order across all four placements are pinned by the shard-engine conformance suite
// (`orderBy null placement`), which runs on node and on workerd. What stays here is the SQLite-specific plan
// and the validation and default-placement behaviour the suite does not cover.
describe("orderBy null placement", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("leaves the default placement alone: a string direction and the explicit default agree", async () => {
        expect.assertions(2);

        const writer = await seed();
        const plainAsc = await writer.findMany("items", { orderBy: [{ score: "asc" }] });
        const explicitAsc = await writer.findMany("items", { orderBy: [{ score: { nulls: "first", sort: "asc" } }] });
        const plainDesc = await writer.findMany("items", { orderBy: [{ score: "desc" }] });
        const explicitDesc = await writer.findMany("items", { orderBy: [{ score: { nulls: "last", sort: "desc" } }] });

        expect(labelsOf(explicitAsc.page)).toStrictEqual(labelsOf(plainAsc.page));
        expect(labelsOf(explicitDesc.page)).toStrictEqual(labelsOf(plainDesc.page));
    });

    it("keeps serving the read from the index on SQLite, whichever placement is asked for", async () => {
        expect.assertions(4);

        await seed();

        const plan = (orderBy: OrderByInput[]): string => {
            const keys = normalizeOrderKeys(orderBy, schema.tables["items"]?.shape);
            const { params, text } = selectPageSql("items", undefined, compileOrderByText(keys), 10);

            return harness.sql
                .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${text}`, ...params)
                .toArray()
                .map((step) => step.detail)
                .join("\n");
        };
        const asked = plan([{ score: { nulls: "last", sort: "asc" } }]);
        const reversed = plan([{ score: { nulls: "first", sort: "desc" } }]);

        // SQLite walks the index for a requested placement too; another database may sort instead,
        // which is what `explain` is for.
        expect(asked).toContain("items_by_score");
        expect(asked).not.toContain("TEMP B-TREE");
        expect(reversed).toContain("items_by_score");
        expect(reversed).not.toContain("TEMP B-TREE");
    });

    it.each([
        ["a hostile nulls", { nulls: "first; DROP TABLE items", sort: "asc" }],
        ["an unknown nulls", { nulls: "middle", sort: "asc" }],
        ["a missing nulls", { sort: "asc" }],
        ["an unknown sort", { nulls: "last", sort: "sideways" }],
        ["null", null],
    ])("rejects %s before any SQL is built", async (_label, spec) => {
        expect.assertions(1);

        const writer = await seed();

        await expect(writer.findMany("items", { orderBy: [{ score: spec as never }] })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    });

    it("ignores a placement on a column that cannot hold NULL", async () => {
        expect.assertions(1);

        const writer = await seed();
        const all = await writer.findMany("items", { orderBy: [{ label: { nulls: "last", sort: "asc" } }] });

        expect(labelsOf(all.page)).toStrictEqual(ROWS.map(([label]) => label).toSorted((left, right) => left.localeCompare(right)));
    });
});

describe("which columns take a NULL placement", () => {
    const unionWithNull = { _meta: { column: { notNull: true }, members: [col("string"), col("null")] }, kind: "union" } satisfies ValidatorLike;

    it.each([
        ["a union with v.null()", unionWithNull],
        ["v.any()", col("any")],
        ["v.null()", col("null")],
        ["v.optional(...)", { _meta: { column: { notNull: true }, inner: col("string") }, kind: "optional" }],
    ])("records a requested placement on %s, which stores NULL", (_label, validator) => {
        expect.assertions(1);

        const [key] = normalizeOrderKeys([{ status: { nulls: "last", sort: "asc" } }], { status: validator });

        expect(key).toMatchObject({ nullable: true, nulls: "last" });
    });

    it("does not on a plain required column", () => {
        expect.assertions(1);

        const [key] = normalizeOrderKeys([{ status: { nulls: "last", sort: "asc" } }], { status: col("string") });

        expect(key?.nulls).toBeUndefined();
    });

    it.each(["DESC", "up", "", undefined])("rejects the plain-string direction %j instead of sorting ascending", (direction) => {
        expect.assertions(1);

        expect(() => normalizeOrderKeys([{ score: direction as never }], schema.tables["items"]?.shape)).toThrow(/expected "asc", "desc"/u);
    });
});
