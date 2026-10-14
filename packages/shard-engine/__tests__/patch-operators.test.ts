import { describe, expect, it } from "vitest";

import { operatorFields, resolvePatch } from "../src/patch-operators";
import type { TableDefinitionLike, ValidatorLike } from "../src/schema-types";

const col = (kind: string): ValidatorLike => {
    return { _meta: { column: { notNull: true } }, kind };
};

const definition: TableDefinitionLike = {
    indexes: [],
    shape: {
        flag: col("boolean"),
        label: col("string"),
        // `v.optional(v.number())` hides its number kind behind the wrapper.
        maybe: { _meta: { column: { notNull: true }, inner: col("number") }, kind: "optional" },
        // `v.union(v.number(), v.null())`, the Convex-style nullable number.
        maybeUnion: { _meta: { members: [col("number"), col("null")] }, kind: "union" },
        // `v.optional(v.union(v.number(), v.null()))`: the wrapper hides the union and its members.
        optionalUnion: { _meta: { column: { notNull: true }, inner: { _meta: { members: [col("number"), col("null")] }, kind: "union" } }, kind: "optional" },
        // `v.literal(1)` is constrained to its value: an operator would only compute one it then rejects.
        tier: { _meta: { value: 1 }, kind: "literal" },
        meta: col("any"),
        mixed: { _meta: { members: [col("number"), col("string")] }, kind: "union" },
        n: col("number"),
        // `v.timestamp()` / `v.date()` store epoch milliseconds as a plain number.
        startsOn: col("date"),
        updatedAt: col("timestamp"),
    },
};

const row = { flag: false, label: "x", maybe: 4, maybeUnion: 8, meta: {}, mixed: 1, n: 10, optionalUnion: 6, startsOn: 1000, tier: 1, updatedAt: 2000 };

describe("resolvePatch", () => {
    it("applies the arithmetic operators against the current value", () => {
        expect.assertions(4);

        expect(resolvePatch(definition, { n: { increment: 5 } }, row)).toStrictEqual({ n: 15 });
        expect(resolvePatch(definition, { n: { decrement: 3 } }, row)).toStrictEqual({ n: 7 });
        expect(resolvePatch(definition, { n: { multiply: 2 } }, row)).toStrictEqual({ n: 20 });
        expect(resolvePatch(definition, { n: { divide: 4 } }, row)).toStrictEqual({ n: 2.5 });
    });

    it("toggles a boolean and sees through v.optional", () => {
        expect.assertions(2);

        expect(resolvePatch(definition, { flag: { toggle: true } }, row)).toStrictEqual({ flag: true });
        expect(resolvePatch(definition, { maybe: { increment: 1 } }, row)).toStrictEqual({ maybe: 5 });
    });

    it("treats timestamps, dates and a nullable-number union as number columns", () => {
        expect.assertions(3);

        expect(resolvePatch(definition, { updatedAt: { increment: 500 } }, row)).toStrictEqual({ updatedAt: 2500 });
        expect(resolvePatch(definition, { startsOn: { decrement: 1 } }, row)).toStrictEqual({ startsOn: 999 });
        expect(resolvePatch(definition, { maybeUnion: { multiply: 2 } }, row)).toStrictEqual({ maybeUnion: 16 });
    });

    it("sees through an optional wrapper around a nullable-number union", () => {
        expect.assertions(1);

        expect(resolvePatch(definition, { optionalUnion: { increment: 1 } }, row)).toStrictEqual({ optionalUnion: 7 });
    });

    it("does not treat a literal column as a number column", () => {
        expect.assertions(2);

        const patch = { tier: { increment: 1 } };

        expect(resolvePatch(definition, patch, row)).toBe(patch);
        expect(operatorFields(definition, patch).size).toBe(0);
    });

    it("lists the fields that are operators for their column, without resolving anything", () => {
        expect.assertions(1);

        // `divide: 0` would throw if resolved; listing it must not.
        const fields = operatorFields(definition, { flag: { toggle: true }, label: { increment: 1 }, n: { divide: 0 }, title: "x" });

        expect([...fields].toSorted((left, right) => left.localeCompare(right))).toStrictEqual(["flag", "n"]);
    });

    it("leaves a union of a number and a string alone, since it need not hold a number", () => {
        expect.assertions(1);

        const patch = { mixed: { increment: 1 } };

        expect(resolvePatch(definition, patch, row)).toBe(patch);
    });

    it("leaves untouched fields alone and returns the same patch when nothing resolved", () => {
        expect.assertions(3);

        const plain = { label: "y", n: 3 };

        expect(resolvePatch(definition, plain, row)).toBe(plain);
        expect(resolvePatch(definition, { label: "y", n: { increment: 1 } }, row)).toStrictEqual({ label: "y", n: 11 });
        expect(operatorFields(definition, plain).size).toBe(0);
    });

    it("never reads an operator-shaped value on a non-number column as an operator", () => {
        expect.assertions(2);

        const patch = { label: { increment: 1 }, meta: { increment: 1 } };

        expect(resolvePatch(definition, patch, row)).toBe(patch);
        // Kind-aware: neither column takes operators, so neither field is relative to the stored row.
        expect(operatorFields(definition, patch).size).toBe(0);
    });

    it("rejects an operator that cannot be applied", () => {
        expect.assertions(8);

        const reject =
            (patch: Record<string, unknown>, current: Record<string, unknown> = row) =>
            () =>
                resolvePatch(definition, patch, current);

        expect(reject({ n: { divide: 0 } })).toThrow("by zero");
        expect(reject({ n: { increment: Number.NaN } })).toThrow("finite number");
        expect(reject({ n: { increment: "1" } })).toThrow("finite number");
        expect(reject({ n: { multiply: 10 } }, { n: Number.MAX_VALUE })).toThrow("overflows");

        expect(reject({ n: { increment: 1 } }, { n: null })).toThrow("current value is null");
        expect(reject({ n: { toggle: true } })).toThrow("does not apply to the number column");
        expect(reject({ flag: { increment: 1 } })).toThrow("does not apply to the boolean column");
        expect(reject({ flag: { toggle: false } })).toThrow("{ toggle: true }");
    });

    it("raises a VALIDATION_ERROR", () => {
        expect.assertions(1);

        expect(() => resolvePatch(definition, { n: { divide: 0 } }, row)).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    });
});
