import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { renderSql } from "../src/drizzle";
import { buildSeekWhere, CURSOR_PREFIX, decodeCursor, encodeCursor, normalizeOrderKeys } from "../src/query-args";
import type { WhereSqlStrategy } from "../src/where-sql";
import { compileWhereSql } from "../src/where-sql";
import type { WhereInput } from "../src/where-types";

const DOC_COLUMN = "__doc__";

const json = (field: string): string => `json_extract(${DOC_COLUMN}, '$.${field}')`;

const doFieldRef = (field: string): string => {
    if (field === "_id" || field === "id") {
        return "id";
    }

    if (field === "_creationTime") {
        return "_creationTime";
    }

    return json(field);
};

const doStrategy: WhereSqlStrategy = { fieldRef: (field) => sql.raw(doFieldRef(field)), serialize: (value) => value };

/** Compile a `where` tree through the drizzle compiler + render it for SQLite — the rendering path `buildSeekWhere`'s output flows through in production. */
const compile = (where: WhereInput): { params: unknown[]; sql: string } => renderSql("sqlite", compileWhereSql(where, doStrategy) ?? sql``);

describe("normalizeOrderKeys", () => {
    it("defaults to creation order when absent", () => {
        expect.assertions(2);

        expect(normalizeOrderKeys(undefined)).toEqual([{ direction: "asc", field: "_creationTime", nullable: false }]);
        expect(normalizeOrderKeys([])).toEqual([{ direction: "asc", field: "_creationTime", nullable: false }]);
    });

    it("flattens the { field: dir }[] form, preserving order", () => {
        expect.assertions(1);

        expect(
            normalizeOrderKeys([{ priority: "desc" }, { createdAt: "asc" }], {
                createdAt: { _meta: { column: { notNull: true } }, kind: "number" },
                priority: { _meta: { column: { notNull: true } }, kind: "number" },
            }),
        ).toEqual([
            { direction: "desc", field: "priority", nullable: false },
            { direction: "asc", field: "createdAt", nullable: false },
        ]);
    });

    it("marks a column nullable through either spelling, and an undeclared one conservatively", () => {
        expect.assertions(1);

        // `.nullable()` clears `column.notNull` and keeps the base kind;
        // `v.optional(inner)` builds a fresh `"optional"` validator whose own
        // column meta carries the DEFAULT `notNull: true`. Reading only `notNull`
        // would call the optional column non-nullable and drop its rows from
        // every page that crosses the null group.
        expect(
            normalizeOrderKeys([{ nulled: "asc" }, { optional: "asc" }, { plain: "asc" }, { undeclared: "asc" }], {
                nulled: { _meta: { column: { notNull: false } }, kind: "number" },
                optional: { _meta: { column: { notNull: true } }, kind: "optional" },
                plain: { _meta: { column: { notNull: true } }, kind: "number" },
            }),
        ).toEqual([
            { direction: "asc", field: "nulled", nullable: true },
            { direction: "asc", field: "optional", nullable: true },
            { direction: "asc", field: "plain", nullable: false },
            { direction: "asc", field: "undeclared", nullable: true },
        ]);
    });
});

describe("encodeCursor / decodeCursor", () => {
    it("round-trips the orderBy values plus id", () => {
        expect.assertions(1);

        const keys = [{ direction: "asc" as const, field: "createdAt", nullable: false }];
        const doc = { _id: "row_42", createdAt: 1700, title: "ignored" };

        const cursor = encodeCursor(doc, keys);

        expect(decodeCursor(cursor)).toEqual([1700, "row_42"]);
    });

    it("survives unicode payloads", () => {
        expect.assertions(1);

        const keys = [{ direction: "asc" as const, field: "name", nullable: false }];
        const doc = { _id: "café", name: "naïve — 日本語" };

        expect(decodeCursor(encodeCursor(doc, keys))).toEqual(["naïve — 日本語", "café"]);
    });

    it("rejects a non-array payload", () => {
        expect.assertions(1);

        // Carries the format marker on purpose. Without it the marker check
        // rejects first and this stops exercising the shape check it is named
        // for — passing for the wrong reason.
        const bogus = CURSOR_PREFIX + btoa(JSON.stringify({ not: "an array" }));

        expect(() => decodeCursor(bogus)).toThrow("invalid cursor");
    });

    it("rejects a cursor with no format marker", () => {
        expect.assertions(1);

        // A cursor minted before the tiebreak direction changed. Its bytes are a
        // perfectly good payload; only the seek's reading of them moved, so the
        // marker is the sole thing that can tell the two apart.
        expect(() => decodeCursor(btoa(JSON.stringify([1, "row-1"])))).toThrow("invalid cursor");
    });
});

describe("buildSeekWhere", () => {
    it("single ascending key expands to a two-branch lexicographic seek", () => {
        expect.assertions(1);

        const where = buildSeekWhere([{ direction: "asc", field: "createdAt", nullable: true }], [1700, "row_42"]);
        const compiled = compile(where);

        expect(compiled).toEqual({
            params: [1700, 1700, "row_42"],
            sql: `(${json("createdAt")} > ?) OR ((${json("createdAt")} = ?) AND (id > ?))`,
        });
    });

    it("descending key uses < for the strict comparison, tiebreak included", () => {
        expect.assertions(1);

        const where = buildSeekWhere([{ direction: "desc", field: "createdAt", nullable: true }], [1700, "row_42"]);
        const compiled = compile(where);

        // `id < ?`, not `id > ?`: the implicit tiebreak sorts the same way the
        // key it breaks does, so the ORDER BY reads `createdAt DESC, id DESC` and
        // the seek has to select rows below the cursor on BOTH terms. A seek that
        // disagreed with its own ORDER BY here would skip or repeat rows at a page
        // boundary that lands inside a group of equal `createdAt`.
        //
        // `OR createdAt IS NULL` on the pivot, and NOT on the `id` tiebreak:
        // SQLite sorts NULLs LAST descending, so a null-scored row sits AFTER
        // every value the comparator can reach and no comparator will ever match
        // it — the descending page would simply stop at the last non-null row. The
        // tiebreak is the framework `id`, which is never null, so it is spared the
        // arm — as is any key whose declared column is `notNull`.
        expect(compiled).toEqual({
            params: [1700, 1700, "row_42"],
            sql: `((${json("createdAt")} < ?) OR (${json("createdAt")} IS NULL)) OR ((${json("createdAt")} = ?) AND (id < ?))`,
        });
    });

    it("omits the null arm entirely when the ordered column cannot hold NULL", () => {
        expect.assertions(1);

        // Same shape as the descending test above with `nullable` cleared: a
        // schema-declared `notNull` column has no null group to reach, so the arm
        // is pure cost. It is not a small one — the second disjunct on the pivot
        // is not answerable from the index range the comparator seeks, so SQLite
        // abandons the seek for a full scan (measured 9.3us -> 469us over 50k
        // rows; see `ctx-db.paginate-plan.test.ts`, which asserts the plan).
        const where = buildSeekWhere([{ direction: "desc", field: "createdAt", nullable: false }], [1700, "row_42"]);

        expect(compile(where)).toEqual({
            params: [1700, 1700, "row_42"],
            sql: `(${json("createdAt")} < ?) OR ((${json("createdAt")} = ?) AND (id < ?))`,
        });
    });

    it("mixed directions chain equality prefixes correctly", () => {
        expect.assertions(2);

        const where = buildSeekWhere(
            [
                { direction: "asc", field: "a", nullable: true },
                { direction: "desc", field: "b", nullable: true },
            ],
            ["av", "bv", "row_1"],
        );
        const compiled = compile(where);

        // Balanced grouping (see `joinClauses`); same terms, same param order.
        // `a` is ascending, so its NULLs sort BEFORE the cursor and the seek is
        // already past them — no null arm. `b` is descending, so its NULLs sort
        // after and it gets one.
        expect(compiled.sql).toBe(
            `(${json("a")} > ?) OR (((${json("a")} = ?) AND ((${json("b")} < ?) OR (${json("b")} IS NULL))) OR ((${json("a")} = ?) AND ((${json("b")} = ?) AND (id < ?))))`,
        );
        expect(compiled.params).toEqual(["av", "av", "bv", "av", "bv", "row_1"]);
    });

    it("an explicit id sort key is used as the terminal column (no synthetic tiebreak)", () => {
        expect.assertions(1);

        const where = buildSeekWhere([{ direction: "asc", field: "id", nullable: false }], ["row_1"]);
        const compiled = compile(where);

        expect(compiled).toEqual({ params: ["row_1"], sql: "id > ?" });
    });

    it("a null pivot value seeks past the null group instead of selecting it", () => {
        expect.assertions(1);

        const where = buildSeekWhere([{ direction: "asc", field: "createdAt", nullable: true }], [null, "row_42"]);
        const compiled = compile(where);

        // `IS NOT NULL`, not `IS NULL`. Every comparator used to fold a null
        // operand into `IS [NOT] NULL`, which is right for `eq`/`ne` and the exact
        // inverse for a range seek: `createdAt IS NULL` matched the whole null
        // group, subsuming the tiebreak branch, so page 2 repeated page 1 forever
        // and no non-null row was ever reachable.
        expect(compiled).toEqual({
            params: ["row_42"],

            sql: `(${json("createdAt")} IS NOT NULL) OR ((${json("createdAt")} IS NULL) AND (id > ?))`,
        });
    });

    it("an absent ordered field is the same pivot as null, and binds nothing", () => {
        expect.assertions(2);

        // `encodeCursor` reads the ordered field off the document verbatim, so a
        // column the document omits arrives as `undefined` — which used to reach
        // the driver as a bound parameter (`Provided value cannot be bound`).
        const where = buildSeekWhere([{ direction: "asc", field: "createdAt", nullable: true }], [undefined, "row_42"]);
        const compiled = compile(where);

        expect(compiled.params).toEqual(["row_42"]);
        expect(compiled.params).not.toContain(undefined);
    });

    it("a descending null pivot has nothing after it but the tiebreak", () => {
        expect.assertions(1);

        // NULLs sort LAST descending, so nothing outside the null group follows
        // this cursor — the pivot branch is unsatisfiable and only the tiebreak
        // can advance.

        const where = buildSeekWhere([{ direction: "desc", field: "createdAt", nullable: true }], [null, "row_42"]);
        const compiled = compile(where);

        expect(compiled).toEqual({
            params: ["row_42"],
            sql: `(0 = 1) OR ((${json("createdAt")} IS NULL) AND (id < ?))`,
        });
    });
});
