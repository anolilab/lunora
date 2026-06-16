import type { Validator } from "@lunora/values";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { generateValue } from "../src/generate-value";

/** Build a validator annotated with JSON-Schema constraint metadata (mirrors how `.check()` attaches `constraints`). */
const withConstraints = (validator: Validator, constraints: Record<string, unknown>): Validator => {
    const inner = validator as { _meta?: Record<string, unknown> };

    return {
        ...validator,
        _meta: { ...(inner._meta ?? {}), constraints },
    } as unknown as Validator;
};

describe("generateValue — string minLength", () => {
    it("generates a string at least minLength chars long (regression: minLength was ignored)", () => {
        expect.hasAssertions();

        const validator = withConstraints(v.string(), { minLength: 20 });
        const value = generateValue(validator, "slug", "test-input");

        expect(typeof value).toBe("string");
        expect((value as string).length).toBeGreaterThanOrEqual(20);
    });

    it("truncates to maxLength when both constraints apply", () => {
        expect.hasAssertions();

        const validator = withConstraints(v.string(), { maxLength: 5, minLength: 3 });
        const value = generateValue(validator, "code", "test-input");

        expect(typeof value).toBe("string");
        expect((value as string).length).toBeGreaterThanOrEqual(3);
        expect((value as string).length).toBeLessThanOrEqual(5);
    });

    it("throws when minLength > maxLength (impossible constraint)", () => {
        expect.hasAssertions();

        const validator = withConstraints(v.string(), { maxLength: 3, minLength: 10 });

        expect(() => generateValue(validator, "code", "test-input")).toThrow(/minLength.*maxLength/u);
    });
});

describe("generateValue — bigint wire representation", () => {
    it("emits a plain number (not BigInt) so the value is JSON-serialisable", () => {
        expect.hasAssertions();

        const value = generateValue(v.bigint(), "count", "test-input");

        expect(typeof value).toBe("number");
        // Must be an integer and within the safe integer range.
        expect(Number.isInteger(value)).toBe(true);
        expect(value as number).toBeGreaterThanOrEqual(0);
        expect(value as number).toBeLessThanOrEqual(1_000_000);
        // Must not throw in JSON.stringify (BigInt would throw).
        expect(() => JSON.stringify(value)).not.toThrow();
    });
});

describe("generateValue — bytes wire representation", () => {
    it("emits a number[] that survives JSON round-trip without a custom replacer", () => {
        expect.hasAssertions();

        const value = generateValue(v.bytes(), "data", "test-input");

        expect(Array.isArray(value)).toBe(true);
        expect((value as number[]).every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)).toBe(true);
        // Must survive JSON.stringify/parse without any custom replacer.
        const roundTripped = JSON.parse(JSON.stringify(value)) as unknown;

        expect(roundTripped).toEqual(value);
    });

    it("produces a revivable ArrayBuffer via Uint8Array.from for the testing adapter", () => {
        expect.hasAssertions();

        const value = generateValue(v.bytes(), "payload", "test-input") as number[];
        const buffer = Uint8Array.from(value).buffer;

        expect(buffer).toBeInstanceOf(ArrayBuffer);
        expect(new Uint8Array(buffer)).toHaveLength(value.length);
    });
});
