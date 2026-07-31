import { describe, expect, it } from "vitest";

import { toJsonSchema, v, ValidationError } from "../src/index";

describe("string refinements", () => {
    describe(".min()", () => {
        it("rejects a too-short string and accepts a valid one", () => {
            expect.assertions(2);

            const validator = v.string().min(1);

            expect(() => validator.parse("")).toThrow(ValidationError);
            expect(validator.parse("a")).toBe("a");
        });

        it("emits minLength", () => {
            expect.assertions(1);

            expect(toJsonSchema(v.string().min(1))).toStrictEqual({ minLength: 1, type: "string" });
        });
    });

    describe(".max()", () => {
        it("rejects a too-long string and accepts a valid one", () => {
            expect.assertions(2);

            const validator = v.string().max(3);

            expect(() => validator.parse("abcd")).toThrow(ValidationError);
            expect(validator.parse("abc")).toBe("abc");
        });

        it("emits maxLength", () => {
            expect.assertions(1);

            expect(toJsonSchema(v.string().max(3))).toStrictEqual({ maxLength: 3, type: "string" });
        });
    });

    describe(".length()", () => {
        it("rejects a wrong-length string and accepts an exact match", () => {
            expect.assertions(3);

            const validator = v.string().length(4);

            expect(() => validator.parse("abc")).toThrow(ValidationError);
            expect(() => validator.parse("abcde")).toThrow(ValidationError);
            expect(validator.parse("abcd")).toBe("abcd");
        });

        it("emits both minLength and maxLength", () => {
            expect.assertions(1);

            expect(toJsonSchema(v.string().length(4))).toStrictEqual({ maxLength: 4, minLength: 4, type: "string" });
        });
    });

    describe(".pattern()", () => {
        it("rejects a non-matching string and accepts a matching one", () => {
            expect.assertions(2);

            const validator = v.string().pattern(/^[a-z]+$/u);

            expect(() => validator.parse("ABC")).toThrow(ValidationError);
            expect(validator.parse("abc")).toBe("abc");
        });

        it("emits pattern from the regex source", () => {
            expect.assertions(1);

            expect(toJsonSchema(v.string().pattern(/^[a-z]+$/u))).toStrictEqual({ pattern: "^[a-z]+$", type: "string" });
        });
    });

    describe(".email()", () => {
        it("rejects an invalid address and accepts a valid one", () => {
            expect.assertions(2);

            const validator = v.string().email();

            expect(() => validator.parse("x")).toThrow(ValidationError);
            expect(validator.parse("a@b.com")).toBe("a@b.com");
        });

        it("emits format: email", () => {
            expect.assertions(1);

            expect(toJsonSchema(v.string().email())).toStrictEqual({ format: "email", type: "string" });
        });
    });

    describe(".url()", () => {
        it("rejects an invalid URL and accepts a valid one", () => {
            expect.assertions(2);

            const validator = v.string().url();

            expect(() => validator.parse("not a url")).toThrow(ValidationError);
            expect(validator.parse("https://example.com")).toBe("https://example.com");
        });

        it("emits format: uri", () => {
            expect.assertions(1);

            expect(toJsonSchema(v.string().url())).toStrictEqual({ format: "uri", type: "string" });
        });
    });

    describe("chaining", () => {
        it("v.string().min(1).email() enforces both and emits both keywords", () => {
            expect.assertions(4);

            const validator = v.string().min(1).email();

            expect(() => validator.parse("")).toThrow(ValidationError);
            expect(() => validator.parse("x")).toThrow(ValidationError);
            expect(validator.parse("a@b.com")).toBe("a@b.com");
            expect(toJsonSchema(validator)).toStrictEqual({ format: "email", minLength: 1, type: "string" });
        });

        it(".check() still composes after a refinement shortcut", () => {
            expect.assertions(3);

            const validator = v
                .string()
                .min(1)
                .check((value) => value === value.toLowerCase(), "must be lowercase");

            expect(() => validator.parse("")).toThrow(ValidationError);
            expect(() => validator.parse("ABC")).toThrow(ValidationError);
            expect(validator.parse("abc")).toBe("abc");
        });
    });
});

describe("number refinements", () => {
    describe(".min()", () => {
        it("rejects a too-small number and accepts a valid one", () => {
            expect.assertions(2);

            const validator = v.number().min(0);

            expect(() => validator.parse(-1)).toThrow(ValidationError);
            expect(validator.parse(0)).toBe(0);
        });

        it("emits minimum", () => {
            expect.assertions(1);

            expect(toJsonSchema(v.number().min(0))).toStrictEqual({ minimum: 0, type: "number" });
        });
    });

    describe(".max()", () => {
        it("rejects a too-large number and accepts a valid one", () => {
            expect.assertions(2);

            const validator = v.number().max(10);

            expect(() => validator.parse(11)).toThrow(ValidationError);
            expect(validator.parse(10)).toBe(10);
        });

        it("emits maximum", () => {
            expect.assertions(1);

            expect(toJsonSchema(v.number().max(10))).toStrictEqual({ maximum: 10, type: "number" });
        });
    });

    describe(".int()", () => {
        it("rejects a non-integer and accepts an integer", () => {
            expect.assertions(2);

            const validator = v.number().int();

            expect(() => validator.parse(1.5)).toThrow(ValidationError);
            expect(validator.parse(1)).toBe(1);
        });

        it("emits type: integer", () => {
            expect.assertions(1);

            expect(toJsonSchema(v.number().int())).toStrictEqual({ type: "integer" });
        });
    });

    describe(".positive()", () => {
        it("rejects zero/negative and accepts a positive number", () => {
            expect.assertions(3);

            const validator = v.number().positive();

            expect(() => validator.parse(0)).toThrow(ValidationError);
            expect(() => validator.parse(-1)).toThrow(ValidationError);
            expect(validator.parse(1)).toBe(1);
        });

        it("emits exclusiveMinimum: 0", () => {
            expect.assertions(1);

            expect(toJsonSchema(v.number().positive())).toStrictEqual({ exclusiveMinimum: 0, type: "number" });
        });
    });

    describe("chaining", () => {
        it("v.number().int().min(0) rejects -1 and 1.5, accepts 0, and emits both keywords", () => {
            expect.assertions(4);

            const validator = v.number().int().min(0);

            expect(() => validator.parse(-1)).toThrow(ValidationError);
            expect(() => validator.parse(1.5)).toThrow(ValidationError);
            expect(validator.parse(0)).toBe(0);
            expect(toJsonSchema(validator)).toStrictEqual({ minimum: 0, type: "integer" });
        });
    });
});

describe("array refinements", () => {
    describe(".min()", () => {
        it("rejects a too-short array and accepts a valid one", () => {
            expect.assertions(2);

            const validator = v.array(v.string()).min(1);

            expect(() => validator.parse([])).toThrow(ValidationError);
            expect(validator.parse(["a"])).toStrictEqual(["a"]);
        });

        it("emits minItems", () => {
            expect.assertions(1);

            expect(toJsonSchema(v.array(v.string()).min(1))).toStrictEqual({ items: { type: "string" }, minItems: 1, type: "array" });
        });
    });

    describe(".max()", () => {
        it("rejects a too-long array and accepts a valid one", () => {
            expect.assertions(2);

            const validator = v.array(v.string()).max(2);

            expect(() => validator.parse(["a", "b", "c"])).toThrow(ValidationError);
            expect(validator.parse(["a", "b"])).toStrictEqual(["a", "b"]);
        });

        it("emits maxItems", () => {
            expect.assertions(1);

            expect(toJsonSchema(v.array(v.string()).max(2))).toStrictEqual({ items: { type: "string" }, maxItems: 2, type: "array" });
        });
    });

    describe("chaining", () => {
        it("v.array(v.string()).min(1).max(3) enforces both and emits both keywords", () => {
            expect.assertions(4);

            const validator = v.array(v.string()).min(1).max(3);

            expect(() => validator.parse([])).toThrow(ValidationError);
            expect(() => validator.parse(["a", "b", "c", "d"])).toThrow(ValidationError);
            expect(validator.parse(["a", "b"])).toStrictEqual(["a", "b"]);
            expect(toJsonSchema(validator)).toStrictEqual({ items: { type: "string" }, maxItems: 3, minItems: 1, type: "array" });
        });
    });
});
