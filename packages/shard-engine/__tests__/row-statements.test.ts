import { sql as dsql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { CDC_APPEND_SQL } from "../src/ctx-db-cdc";
import { DOC_COLUMN } from "../src/do-sql";
import { renderSql, unionAll } from "../src/drizzle";
import { CHANGES_PROBE_SQL, deleteRowSql, insertRowSql, patchRowSql, replaceRowSql, rowProbeParams, rowProbeSql } from "../src/row-statements";

/**
 * The write path used to build each of these through a drizzle `sql` template on
 * every write. They are now literal text, rendered once per table — which is
 * only safe while the text is *identical* to what those templates produced.
 *
 * So each case rebuilds the original template verbatim and asserts byte
 * equality with the statement that replaced it. A change to either side that
 * does not match the other fails here rather than reaching SQLite, where the
 * symptom would be a syntax error at best and a wrong `WHERE` at worst.
 *
 * The parameter ORDER is asserted alongside, because that is the other half of
 * the contract: the call sites now pass a positional array instead of
 * interpolating values into a template, so a statement whose placeholders moved
 * would bind the wrong values with no type error.
 */

const TABLE = "messages";

/** What `renderSql` produced for a template, as the pair the call sites now pass. */
const rendered = (query: Parameters<typeof renderSql>[1]): { params: unknown[]; sql: string } => renderSql("sqlite", query);

describe("row statements match the drizzle templates they replaced", () => {
    it("insert", () => {
        expect.assertions(2);

        const id = "m1";
        const creationTime = 1_700_000_000_000;
        const doc = '{"a":1}';
        const original = rendered(
            dsql`INSERT INTO ${dsql.identifier(TABLE)} (id, _creationTime, ${dsql.identifier(DOC_COLUMN)}) VALUES (${id}, ${creationTime}, ${doc})`,
        );

        expect(insertRowSql(TABLE)).toBe(original.sql);
        expect(original.params).toStrictEqual([id, creationTime, doc]);
    });

    it("patch", () => {
        expect.assertions(2);

        const next = '{"a":2}';
        const id = "m1";
        const existing = '{"a":1}';
        const original = rendered(
            dsql`UPDATE ${dsql.identifier(TABLE)} SET ${dsql.identifier(DOC_COLUMN)} = ${next} WHERE id = ${id} AND ${dsql.identifier(DOC_COLUMN)} = ${existing}`,
        );

        expect(patchRowSql(TABLE)).toBe(original.sql);
        expect(original.params).toStrictEqual([next, id, existing]);
    });

    it("replace", () => {
        expect.assertions(2);

        const creationTime = 1_700_000_000_000;
        const next = '{"a":2}';
        const id = "m1";
        const existing = '{"a":1}';
        const original = rendered(
            dsql`UPDATE ${dsql.identifier(TABLE)} SET _creationTime = ${creationTime}, ${dsql.identifier(DOC_COLUMN)} = ${next} WHERE id = ${id} AND ${dsql.identifier(DOC_COLUMN)} = ${existing}`,
        );

        expect(replaceRowSql(TABLE)).toBe(original.sql);
        expect(original.params).toStrictEqual([creationTime, next, id, existing]);
    });

    it("delete", () => {
        expect.assertions(2);

        const id = "m1";
        const existing = '{"a":1}';
        const original = rendered(dsql`DELETE FROM ${dsql.identifier(TABLE)} WHERE id = ${id} AND ${dsql.identifier(DOC_COLUMN)} = ${existing}`);

        expect(deleteRowSql(TABLE)).toBe(original.sql);
        expect(original.params).toStrictEqual([id, existing]);
    });

    it("changes() probe", () => {
        expect.assertions(1);

        expect(CHANGES_PROBE_SQL).toBe(rendered(dsql`SELECT changes() AS changed`).sql);
    });

    it("cdc append", () => {
        expect.assertions(2);

        const ts = 1_700_000_000_000;
        const table = TABLE;
        const id = "m1";
        const op = "insert";
        const doc = '{"a":1}';
        const original = rendered(
            dsql`INSERT INTO ${dsql.identifier("__cdc_log")} (ts, ${dsql.identifier("table")}, id, op, doc) VALUES (${ts}, ${table}, ${id}, ${op}, ${doc})`,
        );

        expect(CDC_APPEND_SQL).toBe(original.sql);
        expect(original.params).toStrictEqual([ts, table, id, op, doc]);
    });
});

describe("by-id row probe", () => {
    /** The template the probe replaced, for one chunk of tables. */
    const originalProbe = (tables: string[], id: string) =>
        rendered(
            dsql`${unionAll(
                tables.map(
                    (table) =>
                        dsql`SELECT ${dsql.raw(`'${table.replaceAll("'", "''")}'`)} AS __t__, id, _creationTime, ${dsql.identifier(DOC_COLUMN)} FROM ${dsql.identifier(table)} WHERE id = ${id}`,
                ),
            )} LIMIT 1`,
        );

    it.each([[["messages"]], [["messages", "users"]], [["a", "b", "c", "d", "e"]], [["a", "b", "c", "d", "e", "f", "g"]]])(
        "matches the template it replaced for %j",
        (tables) => {
            expect.assertions(2);

            // The 7-table case is past workerd's five-term compound-SELECT cap, so
            // it exercises `unionAll`'s nesting — the structural part that is
            // rendered rather than hand-written.
            const original = originalProbe(tables, "row_1");

            expect(rowProbeSql(tables)).toBe(original.sql);
            // One bound `id` per branch, in branch order.
            expect(rowProbeParams("row_1", tables)).toStrictEqual(original.params);
        },
    );

    it("does not let two different table lists share one cached statement", () => {
        expect.assertions(2);

        // A table name may contain any character, so a key built by joining on a
        // separator would serve one list's SQL to the other — a wrong-table read.
        const left = rowProbeSql(["a b", "c"]);
        const right = rowProbeSql(["a", "b c"]);

        expect(left).not.toBe(right);
        expect(right).toBe(originalProbe(["a", "b c"], "row_1").sql);
    });

    it("escapes a single quote in the table discriminator", () => {
        expect.assertions(1);

        // The discriminator is an inline literal, not a bound value — the one
        // place in these statements where a table name reaches the text unquoted.
        expect(rowProbeSql(["ev'il"])).toContain("'ev''il' AS __t__");
    });
});

describe("per-table statement caching", () => {
    it("returns the same string for a repeated table and a distinct one per table", () => {
        expect.assertions(3);

        expect(insertRowSql(TABLE)).toBe(insertRowSql(TABLE));
        expect(insertRowSql("other")).not.toBe(insertRowSql(TABLE));
        expect(insertRowSql("other")).toContain('"other"');
    });

    it("escapes a table name carrying a double quote the way drizzle does", () => {
        expect.assertions(2);

        // The cache is keyed by raw table name and the text is spliced, so this is
        // the one input where a wrong quoter becomes identifier injection rather
        // than a syntax error.
        const nasty = 'ev"il';
        const original = rendered(dsql`DELETE FROM ${dsql.identifier(nasty)} WHERE id = ${"x"} AND ${dsql.identifier(DOC_COLUMN)} = ${"y"}`);

        expect(deleteRowSql(nasty)).toBe(original.sql);
        expect(deleteRowSql(nasty)).toContain('"ev""il"');
    });
});
