import type { Validator } from "@lunora/values";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { generateValue } from "../src/generate-value";

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
        ["int().min(0.5)", v.number().int().min(0.5)],
        ["int().min(3).max(5)", v.number().int().min(3).max(5)],
        ["array.min(5)", v.array(v.string()).min(5)],
        ["array.max(0)", v.array(v.string()).max(0)],
        ["array.min(4).max(4)", v.array(v.string()).min(4).max(4)],
        ["array.max(2)", v.array(v.string()).max(2)],
    ])("%s passes its own validator across many inputs", (_name, validator) => {
        expect.hasAssertions();

        for (let index = 0; index < 200; index += 1) {
            expect(accepts(validator, generateValue(validator, "amount", ["constraint", index], NOW))).toBe(true);
        }
    });

    it("emits a whole number for int() with no bounds", () => {
        expect.hasAssertions();

        for (let index = 0; index < 50; index += 1) {
            expect(Number.isInteger(generateValue(v.number().int(), "amount", ["int", index], NOW))).toBe(true);
        }
    });
});
