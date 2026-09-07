import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it } from "vitest";

import type { Id, Infer } from "../src/index";
import { isOrWrapsFromValidator, v, ValidationError } from "../src/index";
import type { Assert, Equal } from "./__helpers__/type-assert";

const assertOk: (condition: unknown, message: string) => asserts condition = (condition, message) => {
    if (!condition) {
        throw new Error(message);
    }
};

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

    it("object reads declared fields as own-properties, not through the prototype chain", () => {
        expect.assertions(3);

        // A field whose name collides with an Object.prototype member must read
        // as absent when omitted — not as the inherited function.
        const schema = v.object({ toString: v.optional(v.string()), value: v.string() });

        // An absent optional `toString` is skipped; without the own-property read
        // it would see `Object.prototype.toString` and reject `received function`.
        expect(schema.parse({ value: "x" })).toEqual({ value: "x" });
        // A present own `toString` still validates and round-trips.
        expect(schema.parse({ toString: "custom", value: "x" })).toEqual({ toString: "custom", value: "x" });
        // A required field colliding with a prototype member fails when absent.
        expect(() => v.object({ constructor: v.string() }).parse({})).toThrow(ValidationError);
    });

    it("rejects a declared `__proto__` field at construction time instead of silently dropping it at parse time (VALUES-01)", () => {
        expect.assertions(1);

        // Bracket notation creates a REAL own property named "__proto__" on the
        // shape map; the bare-literal form (`{ __proto__: v.string() }`) is a
        // distinct object-literal special case that sets the object's own
        // prototype instead, so it wouldn't exercise this at all. Before this
        // fix, this shape type-checked and built, but a parsed `__proto__` value
        // silently vanished — `out["__proto__"] = …` on a plain `{}` invokes the
        // inherited `Object.prototype` accessor instead of creating a data
        // property (a no-op for a non-object value). Rejecting it here, at
        // construction, surfaces the same collision as a loud, immediate error.
        expect(() => v.object({ ["__proto__"]: v.string(), value: v.number() })).toThrow(/"__proto__"/u);
    });

    it("array parses element-wise and surfaces index in path", () => {
        expect.hasAssertions();

        const schema = v.array(v.number());

        expect(schema.parse([1, 2, 3])).toEqual([1, 2, 3]);

        const result = schema.safeParse([1, "two", 3]);

        assertOk(!result.ok, "expected parse to fail");

        expect(result.ok).toBe(false);
        expect(result.error.path).toEqual([1]);
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

    it("record round-trips keys named constructor/prototype/__proto__", () => {
        expect.assertions(4);

        const schema = v.record(v.string(), v.number());
        // Build via defineProperty so `__proto__` is a real own enumerable key,
        // not a prototype assignment (an object literal would set the proto).
        const protoKey = "__proto__";
        const input: Record<string, number> = { constructor: 1, prototype: 2 };

        Object.defineProperty(input, protoKey, { configurable: true, enumerable: true, value: 3, writable: true });

        const out = schema.parse(input);

        // Legitimate data under those names is preserved, not silently dropped.
        expect(out.constructor).toBe(1);
        expect(out.prototype).toBe(2);
        expect(out[protoKey]).toBe(3);
        // ...and the null-prototype target still blocks Object.prototype pollution.
        expect(Object.getPrototypeOf(out)).toBeNull();
    });

    it("record surfaces the offending key in the value-rejection path", () => {
        expect.hasAssertions();

        const schema = v.record(v.string(), v.number());
        const result = schema.safeParse({ ok: 1, bad: "nope" });

        assertOk(!result.ok, "expected parse to fail");

        expect(result.error.path).toEqual(["bad"]);
        expect(result.error.expected).toBe("number");
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

describe("storage", () => {
    it('parses an object key as a string and tags itself kind "storage"', () => {
        expect.assertions(2);

        const validator = v.storage();

        expect(validator.parse("avatars/u1.png")).toBe("avatars/u1.png");
        expect(validator.kind).toBe("storage");
    });

    it("rejects a non-string key", () => {
        expect.assertions(1);

        expect(() => v.storage().parse(42)).toThrow(ValidationError);
    });

    it("carries the optional bucket name in its meta", () => {
        expect.assertions(1);

        const { bucket } = (v.storage("avatars") as unknown as { _meta: { bucket?: string } })._meta;

        expect(bucket).toBe("avatars");
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

describe(".serverDefault()", () => {
    type ServerDefaultMeta = { _meta: { column: { serverDefault?: (context: { auth: { identity: unknown; userId: unknown } }) => unknown } } };

    it("records a server-default factory on the column meta", () => {
        expect.assertions(2);

        const validator = v.string().serverDefault(({ auth }) => auth.userId ?? "anon");
        const { column } = (validator as unknown as ServerDefaultMeta)._meta;

        expect(column.serverDefault).toBeTypeOf("function");
        expect(column.serverDefault?.({ auth: { identity: null, userId: "u1" } })).toBe("u1");
    });

    it("preserves the chain and still parses its base type", () => {
        expect.assertions(2);

        const validator = v.string().serverDefault(() => "x");

        expect(validator.parse("hello")).toBe("hello");
        expect(() => validator.parse(42)).toThrow(ValidationError);
    });

    it("composes with .nullable() without losing the factory", () => {
        expect.assertions(2);

        const validator = v
            .string()
            .serverDefault(({ auth }) => auth.userId ?? "anon")
            .nullable();
        const { column } = (validator as unknown as ServerDefaultMeta)._meta;

        expect(column.serverDefault).toBeTypeOf("function");
        expect(validator.parse(null)).toBeNull();
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

        assertOk(!result.ok, "expected parse to fail");

        expect(result.ok).toBe(false);
        expect(result.error.path).toEqual(["users", 1, "email"]);
        expect(result.error.expected).toBe("string");
        expect(result.error.received).toBe("number 42");
    });

    it("union nested under an object reports the union's path", () => {
        expect.hasAssertions();

        const schema = v.object({
            role: v.union(v.literal("admin"), v.literal("user")),
        });

        const result = schema.safeParse({ role: "guest" });

        assertOk(!result.ok, "expected parse to fail");

        expect(result.error.path).toEqual(["role"]);
        expect(result.error.expected).toMatch(/union of 2 member/u);
    });

    it("union propagates a non-ValidationError thrown by a member refinement", () => {
        expect.hasAssertions();

        const boom = v.number().check(() => {
            throw new TypeError("boom");
        });
        const schema = v.union(boom, v.string());

        // A programmer error inside a branch is not a branch miss — it surfaces.
        expect(() => schema.parse(1)).toThrow(TypeError);
    });

    it("received carries the concrete primitive and constructor name", () => {
        expect.hasAssertions();

        const stringResult = v.number().safeParse("hi");
        const boolResult = v.string().safeParse(true);
        const dateResult = v.string().safeParse(new Date(0));

        assertOk(!stringResult.ok && !boolResult.ok && !dateResult.ok, "expected parse failures");

        // String literal is quoted so a stringy "7" is distinguishable from 7.
        expect(stringResult.error.received).toBe('string "hi"');
        expect(boolResult.error.received).toBe("boolean true");
        // A named instance surfaces its constructor instead of a bare "object".
        expect(dateResult.error.received).toBe("object Date");
    });

    it("safeParse returns ok on success", () => {
        expect.hasAssertions();

        const result = v.string().safeParse("hello");

        assertOk(result.ok, "expected parse to succeed");

        expect(result.ok).toBe(true);
        expect(result.value).toBe("hello");
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

        let caught: unknown;

        try {
            nonNeg.parse(-1);
        } catch (error: unknown) {
            caught = error;
        }

        assertOk(caught instanceof ValidationError, "expected ValidationError");

        expect(caught).toBeInstanceOf(ValidationError);
        expect(caught.expected).toBe("must be non-negative");
        // A .check() refinement failure redacts the concrete literal to the bare
        // type tag so secret-bearing fields never surface their value.
        expect(caught.received).toBe("number");
        expect(caught.message).toContain("non-negative");
    });

    it("redacts the offending value's literal on a string refinement failure", () => {
        expect.hasAssertions();

        // A secret-bearing string field (correct type, failing predicate) must
        // not echo its value into the ValidationError message/received.
        const minLength = v.string().check((s) => s.length >= 64);
        const secret = "supersecrettoken12345";

        let caught: unknown;

        try {
            minLength.parse(secret);
        } catch (error: unknown) {
            caught = error;
        }

        assertOk(caught instanceof ValidationError, "expected ValidationError");

        expect(caught).toBeInstanceOf(ValidationError);
        expect(caught.received).toBe("string");
        expect(caught.message).not.toContain("supersecret");
    });

    it("keeps the concrete literal for a genuine type mismatch", () => {
        expect.hasAssertions();

        // Redaction is scoped to refinement failures — a type mismatch keeps its
        // literal so `string "7"` vs `number 7` stays a useful diagnostic.
        const failure = v.number().safeParse("7");

        assertOk(!failure.ok, "expected parse to fail");

        expect(failure.error.received).toBe('string "7"');
    });

    it("uses a default message when none is supplied", () => {
        expect.hasAssertions();

        const evenOnly = v.number().check((n) => n % 2 === 0);

        let caught: unknown;

        try {
            evenOnly.parse(3);
        } catch (error: unknown) {
            caught = error;
        }

        assertOk(caught instanceof ValidationError, "expected ValidationError");

        expect(caught).toBeInstanceOf(ValidationError);
        expect(caught.expected).toMatch(REFINEMENT_RE);
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
        let caught: unknown;

        try {
            positiveInt.parse("3");
        } catch (error: unknown) {
            caught = error;
        }

        assertOk(caught instanceof ValidationError, "expected ValidationError");

        expect(caught).toBeInstanceOf(ValidationError);
        expect(caught.expected).toBe("number");
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

        assertOk(!failure.ok, "expected parse to fail");

        expect(failure.ok).toBe(false);
        expect(failure.error.expected).toBe("must be positive");
    });

    it("accepts the CheckOptions object form and still enforces the predicate", () => {
        expect.hasAssertions();

        const nonEmpty = v.string().check((s) => s.length > 0, { message: "non-empty", schema: { minLength: 1 } });

        expect(nonEmpty.parse("hi")).toBe("hi");

        const failure = nonEmpty.safeParse("");

        assertOk(!failure.ok, "expected parse to fail");

        expect(failure.error.expected).toBe("non-empty");
    });
});

describe("standard schema (~standard)", () => {
    it("exposes the v1 props with the lunora vendor", () => {
        expect.assertions(3);

        const schema = v.string();

        expect(schema["~standard"].version).toBe(1);
        expect(schema["~standard"].vendor).toBe("lunora");
        expect(typeof schema["~standard"].validate).toBe("function");
    });

    it("type-checks as a StandardSchemaV1", () => {
        expect.assertions(1);

        // Type-level assertion: every factory result satisfies the spec interface.
        const schema: StandardSchemaV1<string, string> = v.string();
        const obj: StandardSchemaV1 = v.object({ name: v.string() });

        expect(schema["~standard"].vendor).toBe(obj["~standard"].vendor);
    });

    it("validate returns { value } on success (synchronously)", () => {
        expect.assertions(1);

        const nonNeg = v.number().check((n) => n >= 0);
        const result = nonNeg["~standard"].validate(7);

        // Synchronous per the spec — never a Promise.
        assertOk(!(result instanceof Promise), "validate must be synchronous");

        expect(result).toStrictEqual({ value: 7 });
    });

    it("validate maps a ValidationError to { issues } with the lunora path", () => {
        expect.hasAssertions();

        const nested = v.object({ user: v.object({ tags: v.array(v.string()) }) });
        const result = nested["~standard"].validate({ user: { tags: ["ok", 42] } });

        assertOk(!(result instanceof Promise), "validate must be synchronous");
        assertOk(result.issues !== undefined, "expected issues");

        expect(result.issues).toHaveLength(1);
        // Lunora paths are (string | number)[] — Standard-Schema-compatible verbatim.
        expect(result.issues[0]?.path).toStrictEqual(["user", "tags", 1]);
        expect(typeof result.issues[0]?.message).toBe("string");
    });

    it("attaches ~standard to derived validators (.check/.nullable/.default)", () => {
        expect.assertions(3);

        expect(v.string().check((s) => s.length > 0)["~standard"].vendor).toBe("lunora");
        expect(v.string().nullable()["~standard"].vendor).toBe("lunora");
        expect(v.string().default("x")["~standard"].vendor).toBe("lunora");
    });
});

describe(".nullable() runtime parsing", () => {
    it("accepts null and round-trips it", () => {
        expect.assertions(1);

        // Exercises the `value === null ? null` branch of the nullable parser
        // directly — not just structurally via toJsonSchema.
        expect(v.string().nullable().parse(null)).toBeNull();
    });

    it("delegates a non-null value to the inner parser (accept + reject)", () => {
        expect.assertions(2);

        const validator = v.number().nullable();

        // The `: parser(value, context)` branch — inner parser still runs.
        expect(validator.parse(7)).toBe(7);
        expect(() => validator.parse("7")).toThrow(ValidationError);
    });

    it("chain order decides whether a refinement sees null, and the type says which", () => {
        expect.assertions(3);

        // `.nullable().check(p)` refines the WIDENED type, so `p` runs on null —
        // and its parameter is typed `string | null`, which is what makes that
        // safe to rely on. A predicate that dereferences the value here is a
        // compile error, not a runtime surprise:
        //
        //     v.string().nullable().check((s) => s.length > 0)
        //     //                                 ^ TS18047: 's' is possibly 'null'
        const seen: unknown[] = [];

        expect(
            v
                .string()
                .nullable()
                .check((value) => {
                    seen.push(value);

                    return true;
                })
                .parse(null),
        ).toBeNull();
        expect(seen).toStrictEqual([null]);

        // `.check(p).nullable()` wraps the refined parser instead, so null
        // short-circuits ahead of `p`. Same two calls, opposite semantics —
        // pick the order that states the invariant you mean.
        expect(
            v
                .string()
                .check(() => {
                    throw new Error("predicate must not run for null");
                })
                .nullable()
                .parse(null),
        ).toBeNull();
    });
});

describe("v.optional() standalone parsing", () => {
    it("returns undefined for undefined without consulting the inner parser", () => {
        expect.assertions(1);

        // A standalone optional (not behind an object's isOptional skip) hits the
        // `value === undefined` short-circuit branch of the optional parser.
        expect(v.optional(v.number()).parse(undefined)).toBeUndefined();
    });

    it("delegates a defined value to the inner parser (accept + reject)", () => {
        expect.assertions(2);

        const validator = v.optional(v.number());

        expect(validator.parse(5)).toBe(5);
        expect(() => validator.parse("nope")).toThrow(ValidationError);
    });
});

describe("composite reject paths", () => {
    it("v.array rejects a non-array at the top level", () => {
        expect.hasAssertions();

        const result = v.array(v.number()).safeParse("not an array");

        assertOk(!result.ok, "expected parse to fail");

        expect(result.error.expected).toBe("array");
        expect(result.error.path).toEqual([]);
    });

    it("v.record rejects a non-object (array / null / primitive)", () => {
        expect.assertions(3);

        const schema = v.record(v.string(), v.number());

        expect(() => schema.parse([])).toThrow(ValidationError);
        expect(() => schema.parse(null)).toThrow(ValidationError);
        expect(() => schema.parse(42)).toThrow(ValidationError);
    });
});

describe("v.union() edge cases", () => {
    it("throws at construction when given no members", () => {
        expect.assertions(1);

        // The `members.length === 0` guard.
        expect(() => v.union()).toThrow("v.union requires at least one member");
    });

    it("a single-member union surfaces that member's own error verbatim", () => {
        expect.hasAssertions();

        // With exactly one member and a recorded ValidationError, the union
        // rethrows the member's specific error rather than wrapping it in a
        // "union of N member(s)" message.
        const schema = v.union(v.number());
        const result = schema.safeParse("not a number");

        assertOk(!result.ok, "expected parse to fail");

        // The inner number validator's message, not a union-miss message.
        expect(result.error.expected).toBe("number");
        expect(result.error.message).not.toMatch(/union of/u);
    });

    it("a union miss never echoes a value one of its members redacted", () => {
        expect.hasAssertions();

        // Alone, the refined member reports `received string` — `.check()` failures
        // redact so a password never reaches the 400 body. The union's own
        // diagnostic wraps the same miss and must withhold the same literal,
        // whichever position the refined member sits in.
        const strong = v.string().check((value) => value.length >= 12, "strong password");

        for (const schema of [v.union(strong, v.number()), v.union(v.number(), strong)]) {
            const result = schema.safeParse("hunter2");

            assertOk(!result.ok, "expected parse to fail");

            expect(result.error.message).not.toContain("hunter2");
            expect(result.error.received).toBe("string");
        }

        // A plain type miss keeps its literal: nothing redacted it.
        const plain = v.union(v.literal("draft"), v.literal("published")).safeParse("Draft");

        assertOk(!plain.ok, "expected parse to fail");

        expect(plain.error.received).toBe('string "Draft"');
    });

    it("a single-member union accepts a valid value", () => {
        expect.assertions(1);

        expect(v.union(v.string()).parse("ok")).toBe("ok");
    });

    it("a nested union that misses every branch reports a real diagnostic, not the internal probe signal", () => {
        expect.hasAssertions();

        // `union` runs its branch trial with `context.probe` set, which makes
        // `fail` throw the shared, stackless PROBE_MISS instead of building a
        // per-branch ValidationError. The inner union here misses under the
        // outer union's trial, so PROBE_MISS travels one level up — it must
        // never reach the caller, and the outer union must still build the
        // full "union of N member(s) (closest: …)" diagnostic.
        const schema = v.object({ value: v.union(v.union(v.number(), v.boolean()), v.string()) });
        const result = schema.safeParse({ value: { nope: true } });

        assertOk(!result.ok, "expected parse to fail");

        expect(result.error.message).not.toMatch(/probe/iu);
        expect(result.error.expected).toMatch(/^union of 2 member\(s\)/u);
        expect(result.error.path).toStrictEqual(["value"]);
    });

    it("a nested union still matches on a branch reached only after a miss", () => {
        expect.assertions(2);

        // The trial pass must leave the shared path stack unwound so a later
        // branch parses at the right depth, and the matched value passes through.
        const schema = v.object({ value: v.union(v.union(v.number(), v.boolean()), v.array(v.string())) });

        expect(schema.parse({ value: ["a", "b"] })).toStrictEqual({ value: ["a", "b"] });
        expect(schema.parse({ value: true })).toStrictEqual({ value: true });
    });
});

describe(".meta() without a description", () => {
    it("merges only the schema fragment when no description is given", () => {
        expect.assertions(1);

        // The `options.description === undefined ? options.schema` branch.
        const validator = v.string().meta({ schema: { format: "email" } });
        const meta = (validator as unknown as { _meta: { constraints?: Record<string, unknown> } })._meta;

        expect(meta.constraints).toStrictEqual({ format: "email" });
    });
});

describe("safeParse non-ValidationError propagation", () => {
    it("re-throws a non-ValidationError thrown inside the parser", () => {
        expect.assertions(1);

        // The catch block's `error instanceof ValidationError` false branch:
        // a programmer error (TypeError) is not swallowed into { ok: false }.
        const boom = v.number().check(() => {
            throw new TypeError("kaboom");
        });

        expect(() => boom.safeParse(1)).toThrow(TypeError);
    });
});

describe("isOrWrapsFromValidator", () => {
    it("is true for a bare v.from(...)", () => {
        expect.assertions(1);

        expect(isOrWrapsFromValidator(v.from(v.number()))).toBe(true);
    });

    it("is false for an ordinary scalar validator", () => {
        expect.assertions(2);

        expect(isOrWrapsFromValidator(v.string())).toBe(false);
        expect(isOrWrapsFromValidator(v.number())).toBe(false);
    });

    it("detects a v.from wrapped by v.optional (inner child)", () => {
        expect.assertions(1);

        expect(isOrWrapsFromValidator(v.optional(v.from(v.number())))).toBe(true);
    });

    it("detects a v.from wrapped by v.array (inner child)", () => {
        expect.assertions(1);

        expect(isOrWrapsFromValidator(v.array(v.from(v.string())))).toBe(true);
    });

    it("detects a v.from nested in a v.object shape", () => {
        expect.assertions(2);

        expect(isOrWrapsFromValidator(v.object({ id: v.from(v.string()), name: v.string() }))).toBe(true);
        // A from-free object shape is not flagged.
        expect(isOrWrapsFromValidator(v.object({ name: v.string() }))).toBe(false);
    });

    it("detects a v.from in a record value position", () => {
        expect.assertions(2);

        expect(isOrWrapsFromValidator(v.record(v.string(), v.from(v.number())))).toBe(true);
        expect(isOrWrapsFromValidator(v.record(v.string(), v.number()))).toBe(false);
    });

    it("detects a v.from among union members", () => {
        expect.assertions(2);

        expect(isOrWrapsFromValidator(v.union(v.number(), v.from(v.string())))).toBe(true);
        expect(isOrWrapsFromValidator(v.union(v.number(), v.string()))).toBe(false);
    });

    it("returns false when the validator carries no _meta bag", () => {
        expect.assertions(1);

        // The `if (!meta) return false` guard — a hand-rolled validator-shaped
        // object with no _meta still answers cleanly.
        const metaless = { kind: "string" } as unknown as Parameters<typeof isOrWrapsFromValidator>[0];

        expect(isOrWrapsFromValidator(metaless)).toBe(false);
    });
});

describe("v.partial", () => {
    it("makes every member optional", () => {
        expect.assertions(3);

        const shape = v.partial({ done: v.boolean(), title: v.string() });
        const object = v.object(shape);

        expect(object.parse({})).toStrictEqual({});
        expect(object.parse({ title: "a" })).toStrictEqual({ title: "a" });
        expect(object.parse({ done: true, title: "a" })).toStrictEqual({ done: true, title: "a" });
    });

    it("still rejects a present member of the wrong type", () => {
        expect.assertions(1);

        const object = v.object(v.partial({ title: v.string() }));

        expect(() => object.parse({ title: 1 })).toThrow(ValidationError);
    });

    it("passes an already-optional member through instead of double-wrapping", () => {
        expect.assertions(2);

        const inner = v.optional(v.string());
        const shape = v.partial({ title: inner });

        expect(shape.title).toBe(inner);
        expect(v.object(shape).parse({})).toStrictEqual({});
    });

    it("infers every key as optional", () => {
        expect.assertions(3);

        const object = v.object(v.partial({ done: v.boolean(), title: v.string() }));

        type Inferred = Infer<typeof object>;

        // Compile-time: each member keeps its type, widened by `undefined`…
        const doneCheck: Assert<Equal<Inferred["done"], boolean | undefined>> = true;
        // …and every KEY is optional, or neither literal below would assign.
        const empty: Inferred = {};
        const some: Inferred = { title: "a" };

        expect(doneCheck).toBe(true);
        expect(empty).toStrictEqual({});
        expect(some).toStrictEqual({ title: "a" });
    });
});
