import { describe, expect, test } from "vitest";

import type { Id, Infer } from "../src/index.js";
import { v, ValidationError } from "../src/index.js";

type Assert<T extends true> = T;
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

describe("primitives", () => {
    test("string parses and rejects", () => {
        expect(v.string().parse("hi")).toBe("hi");
        expect(() => v.string().parse(7)).toThrow(ValidationError);
    });

    test("number rejects NaN", () => {
        expect(v.number().parse(7)).toBe(7);
        expect(() => v.number().parse(Number.NaN)).toThrow(ValidationError);
        expect(() => v.number().parse("7")).toThrow(ValidationError);
    });

    test("boolean", () => {
        expect(v.boolean().parse(true)).toBe(true);
        expect(() => v.boolean().parse("true")).toThrow(ValidationError);
    });

    test("bigint", () => {
        expect(v.bigint().parse(1n)).toBe(1n);
        expect(() => v.bigint().parse(1)).toThrow(ValidationError);
    });

    test("null", () => {
        expect(v.null().parse(null)).toBeNull();
        expect(() => v.null().parse(undefined)).toThrow(ValidationError);
    });

    test("bytes accepts ArrayBuffer only", () => {
        const buffer = new ArrayBuffer(4);

        expect(v.bytes().parse(buffer)).toBe(buffer);
        expect(() => v.bytes().parse(new Uint8Array(4))).toThrow(ValidationError);
    });

    test("literal", () => {
        const validator = v.literal("a");

        expect(validator.parse("a")).toBe("a");
        expect(() => validator.parse("b")).toThrow(ValidationError);
    });

    test("any", () => {
        expect(v.any().parse(42)).toBe(42);
        expect(v.any().parse({ foo: "bar" })).toEqual({ foo: "bar" });
    });
});

describe("composites", () => {
    test("object parses nested validators", () => {
        const schema = v.object({
            count: v.number(),
            name: v.string(),
        });

        expect(schema.parse({ count: 1, name: "x" })).toEqual({ count: 1, name: "x" });
        expect(() => schema.parse({ count: 1 })).toThrow(ValidationError);
    });

    test("object rejects arrays and null", () => {
        const schema = v.object({ x: v.number() });

        expect(() => schema.parse([])).toThrow(ValidationError);
        expect(() => schema.parse(null)).toThrow(ValidationError);
    });

    test("optional allows undefined", () => {
        const schema = v.object({ name: v.string(), nickname: v.optional(v.string()) });

        expect(schema.parse({ name: "a" })).toEqual({ name: "a" });
        expect(schema.parse({ name: "a", nickname: "b" })).toEqual({ name: "a", nickname: "b" });
        expect(() => schema.parse({ name: "a", nickname: 7 })).toThrow(ValidationError);
    });

    test("array parses element-wise and surfaces index in path", () => {
        const schema = v.array(v.number());

        expect(schema.parse([1, 2, 3])).toEqual([1, 2, 3]);

        const result = schema.safeParse([1, "two", 3]);

        expect(result.ok).toBe(false);

        if (!result.ok) {
            expect(result.error.path).toEqual([1]);
        }
    });

    test("union accepts any variant, rejects none", () => {
        const schema = v.union(v.string(), v.number());

        expect(schema.parse("a")).toBe("a");
        expect(schema.parse(1)).toBe(1);
        expect(() => schema.parse(true)).toThrow(ValidationError);
    });

    test("record validates keys and values", () => {
        const schema = v.record(v.string(), v.number());

        expect(schema.parse({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
        expect(() => schema.parse({ a: "1" })).toThrow(ValidationError);
    });
});

describe("id", () => {
    test("returns branded type for any string", () => {
        const validator = v.id("users");
        const out = validator.parse("any-string");

        expect(out).toBe("any-string");

        // Compile-time: branded type round-trips.
        const idCheck: Assert<Equal<typeof out, Id<"users">>> = true;

        expect(idCheck).toBe(true);
    });

    test("rejects non-string", () => {
        expect(() => v.id("users").parse(7)).toThrow(ValidationError);
    });
});

describe("time validators", () => {
    test("timestamp and date parse epoch-millisecond numbers and reject the rest", () => {
        const now = Date.now();

        expect(v.timestamp().parse(now)).toBe(now);
        expect(v.date().parse(0)).toBe(0);
        expect(() => v.timestamp().parse("2026-01-01")).toThrow(ValidationError);
        expect(() => v.date().parse(Number.NaN)).toThrow(ValidationError);
        expect(() => v.timestamp().parse(Number.POSITIVE_INFINITY)).toThrow(ValidationError);
    });

    test("defaultNow records a Date.now() default factory", () => {
        const { column } = (v.timestamp().defaultNow() as unknown as { _meta: { column: { defaultFn?: () => unknown } } })._meta;

        expect(column.defaultFn).toBeTypeOf("function");
        expect(column.defaultFn?.()).toBeTypeOf("number");
    });
});

describe("$type override", () => {
    test("retypes the validator without changing runtime parsing", () => {
        const userId = v.string().$type<Id<"users">>();
        const out = userId.parse("u_123");

        expect(out).toBe("u_123");

        // Compile-time: the override surfaces through Infer.
        const check: Assert<Equal<Infer<typeof userId>, Id<"users">>> = true;

        expect(check).toBe(true);
    });
});

describe("error paths", () => {
    test("nested object error includes full path", () => {
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

    test("safeParse returns ok on success", () => {
        const result = v.string().safeParse("hello");

        expect(result.ok).toBe(true);

        if (result.ok) {
            expect(result.value).toBe("hello");
        }
    });
});

describe("type inference", () => {
    test("infer extracts TS type from validator", () => {
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
