/**
 * The IR-backed schema-node reader must produce the SAME JSON Schema the
 * runtime `@lunora/values` reader produces for the same validator — that
 * equivalence is the whole reason both plug into one shared mapper, and the
 * OpenAPI/OpenRPC emitters trust it.
 *
 * Each case here is one place the two had drifted, or one place the schema
 * contradicted the runtime parser. `to-json-schema.test.ts` in `@lunora/values`
 * pins the runtime half of the same pairs.
 */
import { describe, expect, it } from "vitest";

import type { ValidatorIR } from "../src/ir";
import { objectSchema, validatorIrToJsonSchema } from "../src/schema-ir";

describe("the IR-backed JSON Schema reader", () => {
    it("carries a bigint literal the same way the bigint scalar does", () => {
        expect.assertions(2);

        // The IR records a literal as SOURCE text, so `5n` reached the numeric
        // fallback (`Number("5n")` is NaN) and emitted `{ const: "5n" }` — a
        // THIRD spelling, next to the runtime reader's `{ const: "5" }` and the
        // scalar's int64. One decimal-string carrier for all of them.
        expect(validatorIrToJsonSchema({ kind: "bigint" })).toStrictEqual({ format: "int64", type: "string" });
        expect(validatorIrToJsonSchema({ kind: "literal", literalValue: "5n" })).toStrictEqual({
            const: "5",
            format: "int64",
            type: "string",
        });
    });

    it("reflects a record's key validator as propertyNames", () => {
        expect.assertions(1);

        // The reader read `valueType` and ignored `keyType`, so a key constraint
        // the runtime enforces was inexpressible in the generated spec.
        const record: ValidatorIR = {
            keyType: { kind: "string" },
            kind: "record",
            valueType: { kind: "number" },
        };

        expect(validatorIrToJsonSchema(record)).toStrictEqual({
            additionalProperties: { type: "number" },
            propertyNames: { type: "string" },
            type: "object",
        });
    });

    it("leaves an object open and requires only what cannot be absent", () => {
        expect.assertions(1);

        // `additionalProperties: false` contradicted a parser that STRIPS
        // unknown keys, and `required` listed `v.any()` and unions with an
        // optional member — both of which parse happily when absent.
        const shape: Record<string, ValidatorIR> = {
            anything: { kind: "any" },
            maybe: { inner: { kind: "number" }, kind: "optional" },
            name: { kind: "string" },
            unionWithOptional: { kind: "union", members: [{ kind: "string" }, { inner: { kind: "number" }, kind: "optional" }] },
        };

        expect(objectSchema(shape)).toStrictEqual({
            properties: {
                anything: {},
                maybe: { type: "number" },
                name: { type: "string" },
                unionWithOptional: { anyOf: [{ type: "string" }, { type: "number" }] },
            },
            required: ["name"],
            type: "object",
        });
    });
});
