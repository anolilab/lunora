import { describe, expect, it } from "vitest";

import { ValidationError } from "../src/errors";
import { argsToJsonSchema, toJsonSchema } from "../src/to-json-schema";
import { containsSensitive, sensitiveArgumentNames, v } from "../src/v";
import { parseValidatorMap } from "../src/validator-map";

/** Run `parse` and return the ValidationError it throws, failing loudly if it parses. */
const rejection = (parse: () => unknown): ValidationError => {
    try {
        parse();
    } catch (error: unknown) {
        if (error instanceof ValidationError) {
            return error;
        }

        throw error;
    }

    throw new Error("expected the parse to reject");
};

describe("v.sensitive — transparent to validation", () => {
    it("accepts and rejects exactly what the wrapped validator does", () => {
        expect.assertions(4);

        const secret = v.sensitive(v.string().min(3));

        expect(secret.parse("abc")).toBe("abc");
        expect(rejection(() => secret.parse("ab")).message).toContain("string length >= 3");
        expect(secret.safeParse(42).ok).toBe(false);
        expect(v.sensitive(v.optional(v.string())).parse(undefined)).toBeUndefined();
    });

    it("keeps the wrapped kind so optional-skip and kind tests still hold", () => {
        expect.assertions(2);

        expect(v.sensitive(v.optional(v.string())).kind).toBe("optional");
        expect(v.sensitive(v.string()).kind).toBe("string");
    });

    it("survives later chaining on the marked validator", () => {
        expect.assertions(2);

        const chained = v.sensitive(v.string()).check((text) => text.startsWith("s_"), "expected an s_ key");

        expect(containsSensitive(chained)).toBe(true);
        expect(chained.parse("s_1")).toBe("s_1");
    });
});

describe("v.sensitive — received echo is withheld", () => {
    it("reports the bare type tag for a type mismatch on a marked value", () => {
        expect.assertions(3);

        const error = rejection(() => v.sensitive(v.string()).parse(12_345_678));

        expect(error.received).toBe("number");
        expect(error.message).not.toContain("12345678");
        expect(error.message).toContain("received number");
    });

    it("withholds an object's constructor name, which is caller-controlled", () => {
        expect.assertions(2);

        const hostile = { constructor: { name: "hunter2" } };
        const error = rejection(() => v.sensitive(v.string()).parse(hostile));

        expect(error.received).toBe("object");
        expect(error.message).not.toContain("hunter2");
    });

    it("withholds undeclared key names on a marked object", () => {
        expect.assertions(2);

        const error = rejection(() => v.sensitive(v.object({ id: v.string() })).parse({ id: "a", "hunter2-key": 1 }, { rejectUnknownKeys: true }));

        expect(error.message).not.toContain("hunter2-key");
        expect(error.received).toBe("[redacted]");
    });

    it("withholds a third-party Standard Schema issue message that quotes the value", () => {
        expect.assertions(2);

        const schema = {
            "~standard": {
                validate: () => {
                    return { issues: [{ message: "value 'hunter2' is not a valid key" }] };
                },
                vendor: "test",
                version: 1,
            },
        };
        const error = rejection(() => v.sensitive(v.from(schema as never)).parse("hunter2"));

        expect(error.message).not.toContain("hunter2");
        expect(error.received).toBe("string");
    });

    it("restores the echo for siblings once the marked child has failed", () => {
        expect.assertions(2);

        // The marked child parses first and succeeds; a failing sibling after it
        // must still echo its literal, so the flag was restored on the way out.
        const shape = v.object({ secret: v.sensitive(v.string()), b: v.number() });
        const error = rejection(() => shape.parse({ b: "not-a-number", secret: "x" }));

        expect(error.received).toBe('string "not-a-number"');
        expect(error.message).toContain('string "not-a-number"');
    });

    it("keeps the literal on an unmarked value next to a marked one", () => {
        expect.assertions(1);

        const error = rejection(() => v.object({ count: v.number(), secret: v.sensitive(v.string()) }).parse({ count: "seven", secret: "x" }));

        expect(error.received).toBe('string "seven"');
    });
});

describe("containsSensitive / sensitiveArgumentNames", () => {
    it("finds a marker at the top, inside an object, under an array and inside a union", () => {
        expect.assertions(4);

        expect(containsSensitive(v.sensitive(v.string()))).toBe(true);
        expect(containsSensitive(v.object({ inner: v.sensitive(v.string()) }))).toBe(true);
        expect(containsSensitive(v.array(v.object({ inner: v.sensitive(v.string()) })))).toBe(true);
        expect(containsSensitive(v.union(v.number(), v.sensitive(v.string())))).toBe(true);
    });

    it("is false for an unmarked tree", () => {
        expect.assertions(1);

        expect(containsSensitive(v.object({ count: v.number(), tags: v.array(v.string()) }))).toBe(false);
    });

    it("names the marked arguments, whatever they are called, and memoises per map", () => {
        expect.assertions(3);

        const args = { count: v.number(), value: v.sensitive(v.string()) };
        const first = sensitiveArgumentNames(args);

        expect([...first]).toStrictEqual(["value"]);
        expect(sensitiveArgumentNames(args)).toBe(first);
        expect(sensitiveArgumentNames({ count: v.number() }).size).toBe(0);
    });
});

describe("v.sensitive — argument validation through the map", () => {
    it("parses a marked argument named `value` with the same result as unmarked", () => {
        expect.assertions(1);

        expect(parseValidatorMap({ value: v.sensitive(v.string()) }, { value: "s3cret" }, "args")).toStrictEqual({ value: "s3cret" });
    });

    it("prefixes a marked argument's rejection with the arg label and keeps it withheld", () => {
        expect.assertions(2);

        const error = rejection(() => parseValidatorMap({ value: v.sensitive(v.string()) }, { value: 77_777 }, "args"));

        expect(error.message).toBe("args.value: Expected string at <root>, received number");
        expect(error.path).toStrictEqual(["value"]);
    });
});

describe("v.sensitive — JSON Schema", () => {
    it("emits writeOnly and format password on a plain string", () => {
        expect.assertions(1);

        expect(toJsonSchema(v.sensitive(v.string()))).toStrictEqual({ format: "password", type: "string", writeOnly: true });
    });

    it("keeps an existing string format and still marks the node writeOnly", () => {
        expect.assertions(1);

        expect(toJsonSchema(v.sensitive(v.string().email()))).toMatchObject({ format: "email", type: "string", writeOnly: true });
    });

    it("applies writeOnly under nullable without wrapping the flag outside the anyOf", () => {
        expect.assertions(1);

        expect(toJsonSchema(v.sensitive(v.string()).nullable())).toStrictEqual({
            anyOf: [{ format: "password", type: "string", writeOnly: true }, { type: "null" }],
        });
    });

    it("marks only the sensitive argument in an args schema", () => {
        expect.assertions(2);

        const schema = argsToJsonSchema({ count: v.number(), value: v.sensitive(v.string()) });

        expect(schema["required"]).toStrictEqual(["count", "value"]);
        expect((schema["properties"] as Record<string, unknown>)["count"]).toStrictEqual({ type: "number" });
    });

    it("leaves an unmarked validator's schema unchanged", () => {
        expect.assertions(1);

        expect(toJsonSchema(v.string())).toStrictEqual({ type: "string" });
    });
});
