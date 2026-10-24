import { defineSchema, defineTable } from "@lunora/server";
import type { Validator } from "@lunora/values";
import { v } from "@lunora/values";
import { describe, expect, it, vi } from "vitest";

import { copycat } from "../src/copycat";
import { generateValue } from "../src/generate-value";
import { seedPlan } from "../src/plan";
import { planUniqueDeal } from "../src/unique-value";

const NOW = 1_785_000_000_000;

/** True when the validator itself accepts `value` (the check `ctx.db.insert` makes). */
const accepts = (validator: Validator, value: unknown): boolean => {
    const result = (validator as unknown as { "~standard": { validate: (value: unknown) => { issues?: unknown } } })["~standard"].validate(value);

    return result.issues === undefined;
};

describe("generateValue — validator constraints the generator must honour", () => {
    it.each([
        ["positive()", v.number().positive()],
        ["positive().int()", v.number().positive().int()],
        // Narrower than the fixed epsilon a float exclusive minimum used to be nudged by.
        ["positive().max(0.0000005)", v.number().positive().max(0.000_000_5)],
        ["int().min(0.5)", v.number().int().min(0.5)],
        ["int().min(3).max(5)", v.number().int().min(3).max(5)],
        ["array.min(5)", v.array(v.string()).min(5)],
        ["array.max(0)", v.array(v.string()).max(0)],
        ["array.min(4).max(4)", v.array(v.string()).min(4).max(4)],
        ["array.max(2)", v.array(v.string()).max(2)],
        ["array.max(2.5)", v.array(v.string()).max(2.5)],
        ["array.max(0.5)", v.array(v.string()).max(0.5)],
        ["array.min(1.5).max(3)", v.array(v.string()).min(1.5).max(3)],
    ])("%s passes its own validator across many inputs", (_name, validator) => {
        expect.hasAssertions();

        for (let index = 0; index < 200; index += 1) {
            expect(accepts(validator, generateValue(validator, "amount", ["constraint", index], NOW))).toBe(true);
        }
    });

    it("deals a .unique() float column narrower than the exclusive-minimum nudge", () => {
        expect.hasAssertions();

        const validator = v.number().positive().max(0.000_000_5);
        const { rows } = seedPlan(defineSchema({ dust: defineTable({ grams: validator.unique() }) }), { counts: { dust: 20 } })[0]!;

        expect(new Set(rows.map((row) => row.grams)).size).toBe(20);
        expect(rows.every((row) => accepts(validator, row.grams))).toBe(true);
    });

    it("emits a whole number for int() with no bounds", () => {
        expect.hasAssertions();

        for (let index = 0; index < 50; index += 1) {
            expect(Number.isInteger(generateValue(v.number().int(), "amount", ["int", index], NOW))).toBe(true);
        }
    });

    it("keeps lengths whole for fractional array limits", () => {
        expect.hasAssertions();

        const lengths = new Set<number>();

        for (let index = 0; index < 200; index += 1) {
            lengths.add((generateValue(v.array(v.string()).min(0.5).max(2.5), "tags", ["array", index], NOW) as unknown[]).length);
        }

        expect([...lengths].toSorted((a, b) => a - b)).toStrictEqual([1, 2]);
    });

    it("treats an infinite array maximum as no maximum", () => {
        expect.hasAssertions();

        const validator = v.array(v.string()).max(Number.POSITIVE_INFINITY);
        // Stubbed because forwarding an infinite count to the real generator never returns.
        const times = vi.spyOn(copycat, "times").mockReturnValue([]);

        try {
            generateValue(validator, "tags", "input", NOW);

            expect(times.mock.calls[0]![1]).toStrictEqual([1, 3]);
        } finally {
            times.mockRestore();
        }

        for (let index = 0; index < 50; index += 1) {
            expect(accepts(validator, generateValue(validator, "tags", ["inf", index], NOW))).toBe(true);
        }
    });

    it("refuses array limits no whole length satisfies", () => {
        expect.hasAssertions();
        expect(() => generateValue(v.array(v.string()).min(1.2).max(1.8), "tags", "input", NOW)).toThrow(/no whole array length/u);
    });

    it("seeds 1 for an integer column with exclusive minimum 0.5 and maximum 1", () => {
        expect.hasAssertions();

        const validator = { ...v.number(), _meta: { constraints: { exclusiveMinimum: 0.5, maximum: 1, type: "integer" } } } as unknown as Validator;

        expect(generateValue(validator, "amount", "input", NOW)).toBe(1);
    });

    describe.each([
        ["a float", {}],
        ["an integer", { type: "integer" }],
    ])("an exclusive minimum too large for a fixed step, %s column", (_label, extra) => {
        const validator = { ...v.number(), _meta: { constraints: { exclusiveMinimum: 1e20, ...extra } } } as unknown as Validator;

        it("generates a value strictly above it", () => {
            expect.hasAssertions();

            for (let index = 0; index < 20; index += 1) {
                expect(generateValue(validator, "amount", ["huge", index], NOW) as number).toBeGreaterThan(1e20);
            }
        });

        it("deals only values strictly above it, and never repeats one", () => {
            expect.hasAssertions();

            const { capacity, valueAt } = planUniqueDeal(
                { hasServerDefault: false, kind: "number", name: "amount", nullable: false, optional: false, unique: true, validator },
                { now: NOW, table: "t" },
            );
            const values = Array.from({ length: Math.min(capacity, 3) }, (_, index) => valueAt(index, () => 0) as number);

            expect(values.every((value) => value > 1e20)).toBe(true);
            expect(new Set(values).size).toBe(values.length);
        });
    });

    describe.each([
        ["a float", {}],
        ["an integer", { type: "integer" }],
    ])("an exclusive minimum below the safe integers, %s column", (_label, extra) => {
        it.each([-(2 ** 53), -(2 ** 54), -1e20])("deals distinct values strictly above %s", (exclusiveMinimum) => {
            expect.hasAssertions();

            const validator = { ...v.number(), _meta: { constraints: { exclusiveMinimum, ...extra } } } as unknown as Validator;
            const { valueAt } = planUniqueDeal(
                { hasServerDefault: false, kind: "number", name: "amount", nullable: false, optional: false, unique: true, validator },
                { now: NOW, table: "t" },
            );
            const values = Array.from({ length: 4 }, (_, index) => valueAt(index, () => 0) as number);

            expect(values.every((value) => value > exclusiveMinimum)).toBe(true);
            expect(new Set(values).size).toBe(values.length);
        });
    });

    it("refuses a second row for a unique integer range past the safe integers", () => {
        expect.hasAssertions();

        const schema = defineSchema({
            ids: defineTable({
                big: v
                    .number()
                    .int()
                    .min(2 ** 53)
                    .max(2 ** 53 + 4)
                    .unique(),
            }),
        });

        expect(() => seedPlan(schema, { counts: { ids: 2 } })).toThrow(/unique column "big" has only 1 possible values/u);
    });

    it("keeps epoch-ms for a time-named .positive() column", () => {
        expect.hasAssertions();

        const value = generateValue(v.number().positive(), "createdAt", "input", NOW) as number;

        expect(value).toBeGreaterThan(NOW - 365 * 24 * 60 * 60 * 1000);
        expect(value).toBeLessThanOrEqual(NOW);

        const { rows } = seedPlan(defineSchema({ events: defineTable({ createdAt: v.number().positive().unique() }) }), {
            counts: { events: 20 },
            now: NOW,
        })[0]!;

        expect(rows.every((row) => (row.createdAt as number) > NOW - 365 * 24 * 60 * 60 * 1000)).toBe(true);
    });

    it("deals more than 1000 distinct rows for an open .int().positive().unique() column", () => {
        expect.hasAssertions();

        const validator = v.number().int().positive();
        const { rows } = seedPlan(defineSchema({ items: defineTable({ rank: validator.unique() }) }), { counts: { items: 1500 } })[0]!;

        expect(new Set(rows.map((row) => row.rank)).size).toBe(1500);
        expect(rows.every((row) => accepts(validator, row.rank))).toBe(true);
    });
});
