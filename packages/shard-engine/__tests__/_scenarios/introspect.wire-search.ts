import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SqlCursor, SqlExec } from "../../src/ctx-db";
import { readTablePage, selectMatchingIds } from "../../src/introspect";
import type { SqlHarness } from "../_helpers/sql-harness";

const TAG = "$lunora.wire$";

let createHarness: () => SqlHarness;
let harness: SqlHarness;

/**
 * Wraps the exec surface so every statement a search runs is recorded with its bound
 * parameters, and the plans can be read back from the same database.
 */
const recordStatements = (exec: SqlExec): { recorded: { params: unknown[]; query: string }[]; sql: SqlExec } => {
    const recorded: { params: unknown[]; query: string }[] = [];
    const sql: SqlExec = {
        exec<T>(query: string, ...params: unknown[]): SqlCursor<T> {
            recorded.push({ params, query });
            return exec.exec<T>(query, ...params);
        },
    };

    return { recorded, sql };
};

/**
 * Wire-frame search over the table-wide and top-level `contains` paths (#1343). The table is
 * named `docs` on purpose: it is the name the classification uses for a CTE, so it proves a
 * user table is never shadowed by an internal name.
 */
const runWireSearchScenarios = (factory: () => SqlHarness): void => {
    createHarness = factory;

    describe("introspect wire-frame search (#1343)", () => {
        beforeEach(() => {
            harness = createHarness();
            harness.raw(`CREATE TABLE "docs" ("id" TEXT PRIMARY KEY, "_creationTime" REAL NOT NULL, "__doc__" TEXT NOT NULL)`);
            // Many frames under one field, so every candidate leaf is a frame element that matches the term.
            const items = Array.from({ length: 40 }, (_, index) => [TAG, "date", `payload-${String(index)}`]);

            harness.sql.exec(`INSERT INTO "docs" VALUES (?, ?, ?)`, "d1", 1, JSON.stringify({ items, title: "hello" }));
        });

        afterEach(() => {
            harness.close();
        });

        /** The plan of every statement a search ran, one array of plan lines per statement. */
        const plansOf = (run: (sql: SqlExec) => void): string[][] => {
            const { recorded, sql } = recordStatements(harness.sql);

            run(sql);

            return recorded.map(({ params, query }) =>
                harness.sql
                    .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, ...params)
                    .toArray()
                    .map((row) => row.detail),
            );
        };

        /**
         * The statements that classify the frames of a document. Each must materialize the
         * classification once. A correlated form re-materializes it for every candidate leaf,
         * which is the quadratic cost of #1343, and shows up as a second materialization.
         */
        const expectClassifiedOnce = (plans: string[][]): void => {
            const materializations = plans
                .filter((plan) => plan.some((detail) => detail.includes("__wf_tree")))
                .map((plan) => plan.filter((detail) => detail === "MATERIALIZE __wf_tree").length);

            expect(materializations).not.toHaveLength(0);
            expect(materializations.every((count) => count === 1)).toBe(true);
        };

        it("classifies a framed document once per statement, a table-wide search", () => {
            expect.assertions(3);

            expectClassifiedOnce(plansOf((sql) => readTablePage(sql, { search: "date", table: "docs" })));

            expect(readTablePage(harness.sql, { search: "payload-7", table: "docs" }).total).toBe(1);
        });

        it("classifies a framed document once per statement, a top-level contains on an array field", () => {
            expect.assertions(2);

            expectClassifiedOnce(
                plansOf((sql) => selectMatchingIds(sql, { filters: [{ column: "items", operator: "contains", value: "date" }], table: "docs" })),
            );
        });

        it("matches a term regardless of case, in a plain document and in a framed one", () => {
            expect.assertions(2);

            harness.sql.exec(`INSERT INTO "docs" VALUES (?, ?, ?)`, "p1", 1, JSON.stringify({ title: "Plain Words" }));
            harness.sql.exec(`INSERT INTO "docs" VALUES (?, ?, ?)`, "f1", 1, JSON.stringify({ items: [[TAG, "date", "Framed Words"]] }));

            const matchedIds = (search: string): string[] =>
                readTablePage(harness.sql, { search, table: "docs" })
                    .rows.map((row) => (row as { id: string }).id)
                    .toSorted((left, right) => left.localeCompare(right));

            expect(matchedIds("PLAIN WORDS")).toStrictEqual(["p1"]);
            expect(matchedIds("framed words")).toStrictEqual(["f1"]);
        });

        it("keeps two documents apart that differ only in case, on a case-insensitive document column", () => {
            expect.assertions(1);

            harness.raw(`CREATE TABLE "nocase_docs" ("id" TEXT PRIMARY KEY, "_creationTime" REAL NOT NULL, "__doc__" TEXT NOT NULL COLLATE NOCASE)`);
            // Under `__originals__` the leaf is excluded; under `__ORIGINALS__` it is user data. The
            // documents differ only in that key's case, so a NOCASE comparison must not merge them.
            const frame = [TAG, "date", "stamp"];

            harness.sql.exec(`INSERT INTO "nocase_docs" VALUES (?, ?, ?)`, "a", 1, JSON.stringify({ f: frame, __originals__: { n: "zebra" } }));
            harness.sql.exec(`INSERT INTO "nocase_docs" VALUES (?, ?, ?)`, "b", 1, JSON.stringify({ f: frame, __ORIGINALS__: { n: "zebra" } }));

            const ids = readTablePage(harness.sql, { search: "zebra", table: "nocase_docs" }).rows.map((row) => (row as { id: string }).id);

            expect(ids).toStrictEqual(["b"]);
        });

        it("still excludes the codec's own tag and type name from a table-wide search", () => {
            expect.assertions(2);

            expect(readTablePage(harness.sql, { search: "date", table: "docs" }).total).toBe(0);
            expect(readTablePage(harness.sql, { search: "payload-7", table: "docs" }).total).toBe(1);
        });
    });
};

export default runWireSearchScenarios;
