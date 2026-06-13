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
        validate: (_value: unknown) => {
            return {
                issues: [{ message: "name too short", path: ["name", "first"] as PropertyKey[] }],
            };
        },
        vendor: "fake",
        version: 1 as const,
    },
};

// Async fixture — Standard Schema allows async validate; Cirrus does not.
const fakeAsync = {
    "~standard": {
        validate: async (_value: unknown) => {
            return { value: "ok" };
        },
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
            const thenable = {
                // eslint-disable-next-line unicorn/no-thenable -- deliberate: this fixture mimics a non-native thenable that v.from must reject.
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
        const result = schema.safeParse({ name: { first: "a" } }) as { error: ValidationError; ok: false };

        expect(result.ok).toBe(false);
        expect(result.error).toBeInstanceOf(ValidationError);
        // The issue's path ["name", "first"] should appear in the error path
        expect(result.error.path).toEqual(["name", "first"]);
    });

    it("(3) non-Standard-Schema input throws at construction time", () => {
        expect.assertions(1);

        expect(() => v.from({ not: "a standard schema" } as any)).toThrow("@cirrus/values: v.from() expects a Standard Schema v1 object");
    });

    it("(4) async validate throws synchronously with a clear error", () => {
        expect.assertions(2);

        const schema = v.from(fakeAsync);
        // The async validate returns a Promise; v.from should throw synchronously.
        const result = schema.safeParse("anything") as { error: ValidationError; ok: false };

        expect(result.ok).toBe(false);
        expect(result.error.message).toMatch(/async Standard Schema/u);
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

    it("handles a failing issue with no path field (no segments appended)", () => {
        expect.assertions(2);

        // No `path` on the issue — the `if (first?.path)` guard is skipped, so
        // only the context path (here: empty, top-level) is used.
        const noPath = {
            "~standard": {
                validate: (_value: unknown) => {
                    return { issues: [{ message: "boom" }] };
                },
                vendor: "fake",
                version: 1 as const,
            },
        };
        const result = v.from(noPath).safeParse("x") as { error: ValidationError; ok: false };

        expect(result.ok).toBe(false);
        expect(result.error.path).toEqual([]);
    });

    it("unwraps a structured { key } path segment and keeps numeric keys", () => {
        expect.assertions(2);

        // Standard Schema permits `{ key: PropertyKey }` path entries — the object
        // branch of the segment-narrowing must read `.key`. Mix a numeric key (the
        // `typeof key === "number"` branch) with a string key.
        const structured = {
            "~standard": {
                validate: (_value: unknown) => {
                    return { issues: [{ message: "bad", path: [{ key: "items" }, { key: 0 }] }] };
                },
                vendor: "fake",
                version: 1 as const,
            },
        };
        const result = v.from(structured).safeParse("x") as { error: ValidationError; ok: false };

        expect(result.ok).toBe(false);
        expect(result.error.path).toEqual(["items", 0]);
    });

    it("drops a non-string/number path segment (e.g. a symbol key)", () => {
        expect.assertions(2);

        // A symbol key is neither string nor number, so the
        // `typeof key === "string" || typeof key === "number"` guard skips it.
        const sym = Symbol("s");
        const symbolKeyed = {
            "~standard": {
                validate: (_value: unknown) => {
                    return { issues: [{ message: "bad", path: [sym, "kept"] }] };
                },
                vendor: "fake",
                version: 1 as const,
            },
        };
        const result = v.from(symbolKeyed).safeParse("x") as { error: ValidationError; ok: false };

        expect(result.ok).toBe(false);
        // Only the string segment survives; the symbol is filtered out.
        expect(result.error.path).toEqual(["kept"]);
    });

    it("falls back to a default message when the issue carries none", () => {
        expect.assertions(2);

        // No `message` on the issue — the `first?.message ?? "..."` fallback.
        const noMessage = {
            "~standard": {
                validate: (_value: unknown) => {
                    return { issues: [{ path: [] as PropertyKey[] }] };
                },
                vendor: "fake",
                version: 1 as const,
            },
        };
        const result = v.from(noMessage as unknown as Parameters<typeof v.from>[0]).safeParse("x") as { error: ValidationError; ok: false };

        expect(result.ok).toBe(false);
        expect(result.error.message).toBe("Standard Schema validation failed");
    });
});
