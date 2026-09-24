import { describe, expect, it } from "vitest";

import { ValidationError } from "../src/errors";
import { v } from "../src/v";
import { DEFER_VALIDATION, installCompiledValidatorMap, parseValidatorMap } from "../src/validator-map";

describe("parseValidatorMap", () => {
    it("parses each declared field through its validator", () => {
        expect.assertions(1);

        expect(parseValidatorMap({ amount: v.number(), name: v.string() }, { amount: 42, name: "ada" }, "args")).toStrictEqual({
            amount: 42,
            name: "ada",
        });
    });

    it("skips an absent optional field but keeps a present one", () => {
        expect.assertions(2);

        expect(parseValidatorMap({ nick: v.optional(v.string()) }, {}, "args")).toStrictEqual({});
        expect(parseValidatorMap({ nick: v.optional(v.string()) }, { nick: "ada" }, "args")).toStrictEqual({ nick: "ada" });
    });

    it("accepts an absent bare `v.any()` arg, so the key infers optional (issue #688)", () => {
        expect.assertions(3);

        // Unlike `v.optional(...)` the arg is not SKIPPED — its parser runs and
        // returns `undefined` unchanged — but it does not throw, so an absent
        // `v.any()` arg is accepted. `InferValidatorMap` types it `data?: unknown`
        // to match, and `@lunora/codegen` must emit the same optional key.
        const parsed = parseValidatorMap({ data: v.any(), id: v.string() }, { id: "x" }, "args");

        expect(parsed).toStrictEqual({ data: undefined, id: "x" });
        expect(parsed.data).toBeUndefined();
        expect(parseValidatorMap({ data: v.any() }, { data: { nested: 1 } }, "args")).toStrictEqual({ data: { nested: 1 } });
    });

    it("fails a required field that is absent", () => {
        expect.assertions(1);

        expect(() => parseValidatorMap({ name: v.string() }, {}, "args")).toThrow(ValidationError);
    });

    it("re-prefixes the error with `label.<key>` and rebuilds the path", () => {
        expect.assertions(2);

        const caught = ((): unknown => {
            try {
                parseValidatorMap({ name: v.string() }, { name: 123 }, "step args");

                return undefined;
            } catch (error: unknown) {
                return error;
            }
        })();

        expect(caught).toBeInstanceOf(ValidationError);
        expect(caught).toMatchObject({ message: expect.stringMatching(/^step args\.name:/u), path: ["name"] });
    });

    it("ignores source keys that are not declared in the validator map", () => {
        expect.assertions(1);

        expect(parseValidatorMap({ name: v.string() }, { extra: "dropped", name: "ada" }, "args")).toStrictEqual({ name: "ada" });
    });

    it("reads declared args as own-properties, not through the prototype chain", () => {
        expect.assertions(2);

        // An absent optional arg whose name collides with an Object.prototype
        // member must be skipped, not read as the inherited function (which would
        // reject a valid body with `received function`).
        expect(parseValidatorMap({ toString: v.optional(v.string()) }, {}, "args")).toStrictEqual({});
        // A required colliding arg fails cleanly (received undefined) when absent.
        expect(() => parseValidatorMap({ constructor: v.string() }, {}, "args")).toThrow(ValidationError);
    });
});

describe("parseValidatorMap — compiled fast path", () => {
    it("uses an installed compiled parser's result verbatim on a confident success", () => {
        expect.assertions(2);

        const validators = { name: v.string() };
        let called = 0;

        installCompiledValidatorMap(validators, (source) => {
            called += 1;

            // A deliberately distinguishable result proves the fast path was used
            // (and not the interpreted loop, which would echo the input).
            return { name: `compiled:${String(source["name"])}` };
        });

        expect(parseValidatorMap(validators, { name: "ada" }, "args")).toStrictEqual({ name: "compiled:ada" });
        expect(called).toBe(1);
    });

    it("falls back to the interpreted parser when the compiled parser defers (valid input)", () => {
        expect.assertions(1);

        const validators = { amount: v.number() };

        installCompiledValidatorMap(validators, () => DEFER_VALIDATION);

        expect(parseValidatorMap(validators, { amount: 7 }, "args")).toStrictEqual({ amount: 7 });
    });

    it("lets the interpreted parser own the error when the compiled parser defers (invalid input)", () => {
        expect.assertions(2);

        const validators = { amount: v.number() };

        installCompiledValidatorMap(validators, () => DEFER_VALIDATION);

        const caught = ((): unknown => {
            try {
                parseValidatorMap(validators, { amount: "nope" }, "args");

                return undefined;
            } catch (error: unknown) {
                return error;
            }
        })();

        // Error parity: a deferring fast path produces the exact canonical error
        // the interpreted path would have thrown without any compiled parser.
        expect(caught).toBeInstanceOf(ValidationError);
        expect(caught).toMatchObject({ message: expect.stringMatching(/^args\.amount:/u), path: ["amount"] });
    });
});
