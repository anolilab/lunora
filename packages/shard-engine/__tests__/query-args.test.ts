import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { encodeWire } from "../../../shared/wire-codec";
import { renderSql } from "../src/drizzle";
import { buildSeekWhere, CURSOR_PREFIX, decodeCursor, encodeCursor, normalizeOrderKeys } from "../src/query-args";
import type { OrderKey } from "../src/schema-types";
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
        expect.assertions(3);

        expect(normalizeOrderKeys(undefined)).toEqual([{ direction: "asc", field: "_creationTime", nullable: false }]);
        expect(normalizeOrderKeys([])).toEqual([{ direction: "asc", field: "_creationTime", nullable: false }]);

        // An id field is already a total order, so nothing is spliced after it —
        // the extra key would only cost a cursor column and a seek disjunct.
        expect(normalizeOrderKeys([{ _id: "asc" }])).toEqual([{ direction: "asc", field: "_id", nullable: false }]);
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
            // Spliced in ahead of the `id` tiebreak, in the last key's direction:
            // every declared index is built `(<fields>, _creationTime, id)`, and an
            // ORDER BY that skips the middle column cannot be answered from it.
            { direction: "asc", field: "_creationTime", nullable: false },
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
            { direction: "asc", field: "_creationTime", nullable: false },
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
    it("accepts a legacy cursor whose absent field is a real `undefined`, at a PREFIX position too", () => {
        expect.assertions(2);

        const keys: OrderKey[] = [
            { direction: "asc", field: "publishedAt", nullable: true },
            { direction: "asc", field: "score", nullable: true },
        ];

        // Built the OLD way — `encodeCursor` normalises at mint now, so a cursor
        // produced by it can no longer carry `undefined`. This is what a client
        // holding a page boundary across the deploy still sends: `encodeWire`
        // tags array-position `undefined` and `decodeWire` restores it.
        const legacy = CURSOR_PREFIX + btoa(JSON.stringify(encodeWire([undefined, 5, "m1"])));
        const values = decodeCursor(legacy);

        // A multi-key seek builds PREFIX predicates as `{ eq: value }`, not just
        // the pivot comparison. Handling the legacy value at the pivot alone left
        // the prefix binding `undefined` verbatim, because the shared `where`
        // compiler passes it straight to the driver on purpose — so a dropped
        // variable in a user's query fails loudly rather than matching every null
        // row. `decodeCursor` collapses it once, on read.
        expect(values).not.toContain(undefined);
        expect(() => buildSeekWhere(keys, values)).not.toThrow();
    });

    it("rejects a truncated cursor instead of seeking the NULL group", () => {
        expect.assertions(2);

        const keys: OrderKey[] = [
            { direction: "asc", field: "publishedAt", nullable: true },
            { direction: "asc", field: "score", nullable: true },
        ];

        // Two ordered keys plus the `_id` tiebreak means three values. A cursor
        // carrying fewer would index past the end, and those missing positions
        // read as `undefined` — which `pivotCondition` accepts as SQL NULL so a
        // cursor minted before normalisation still works. Together that would
        // silently seek the NULL group; a client-supplied value gets a 400.
        expect(() => buildSeekWhere(keys, [1_700_000_000_000])).toThrow(/cursor/i);
        expect(() => buildSeekWhere(keys, [1_700_000_000_000, 5, "m1"])).not.toThrow();
    });

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

    it("omits the null arm entirely when the ordered column cannot hold NULL, and bounds the leading column", () => {
        expect.assertions(1);

        // Same shape as the descending test above with `nullable` cleared: a
        // schema-declared `notNull` column has no null group to reach, so the arm
        // is pure cost. It is not a small one — the second disjunct on the pivot
        // is not answerable from the index range the comparator seeks, so SQLite
        // abandons the seek for a full scan (measured 9.3us -> 469us over 50k
        // rows; see `ctx-db.paginate-plan.test.ts`, which asserts the plan).
        //
        // The leading `createdAt <= ?` conjunct rides on the SAME gate. It is
        // redundant — every disjunct below already constrains `createdAt` — but
        // the planner cannot see that through an OR, so stating it is what turns
        // the index WALK back into an index SEEK. It is emitted only when the
        // pivot is a bare comparator: with the `OR ... IS NULL` arm present it is
        // a second disjunction rather than a bound and buys nothing (measured
        // 816us -> 478us, still `SCAN`), which is why the test above has none.
        const where = buildSeekWhere([{ direction: "desc", field: "createdAt", nullable: false }], [1700, "row_42"]);

        expect(compile(where)).toEqual({
            params: [1700, 1700, 1700, "row_42"],
            sql: `(${json("createdAt")} <= ?) AND ((${json("createdAt")} < ?) OR ((${json("createdAt")} = ?) AND (id < ?)))`,
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

        // NESTED, not flattened: the prefix equality on `a` is factored out and
        // shared by everything below it, so `a` binds twice instead of once per
        // disjunct. Distribute it and the flat form comes back term for term —
        // the point is the parameter count, which goes from `k(k+1)/2` to `2k-1`
        // and is what keeps a wide `orderBy` under Workerd's cap of 100.
        //
        // `a` is ascending, so its NULLs sort BEFORE the cursor and the seek is
        // already past them — no null arm. `b` is descending, so its NULLs sort
        // after and it gets one. `a` is `nullable`, so it gets no leading bound
        // either (see the notNull test above).
        expect(compiled.sql).toBe(
            `(${json("a")} > ?) OR ((${json("a")} = ?) AND (((${json("b")} < ?) OR (${json("b")} IS NULL)) OR ((${json("b")} = ?) AND (id < ?))))`,
        );
        expect(compiled.params).toEqual(["av", "av", "bv", "bv", "row_1"]);
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
