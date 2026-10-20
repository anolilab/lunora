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
                version: 1 as const,
            },
        };
        const error = rejection(() => v.sensitive(v.from(schema)).parse("hunter2"));

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

describe("v.sensitive — caller-chosen key names inside a secret-bearing shape", () => {
    it("withholds undeclared key names when a nested field is sensitive", () => {
        expect.assertions(3);

        // The parent object fails before its children parse, so the marked child never
        // sets `redact` for this check: the shape itself must carry the rule.
        const shape = v.object({ token: v.sensitive(v.string()) });
        const error = rejection(() => shape.parse({ token: "actual-secret", "actual-secret": 1 }, { rejectUnknownKeys: true }));

        expect(error.message).not.toContain("actual-secret");
        expect(error.received).toBe("[redacted]");
        expect(error.message).toContain("object has 1 undeclared key(s)");
    });

    it("still names undeclared keys on an object with no sensitive descendant", () => {
        expect.assertions(2);

        const error = rejection(() => v.object({ token: v.string() }).parse({ token: "x", "stray-field": 1 }, { rejectUnknownKeys: true }));

        expect(error.message).toContain("stray-field");
        expect(error.received).toBe("stray-field");
    });

    it("keeps caller record keys out of the path when the value under them is sensitive", () => {
        expect.assertions(3);

        const error = rejection(() => v.record(v.string(), v.sensitive(v.number())).parse({ "hunter2-key": "not-a-number" }));

        expect(error.path).toStrictEqual(["<key>"]);
        expect(error.message).not.toContain("hunter2-key");
        expect(error.message).toBe("Expected number at <key>, received string");
    });

    it("keeps a record key out of the path when the record reaches a sensitive field through its value", () => {
        expect.assertions(2);

        const shape = v.object({
            inventory: v.record(v.string(), v.object({ count: v.number(), token: v.sensitive(v.string()) })),
        });
        const error = rejection(() => shape.parse({ inventory: { "hunter2-key": { count: "x", token: "t" } } }));

        expect(error.path).toStrictEqual(["inventory", "<key>", "count"]);
        expect(error.message).not.toContain("hunter2-key");
    });

    it("keeps a sensitive record key out of the path and the received echo when the key fails", () => {
        expect.assertions(3);

        const error = rejection(() => v.record(v.sensitive(v.literal("ok")), v.number()).parse({ "hunter2-key": 1 }));

        expect(error.path).toStrictEqual(["<key>"]);
        expect(error.message).not.toContain("hunter2-key");
        expect(error.received).toBe("string");
    });

    it("withholds a caller key's literal from its own diagnostic when only the record's value is sensitive", () => {
        expect.assertions(2);

        const error = rejection(() => v.record(v.literal("ok"), v.sensitive(v.number())).parse({ "hunter2-key": 1 }));

        expect(error.message).not.toContain("hunter2-key");
        expect(error.received).toBe("string");
    });

    it("keeps the control: a record with no sensitive part still names its keys in the path", () => {
        expect.assertions(2);

        const error = rejection(() => v.record(v.string(), v.number()).parse({ "plain-key": "x" }));

        expect(error.path).toStrictEqual(["plain-key"]);
        expect(error.message).toBe('Expected number at plain-key, received string "x"');
    });

    it("keeps a union branch's undeclared key and record key out of the closest-branch summary", () => {
        expect.assertions(2);

        const objectBranch = v.union(v.object({ token: v.sensitive(v.string()) }), v.number());
        const recordBranch = v.union(v.record(v.string(), v.sensitive(v.number())), v.boolean());

        const undeclared = rejection(() => objectBranch.parse({ token: "t", "hunter2-key": 1 }, { rejectUnknownKeys: true }));
        const keyed = rejection(() => recordBranch.parse({ "hunter2-key": "x" }));

        expect(undeclared.message).not.toContain("hunter2-key");
        expect(keyed.message).not.toContain("hunter2-key");
    });
});

describe("v.sensitive — a container's own value inside a secret-bearing shape", () => {
    it("withholds a primitive that lands where an object was expected", () => {
        expect.assertions(2);

        const error = rejection(() => v.object({ token: v.sensitive(v.string()) }).parse("actual-secret"));

        expect(error.message).not.toContain("actual-secret");
        expect(error.received).toBe("string");
    });

    it("keeps the literal on a primitive where an object has no sensitive field", () => {
        expect.assertions(1);

        expect(rejection(() => v.object({ token: v.string() }).parse("plain")).received).toBe('string "plain"');
    });

    it("withholds a primitive that lands where an array was expected inside a secret-bearing shape", () => {
        expect.assertions(2);

        const error = rejection(() => v.array(v.object({ token: v.sensitive(v.string()) })).parse("actual-secret"));

        expect(error.message).not.toContain("actual-secret");
        expect(error.received).toBe("string");
    });

    it("keeps the literal on a primitive where an array has no sensitive item", () => {
        expect.assertions(1);

        expect(rejection(() => v.array(v.string()).parse("plain")).received).toBe('string "plain"');
    });

    it("withholds a primitive that lands where a record was expected", () => {
        expect.assertions(2);

        const error = rejection(() => v.record(v.string(), v.sensitive(v.number())).parse("actual-secret"));

        expect(error.message).not.toContain("actual-secret");
        expect(error.received).toBe("string");
    });

    it("keeps the literal on a primitive where a record has no sensitive part", () => {
        expect.assertions(1);

        expect(rejection(() => v.record(v.string(), v.number()).parse("plain")).received).toBe('string "plain"');
    });

    it("withholds a union's constructor-name echo when a member holds a sensitive field", () => {
        expect.assertions(2);

        const hostile = { constructor: { name: "hunter2" }, token: 1 };
        const error = rejection(() => v.union(v.object({ token: v.sensitive(v.string()) }), v.number()).parse(hostile));

        expect(error.message).not.toContain("hunter2");
        expect(error.received).toBe("object");
    });

    it("keeps a union's constructor-name echo when no member holds a sensitive field", () => {
        expect.assertions(1);

        const hostile = { constructor: { name: "hunter2" }, token: 1 };

        expect(rejection(() => v.union(v.object({ token: v.string() }), v.number()).parse(hostile)).received).toBe("object hunter2");
    });

    it("withholds a third-party issue path that carries a caller key when the validator is marked", () => {
        expect.assertions(2);

        const schema = {
            "~standard": {
                validate: () => {
                    return { issues: [{ message: "unexpected key", path: ["actual-secret"] }] };
                },
                vendor: "test",
                version: 1 as const,
            },
        };
        const error = rejection(() => v.sensitive(v.from(schema)).parse({ "actual-secret": 1 }));

        expect(error.path).toStrictEqual(["<key>"]);
        expect(error.message).not.toContain("actual-secret");
    });

    it("keeps a third-party issue path on an unmarked validator", () => {
        expect.assertions(1);

        const schema = {
            "~standard": {
                validate: () => {
                    return { issues: [{ message: "unexpected key", path: ["stray-field"] }] };
                },
                vendor: "test",
                version: 1 as const,
            },
        };

        expect(rejection(() => v.from(schema).parse({ "stray-field": 1 })).path).toStrictEqual(["stray-field"]);
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

describe("v.sensitive — a literal's expected value", () => {
    const SECRET_LITERAL = "open-sesame-2026";

    it("stays out of the message and `expected`, directly and inside a union", () => {
        expect.assertions(4);

        const direct = rejection(() => v.sensitive(v.literal(SECRET_LITERAL)).parse("wrong"));
        const inUnion = rejection(() => v.union(v.sensitive(v.literal(SECRET_LITERAL)), v.number()).parse("wrong"));

        expect(JSON.stringify([direct.message, direct.expected])).not.toContain(SECRET_LITERAL);
        expect(JSON.stringify([inUnion.message, inUnion.expected])).not.toContain(SECRET_LITERAL);
        // An unmarked literal still names itself, for diagnostics.
        expect(rejection(() => v.literal(SECRET_LITERAL).parse("wrong")).expected).toBe(`literal(${SECRET_LITERAL})`);
        expect(direct.expected).toBe("literal");
    });
});

describe("v.sensitive — keeps the wrapped validator's own methods", () => {
    it("lets a sensitive object be stripped and keeps the stripped copy sensitive", () => {
        expect.assertions(3);

        const stripped = v.sensitive(v.object({ token: v.string() })).strip();

        expect(stripped.parse({ extra: 1, token: "abc" })).toStrictEqual({ token: "abc" });
        expect(containsSensitive(stripped)).toBe(true);
        expect(rejection(() => stripped.parse({ token: 5 })).message).not.toContain("5");
    });
});

describe("v.sensitive — a refinement chained after the marker", () => {
    it("withholds caller text from a failed refinement's message and received", () => {
        expect.assertions(2);

        // The caller controls the parsed object's `constructor.name`, which a refinement's failure would echo.
        const payload = v
            .sensitive(v.object({ constructor: v.object({ name: v.string() }), token: v.string() }))
            .check((value) => value.token.startsWith("s_"), "expected an s_ key");
        const error = rejection(() => payload.parse({ constructor: { name: "attacker-text" }, token: "abc" }));

        expect(error.received).toBe("object");
        expect(error.message).toBe("Expected expected an s_ key at <root>, received object");
    });
});
