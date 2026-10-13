import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SchemaLike, ValidatorLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import { normalizeOrderKeys } from "../src/query-args";
import { compileOrderByText, selectPageSql } from "../src/reader-keyset";
import type { OrderByInput } from "../src/schema-types";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * `orderBy: [{ score: { sort, nulls } }]` against a real SQLite engine, paged through the keyset
 * cursor.
 *
 * The property that matters is the one a keyset seek can break silently: concatenating the pages must
 * give exactly the unpaged order, with no row skipped and none repeated, when a page boundary falls
 * INSIDE the run of NULLs. The unpaged order is itself checked against an independent reference sort,
 * so a seek and an ORDER BY that were wrong in the same way would not pass.
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

type Combo = { nulls: "first" | "last"; sort: "asc" | "desc" };

const COMBOS: Combo[] = [
    { nulls: "first", sort: "asc" },
    { nulls: "last", sort: "asc" },
    { nulls: "first", sort: "desc" },
    { nulls: "last", sort: "desc" },
];

/** The order a correct engine must return: by score with NULLs where asked, ties by creation order in the sort's direction. */
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

const pagedLabels = async (writer: Awaited<ReturnType<typeof seed>>, combo: Combo, size: number): Promise<string[]> => {
    const labels: string[] = [];
    let cursor: null | string | undefined;

    for (let guard = 0; guard < ROWS.length + 2; guard += 1) {
        // eslint-disable-next-line no-await-in-loop -- each page needs the previous page's cursor
        const page = await writer.findMany("items", { cursor, limit: size, orderBy: [{ score: combo }] });

        labels.push(...labelsOf(page.page));

        if (page.isDone) {
            return labels;
        }

        cursor = page.continueCursor;
    }

    throw new Error("pagination did not terminate");
};

describe("orderBy null placement", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it.each(COMBOS)("orders $sort with nulls $nulls like the reference, unpaged", async (combo) => {
        expect.assertions(1);

        const writer = await seed();
        const all = await writer.findMany("items", { orderBy: [{ score: combo }] });

        expect(labelsOf(all.page)).toStrictEqual(expected(combo));
    });

    it.each(
        COMBOS.flatMap((combo) =>
            [2, 3].map((size) => {
                return { ...combo, size };
            }),
        ),
    )("pages $sort with nulls $nulls in pages of $size with no gap and no repeat", async ({ size, ...combo }) => {
        expect.assertions(1);

        const writer = await seed();

        await expect(pagedLabels(writer, combo, size)).resolves.toStrictEqual(expected(combo));
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

    it("ignores a placement on a column that cannot hold NULL, keeping its index plan", async () => {
        expect.assertions(1);

        const writer = await seed();
        const all = await writer.findMany("items", { orderBy: [{ label: { nulls: "last", sort: "asc" } }] });

        expect(labelsOf(all.page)).toStrictEqual(ROWS.map(([label]) => label).toSorted((left, right) => left.localeCompare(right)));
    });
});
