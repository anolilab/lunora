import { describe, expect, it } from "vitest";

import { v, ValidationError } from "../src/index";

// Hand-rolled Standard Schema v1 fixture that uppercases strings.
const fakeZodString = {
    "~standard": {
        validate: (value: unknown) =>
            typeof value === "string" ? { value: value.toUpperCase() } : { issues: [{ message: "expected string", path: [] as PropertyKey[] }] },
        vendor: "fake",
        version: 1 as const,
    },
};

// Fixture that always fails and carries a nested path on the first issue.
const fakeNestedFail = {
    "~standard": {
        validate: (_value: unknown) => ({
            issues: [{ message: "name too short", path: ["name", "first"] as PropertyKey[] }],
        }),
        vendor: "fake",
        version: 1 as const,
    },
};

// Async fixture — Standard Schema allows async validate; Cirrus does not.
const fakeAsync = {
    "~standard": {
        validate: async (_value: unknown) => ({ value: "ok" }),
        vendor: "fake",
        version: 1 as const,
    },
};

// Non-native thenable — a custom `then` rather than a real Promise. Must be
// rejected like an async result, not slip past `instanceof Promise` and silently
// return `undefined`.
const fakeThenable = {
    "~standard": {
        validate: (_value: unknown) => {
            // eslint-disable-next-line unicorn/no-thenable -- intentional non-native thenable; the test asserts v.from rejects it like a Promise
            const thenable = {
                then: (resolve: (value: unknown) => void): void => {
                    resolve(undefined);
                },
            };

            return thenable;
        },
        vendor: "fake",
        version: 1 as const,
    },
};

// A real Cirrus validator also satisfies Standard Schema v1 (it exposes ~standard).
const cirrusValidator = v.number();

describe("v.from()", () => {
    it("(1) success passes the transformed value", () => {
        expect.assertions(2);

        const schema = v.from(fakeZodString);

        expect(schema.parse("hello")).toBe("HELLO");
        expect(schema.parse("world")).toBe("WORLD");
    });

    it("(2) failure throws ValidationError with issue message and merged path", () => {
        expect.assertions(3);

        const schema = v.from(fakeNestedFail);
        const result = schema.safeParse({ name: { first: "a" } });

        expect(result.ok).toBe(false);

        if (!result.ok) {
            expect(result.error).toBeInstanceOf(ValidationError);
            // The issue's path ["name", "first"] should appear in the error path
            expect(result.error.path).toEqual(["name", "first"]);
        }
    });

    it("(3) non-Standard-Schema input throws at construction time", () => {
        expect.assertions(1);

        expect(() =>
            v.from(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- testing invalid input
                { not: "a standard schema" } as any,
            ),
        ).toThrow("@cirrus/values: v.from() expects a Standard Schema v1 object");
    });

    it("(4) async validate throws synchronously with a clear error", () => {
        expect.assertions(2);

        const schema = v.from(fakeAsync);
        // The async validate returns a Promise; v.from should throw synchronously.
        const result = schema.safeParse("anything");

        expect(result.ok).toBe(false);

        if (!result.ok) {
            expect(result.error.message).toMatch(/async Standard Schema/u);
        }
    });

    it("(4b) a non-native thenable is rejected like a Promise (not silently passed)", () => {
        expect.assertions(1);

        const schema = v.from(fakeThenable as unknown as Parameters<typeof v.from>[0]);

        expect(() => schema.parse("anything")).toThrow(/async Standard Schema/u);
    });

    it("(5) a Cirrus validator passed through v.from parses unharmed", () => {
        expect.assertions(3);

        const schema = v.from(cirrusValidator);

        expect(schema.parse(42)).toBe(42);
        expect(schema.parse(0)).toBe(0);

        const bad = schema.safeParse("not a number");

        expect(bad.ok).toBe(false);
    });

    it("kind is 'from'", () => {
        expect.assertions(1);

        expect(v.from(fakeZodString).kind).toBe("from");
    });
});
