import { describe, expect, it } from "vitest";

import { ValidationError } from "../src/errors";
import { v } from "../src/v";
import { parseValidatorMap } from "../src/validator-map";

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
});
