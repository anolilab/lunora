import type { SchemaLike, ValidatorLike } from "@lunora/shard-engine";

/**
 * The NULL-placement fixture both sql-store suites page through: a `.global()` `items` table whose
 * nullable `score` is absent on some rows. Runtime-neutral on purpose, so the node and the D1 suites
 * share one copy and neither imports a runtime it does not run on.
 */

/** Four NULLs and a tie on 3, so a page boundary falls inside the NULL run and inside a tie. */
export const ROWS: [string, null | number][] = [
    ["a", null],
    ["b", 3],
    ["c", null],
    ["d", 1],
    ["e", null],
    ["f", 3],
    ["g", 2],
    ["h", null],
];

export type Combo = { nulls: "first" | "last"; sort: "asc" | "desc" };

export const COMBOS: Combo[] = [
    { nulls: "first", sort: "asc" },
    { nulls: "last", sort: "asc" },
    { nulls: "first", sort: "desc" },
    { nulls: "last", sort: "desc" },
];

/** The order a correct store must return, computed independently of the SQL. */
export const expected = ({ nulls, sort }: Combo): string[] => {
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

export const labelsOf = (page: Record<string, unknown>[]): string[] => page.map((row) => String(row["label"]));

/**
 * Walk a cursor to the end, one page at a time, and return the labels in the order the pages arrived.
 * `read` is one page of the caller's own `findMany`, with the size and ordering already bound.
 */
export const pagedLabels = async (
    read: (cursor: null | string | undefined) => Promise<{ continueCursor: null | string | undefined; isDone: boolean; page: Record<string, unknown>[] }>,
): Promise<string[]> => {
    const labels: string[] = [];
    let cursor: null | string | undefined;

    for (let guard = 0; guard < ROWS.length + 2; guard += 1) {
        // eslint-disable-next-line no-await-in-loop -- each page needs the previous page's cursor
        const page = await read(cursor);

        labels.push(...labelsOf(page.page));

        if (page.isDone) {
            return labels;
        }

        cursor = page.continueCursor;
    }

    throw new Error("pagination did not terminate");
};

/** The `items` schema: `label` required, `score` nullable and indexed, on a `.global()` table. */
export const nullPlacementSchema = (table: string): SchemaLike => {
    const column = (kind: string, notNull: boolean): ValidatorLike => {
        return { _meta: { column: { notNull } }, kind };
    };

    return {
        tables: {
            [table]: {
                indexes: [{ fields: ["score"], name: "by_score" }],
                shape: { label: column("string", true), score: column("number", false) },
                shardMode: { kind: "global" },
            },
        },
    } as never;
};
