import { describe, expect, it } from "vitest";

import type { Id, Infer } from "../src/index.js";
import { v, ValidationError } from "../src/index.js";

type Assert<T extends true> = T;
// The canonical type-equality idiom: the single-use `<T>()` params are
// load-bearing (they force structural comparison), so the rule is disabled here.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

const REFINEMENT_RE = /refinement/u;
const LOWERCASE_SLUG_RE = /^[a-z]+$/u;
const EMPTY_RE = /empty/u;
const LOWERCASE_RE = /lowercase/u;

describe("primitives", () => {
    it("string parses and rejects", () => {
        expect.assertions(2);

        expect(v.string().parse("hi")).toBe("hi");
        expect(() => v.string().parse(7)).toThrow(ValidationError);
    });

    it("number rejects NaN", () => {
        expect.assertions(3);

        expect(v.number().parse(7)).toBe(7);
        expect(() => v.number().parse(Number.NaN)).toThrow(ValidationError);
        expect(() => v.number().parse("7")).toThrow(ValidationError);
    });

    it("boolean", () => {
        expect.assertions(2);

        expect(v.boolean().parse(true)).toBe(true);
        expect(() => v.boolean().parse("true")).toThrow(ValidationError);
    });

    it("bigint", () => {
        expect.assertions(2);

        expect(v.bigint().parse(1n)).toBe(1n);
        expect(() => v.bigint().parse(1)).toThrow(ValidationError);
    });

    it("null", () => {
        expect.assertions(2);

        expect(v.null().parse(null)).toBeNull();
        expect(() => v.null().parse(undefined)).toThrow(ValidationError);
    });

    it("bytes accepts ArrayBuffer only", () => {
        expect.assertions(2);

        const buffer = new ArrayBuffer(4);

        expect(v.bytes().parse(buffer)).toBe(buffer);
        expect(() => v.bytes().parse(new Uint8Array(4))).toThrow(ValidationError);
    });

    it("literal", () => {
        expect.assertions(2);

        const validator = v.literal("a");

        expect(validator.parse("a")).toBe("a");
        expect(() => validator.parse("b")).toThrow(ValidationError);
    });

    it("any", () => {
        expect.assertions(2);

        expect(v.any().parse(42)).toBe(42);
        expect(v.any().parse({ foo: "bar" })).toEqual({ foo: "bar" });
    });
});

describe("composites", () => {
    it("object parses nested validators", () => {
        expect.assertions(2);

        const schema = v.object({
            count: v.number(),
            name: v.string(),
        });

        expect(schema.parse({ count: 1, name: "x" })).toEqual({ count: 1, name: "x" });
        expect(() => schema.parse({ count: 1 })).toThrow(ValidationError);
    });

    it("object rejects arrays and null", () => {
        expect.assertions(2);

        const schema = v.object({ x: v.number() });

        expect(() => schema.parse([])).toThrow(ValidationError);
        expect(() => schema.parse(null)).toThrow(ValidationError);
    });

    it("optional allows undefined", () => {
        expect.assertions(3);

        const schema = v.object({ name: v.string(), nickname: v.optional(v.string()) });

        expect(schema.parse({ name: "a" })).toEqual({ name: "a" });
        expect(schema.parse({ name: "a", nickname: "b" })).toEqual({ name: "a", nickname: "b" });
        expect(() => schema.parse({ name: "a", nickname: 7 })).toThrow(ValidationError);
    });

    it("array parses element-wise and surfaces index in path", () => {
        expect.hasAssertions();

        const schema = v.array(v.number());

        expect(schema.parse([1, 2, 3])).toEqual([1, 2, 3]);

        const result = schema.safeParse([1, "two", 3]);

        expect(result.ok).toBe(false);

        if (!result.ok) {
            expect(result.error.path).toEqual([1]);
        }
    });

    it("union accepts any variant, rejects none", () => {
        expect.assertions(3);

        const schema = v.union(v.string(), v.number());

        expect(schema.parse("a")).toBe("a");
        expect(schema.parse(1)).toBe(1);
        expect(() => schema.parse(true)).toThrow(ValidationError);
    });

    it("record validates keys and values", () => {
        expect.assertions(2);

        const schema = v.record(v.string(), v.number());

        expect(schema.parse({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
        expect(() => schema.parse({ a: "1" })).toThrow(ValidationError);
    });
});

describe("id", () => {
    it("returns branded type for any string", () => {
        expect.assertions(2);

        const validator = v.id("users");
        const out = validator.parse("any-string");

        expect(out).toBe("any-string");

        // Compile-time: branded type round-trips.
        const idCheck: Assert<Equal<typeof out, Id<"users">>> = true;

        expect(idCheck).toBe(true);
    });

    it("rejects non-string", () => {
        expect.assertions(1);

        expect(() => v.id("users").parse(7)).toThrow(ValidationError);
    });
});

describe("time validators", () => {
    it("timestamp and date parse epoch-millisecond numbers and reject the rest", () => {
        expect.assertions(5);

        const now = Date.now();

        expect(v.timestamp().parse(now)).toBe(now);
        expect(v.date().parse(0)).toBe(0);
        expect(() => v.timestamp().parse("2026-01-01")).toThrow(ValidationError);
        expect(() => v.date().parse(Number.NaN)).toThrow(ValidationError);
        expect(() => v.timestamp().parse(Number.POSITIVE_INFINITY)).toThrow(ValidationError);
    });

    it("defaultNow records a Date.now() default factory", () => {
        expect.assertions(2);

        const { column } = (v.timestamp().defaultNow() as unknown as { _meta: { column: { defaultFn?: () => unknown } } })._meta;

        expect(column.defaultFn).toBeTypeOf("function");
        expect(column.defaultFn?.()).toBeTypeOf("number");
    });
});

describe("$type override", () => {
    it("retypes the validator without changing runtime parsing", () => {
        expect.assertions(2);

        const userId = v.string().$type<Id<"users">>();
        const out = userId.parse("u_123");

        expect(out).toBe("u_123");

        // Compile-time: the override surfaces through Infer.
        const check: Assert<Equal<Infer<typeof userId>, Id<"users">>> = true;

        expect(check).toBe(true);
    });
});

describe("error paths", () => {
    it("nested object error includes full path", () => {
        expect.hasAssertions();

        const schema = v.object({
            users: v.array(v.object({ email: v.string() })),
        });

        const result = schema.safeParse({ users: [{ email: "ok" }, { email: 42 }] });

        expect(result.ok).toBe(false);

        if (!result.ok) {
            expect(result.error.path).toEqual(["users", 1, "email"]);
            expect(result.error.expected).toBe("string");
            expect(result.error.received).toBe("number");
        }
    });

    it("safeParse returns ok on success", () => {
        expect.hasAssertions();

        const result = v.string().safeParse("hello");

        expect(result.ok).toBe(true);

        if (result.ok) {
            expect(result.value).toBe("hello");
        }
    });
});

describe("type inference", () => {
    it("infer extracts TS type from validator", () => {
        expect.assertions(2);

        const schema = v.object({
            age: v.number(),
            name: v.string(),
            tags: v.array(v.string()),
        });

        const sample: Infer<typeof schema> = { age: 1, name: "a", tags: ["a"] };

        expect(sample.age).toBe(1);

        // Compile-time: schema infers required keys.
        type Inferred = Infer<typeof schema>;
        const ageCheck: Assert<Equal<Inferred["age"], number>> = true;
        const tagsCheck: Assert<Equal<Inferred["tags"], string[]>> = true;

        expect(ageCheck && tagsCheck).toBe(true);
    });
});

describe(".check() refinement", () => {
    it("passes when the predicate holds", () => {
        expect.assertions(2);

        const nonNeg = v.number().check((n) => n >= 0);

        expect(nonNeg.parse(0)).toBe(0);
        expect(nonNeg.parse(42)).toBe(42);
    });

    it("throws ValidationError with the user message when the predicate fails", () => {
        expect.hasAssertions();

        const nonNeg = v.number().check((n) => n >= 0, "must be non-negative");

        try {
            nonNeg.parse(-1);

            expect.fail("expected ValidationError");
        } catch (error: unknown) {
            expect(error).toBeInstanceOf(ValidationError);

            if (error instanceof ValidationError) {
                expect(error.expected).toBe("must be non-negative");
                // describeValue stringifies primitives by their typeof.
                expect(error.received).toBe("number");
                expect(error.message).toContain("non-negative");
            }
        }
    });

    it("uses a default message when none is supplied", () => {
        expect.hasAssertions();

        const evenOnly = v.number().check((n) => n % 2 === 0);

        try {
            evenOnly.parse(3);

            expect.fail("expected ValidationError");
        } catch (error: unknown) {
            expect(error).toBeInstanceOf(ValidationError);

            if (error instanceof ValidationError) {
                expect(error.expected).toMatch(REFINEMENT_RE);
            }
        }
    });

    it("composes — multiple .check() calls all must pass", () => {
        expect.assertions(3);

        const slug = v
            .string()
            .check((s) => s.length > 0, "must not be empty")
            .check((s) => LOWERCASE_SLUG_RE.test(s), "lowercase letters only");

        expect(slug.parse("hello")).toBe("hello");
        expect(() => slug.parse("")).toThrow(EMPTY_RE);
        expect(() => slug.parse("Hello")).toThrow(LOWERCASE_RE);
    });

    it("runs after the inner parser — type errors surface first", () => {
        expect.hasAssertions();

        const positiveInt = v.number().check((n) => Number.isInteger(n) && n > 0);

        // Non-number fails the underlying number parser, not the refinement.
        try {
            positiveInt.parse("3");

            expect.fail("expected ValidationError");
        } catch (error: unknown) {
            expect(error).toBeInstanceOf(ValidationError);

            if (error instanceof ValidationError) {
                expect(error.expected).toBe("number");
            }
        }
    });

    it("works on column validators and preserves modifier chain", () => {
        expect.assertions(2);

        const slug = v
            .string()
            .check((s) => s.length > 0, "must not be empty")
            .unique();

        // The validator runtime is the same parse() path — refinement still fires.
        expect(() => slug.parse("")).toThrow(EMPTY_RE);
        expect(slug.parse("hello")).toBe("hello");
    });

    it("safeParse surfaces a check failure as ok:false", () => {
        expect.hasAssertions();

        const positive = v.number().check((n) => n > 0, "must be positive");
        const failure = positive.safeParse(-3);

        expect(failure.ok).toBe(false);

        if (!failure.ok) {
            expect(failure.error.expected).toBe("must be positive");
        }
    });
});
