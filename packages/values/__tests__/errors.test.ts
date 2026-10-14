import { describe, expect, it } from "vitest";

import { describeValue, formatPath, ValidationError } from "../src/errors";
import { v } from "../src/index";

describe("describeValue", () => {
    it("describes null and arrays distinctly", () => {
        expect.assertions(2);

        expect(describeValue(null)).toBe("null");
        expect(describeValue([1, 2])).toBe("array");
    });

    it("names an ArrayBuffer", () => {
        expect.assertions(1);

        // The `value instanceof ArrayBuffer` branch — bytes columns reject other
        // shapes and this is how the rejected value is described.
        expect(describeValue(new ArrayBuffer(8))).toBe("ArrayBuffer");
    });

    it("renders a string with its (quoted) literal", () => {
        expect.assertions(1);

        expect(describeValue("hi")).toBe('string "hi"');
    });

    it("suppresses the primitive literal to a bare type tag when literal:false", () => {
        expect.assertions(4);

        // The refinement-failure redaction path: only the type tag survives so a
        // secret-bearing field never surfaces its value. Default is unchanged.
        expect(describeValue("secret", { literal: false })).toBe("string");
        expect(describeValue("secret")).toBe('string "secret"');
        expect(describeValue(7, { literal: false })).toBe("number");
        expect(describeValue(42n, { literal: false })).toBe("bigint");
    });

    it("truncates an over-long string literal with an ellipsis", () => {
        expect.assertions(2);

        // The `text.length > MAX_DESCRIBED_LENGTH` branch of truncate (cap is 80
        // chars of the JSON-stringified form, including the surrounding quotes).
        const long = "a".repeat(200);
        const described = describeValue(long);

        expect(described.endsWith("…")).toBe(true);
        // Capped: prefix (80 chars) + the ellipsis, far short of the 202-char input.
        expect(described.length).toBeLessThan(100);
    });

    it("renders numbers and booleans with their typeof tag", () => {
        expect.assertions(2);

        expect(describeValue(7)).toBe("number 7");
        expect(describeValue(true)).toBe("boolean true");
    });

    it("renders a bigint with an n suffix", () => {
        expect.assertions(1);

        // The `typeof value === "bigint"` branch.
        expect(describeValue(42n)).toBe("bigint 42n");
    });

    it("names a non-plain object by its constructor", () => {
        expect.assertions(1);

        expect(describeValue(new Date(0))).toBe("object Date");
    });

    it("renders a plain object as a bare object", () => {
        expect.assertions(2);

        expect(describeValue({ a: 1 })).toBe("object");
        // A null-prototype object has no constructor name, so it also stays bare.
        expect(describeValue(Object.create(null))).toBe("object");
    });

    it("caps a genuine constructor name like every primitive branch", () => {
        expect.assertions(1);

        class Long {
            public readonly id = 0;
        }

        Object.defineProperty(Long, "name", { value: "X".repeat(200) });

        expect(describeValue(new Long()).length).toBeLessThan(100);
    });

    it("does not throw on a hostile object whose constructor getter throws", () => {
        expect.assertions(2);

        // A throwing `constructor` getter on the diagnostic path must not escape
        // describeValue and mask the real validation error — fall back to "object".
        const hostile = {};

        Object.defineProperty(hostile, "constructor", {
            configurable: true,
            get() {
                throw new Error("boom");
            },
        });

        expect(() => describeValue(hostile)).not.toThrow();
        expect(describeValue(hostile)).toBe("object");
    });

    it("truncates a client-supplied constructor name", () => {
        expect.assertions(2);

        // A JSON body carrying its OWN `constructor` property is a plain object
        // whose `constructor.name` is whatever was sent — so this branch is
        // client-sized, and `received` goes back on the wire and into logs.
        // Every other branch truncates; this one did not.
        const described = describeValue(structuredClone({ constructor: { name: "A".repeat(100_000) } }));

        expect(described.endsWith("…")).toBe(true);
        expect(described.length).toBeLessThan(100);
    });

    it("falls through to typeof for other values (undefined, symbol, function)", () => {
        expect.assertions(3);

        expect(describeValue(undefined)).toBe("undefined");
        expect(describeValue(Symbol("s"))).toBe("symbol");
        expect(describeValue(() => undefined)).toBe("function");
    });
});

describe("formatPath", () => {
    it("renders the root for an empty path", () => {
        expect.assertions(1);

        expect(formatPath([])).toBe("<root>");
    });

    it("dot-joins string keys, bracket-wraps numeric indices, and never dots the head", () => {
        expect.assertions(2);

        expect(formatPath(["users", 0, "email"])).toBe("users[0].email");
        // A leading numeric segment still bracket-wraps rather than dotting.
        expect(formatPath([3, "x"])).toBe("[3].x");
    });
});

describe("validationError", () => {
    it("carries the structured fields and the ValidationError name", () => {
        expect.assertions(4);

        const error = new ValidationError("nope", { expected: "string", path: ["a", 1], received: "number 1" });

        expect(error.name).toBe("ValidationError");
        expect(error.expected).toBe("string");
        expect(error.path).toEqual(["a", 1]);
        expect(error.received).toBe("number 1");
    });

    it("still throws a normal ValidationError for an input with a throwing constructor getter", () => {
        expect.assertions(2);

        // End-to-end: a hostile value reaching the diagnostic path must surface
        // the real validation failure, not the getter's "boom".
        const hostile = {};

        Object.defineProperty(hostile, "constructor", {
            configurable: true,
            get() {
                throw new Error("boom");
            },
        });

        let caught: unknown;

        try {
            v.string().parse(hostile);
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeInstanceOf(ValidationError);
        expect((caught as ValidationError).received).toBe("object");
    });
});
