import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SqlCtxExec } from "../src/ctx-db";
import { createSqlCtxDb } from "../src/ctx-db";
import type { SqlDialect } from "../src/dialect";
import { COMBOS, expected, labelsOf, nullPlacementSchema, pagedLabels, ROWS } from "./_helpers/null-placement";
import { createSqliteHarness, makeSqliteDialect } from "./_helpers/sqlite";

/**
 * `orderBy` NULL placement on the SQL store, against `node:sqlite`. The placement each dialect's
 * ORDER BY spells out, and that a page boundary inside the NULL run neither skips nor repeats a row.
 * The workerd twin, against a real D1 binding, is `workerd/null-placement.workerd.test.ts`.
 */
describe("createSqlCtxDb — orderBy null placement", () => {
    const nullSchema = nullPlacementSchema("items");

    let harness: ReturnType<typeof createSqliteHarness>;

    beforeEach(() => {
        harness = createSqliteHarness();
    });

    afterEach(() => {
        harness.close();
    });

    const seed = async (dialect: SqlDialect = makeSqliteDialect(), exec: SqlCtxExec = harness.exec) => {
        let now = 1_700_000_000_000;
        const writer = createSqlCtxDb({
            clock: () => {
                now += 1000;

                return now;
            },
            dialect,
            exec,
            schema: nullSchema,
        });

        for (const [label, score] of ROWS) {
            // eslint-disable-next-line no-await-in-loop -- sequential inserts keep `_creationTime` in input order
            await writer.insert("items", score === null ? { label } : { label, score });
        }

        return writer;
    };

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
        const labels = await pagedLabels((cursor) => writer.findMany("items", { cursor, limit: size, orderBy: [{ score: combo }] }));

        expect(labels).toStrictEqual(expected(combo));
    });

    it.each([
        ["postgres", { nulls: "last", sort: "asc" }, /"score" ASC NULLS LAST/u],
        ["postgres", { nulls: "first", sort: "desc" }, /"score" DESC NULLS FIRST/u],
        ["postgres", "asc", /"score" ASC NULLS FIRST/u],
        ["mysql", { nulls: "last", sort: "asc" }, /\(`score` IS NULL\) ASC, [^,]*`score` ASC,/u],
        ["mysql", { nulls: "first", sort: "desc" }, /\(`score` IS NULL\) DESC, [^,]*`score` DESC,/u],
        ["sqlite", { nulls: "last", sort: "asc" }, /"score" ASC NULLS LAST/u],
    ] as const)("%s emits the placement %j as the ORDER BY it needs", async (name, spec, pattern) => {
        expect.assertions(1);

        const statements: string[] = [];
        const exec: SqlCtxExec = {
            ...harness.exec,
            all: async (query, parameters) => {
                statements.push(query);

                return query.startsWith("SELECT") ? [] : harness.exec.all(query, parameters);
            },
        };
        const writer = createSqlCtxDb({ clock: () => 1, dialect: { ...makeSqliteDialect(), name }, exec, schema: nullSchema });

        await writer.findMany("items", { orderBy: [{ score: spec }] }).catch(() => undefined);

        expect(statements.find((statement) => statement.includes("ORDER BY"))).toMatch(pattern);
    });

    it("leaves a SQLite default placement without a NULLS clause, so its plan is unchanged", async () => {
        expect.assertions(1);

        const statements: string[] = [];
        const exec: SqlCtxExec = {
            ...harness.exec,
            all: async (query, parameters) => {
                statements.push(query);

                return harness.exec.all(query, parameters);
            },
        };
        const writer = await seed(makeSqliteDialect(), exec);

        await writer.findMany("items", { orderBy: [{ score: { nulls: "first", sort: "asc" } }] });

        expect(statements.filter((statement) => statement.includes("ORDER BY")).join("\n")).not.toContain("NULLS");
    });
});
