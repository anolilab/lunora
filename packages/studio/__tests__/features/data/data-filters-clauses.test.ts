import { describe, expect, it } from "vitest";

import { toFilterClauses } from "../../../src/features/data/data-filters";

describe("toFilterClauses — nested paths and array membership", () => {
    it("splits a typed nested path, omits the path for a blank box, coerces has values, and drops a blank has row", () => {
        expect.assertions(1);

        expect(
            toFilterClauses([
                { column: "address", operator: "eq", path: "geo.city", value: "Berlin" },
                { column: "address", operator: "eq", path: "  ", value: "Berlin" },
                { column: "tags", operator: "has", value: "10" },
                { column: "tags", operator: "has", value: "" },
            ]),
        ).toStrictEqual([
            { column: "address", operator: "eq", path: ["geo", "city"], value: "Berlin" },
            { column: "address", operator: "eq", value: "Berlin" },
            { column: "tags", operator: "has", value: 10 },
        ]);
    });
});

describe("toFilterClauses — path segments and typed has values", () => {
    it("keeps an empty segment of a typed path, so the server refuses it rather than a different field", () => {
        expect.assertions(1);

        expect(
            toFilterClauses([
                { column: "address", operator: "eq", path: "geo.", value: "Berlin" },
                { column: "address", operator: "eq", path: "a..b", value: "Berlin" },
                { column: "address", operator: "eq", path: ".", value: "Berlin" },
                { column: "address", operator: "eq", path: " ", value: "Berlin" },
                { column: "address", operator: "eq", path: "geo. city", value: "Berlin" },
            ]),
        ).toStrictEqual([
            { column: "address", operator: "eq", path: ["geo", ""], value: "Berlin" },
            { column: "address", operator: "eq", path: ["a", "", "b"], value: "Berlin" },
            { column: "address", operator: "eq", path: ["", ""], value: "Berlin" },
            { column: "address", operator: "eq", value: "Berlin" },
            { column: "address", operator: "eq", path: ["geo", "city"], value: "Berlin" },
        ]);
    });

    it("sends a row's carried segments verbatim, so a dotted field name is not split", () => {
        expect.assertions(1);

        expect(toFilterClauses([{ column: "address", operator: "eq", path: "a.b", pathSegments: ["a.b"], value: "x" }])).toStrictEqual([
            { column: "address", operator: "eq", path: ["a.b"], value: "x" },
        ]);
    });

    it("sends a double-quoted has value as text and an unquoted one by its type", () => {
        expect.assertions(1);

        expect(
            toFilterClauses([
                { column: "tags", operator: "has", value: '"10"' },
                { column: "tags", operator: "has", value: '"true"' },
                { column: "tags", operator: "has", value: "10" },
                { column: "tags", operator: "has", value: '"' },
            ]),
        ).toStrictEqual([
            { column: "tags", operator: "has", value: "10" },
            { column: "tags", operator: "has", value: "true" },
            { column: "tags", operator: "has", value: 10 },
            { column: "tags", operator: "has", value: '"' },
        ]);
    });
});

describe("toFilterClauses — typed booleans", () => {
    it("sends has true and has false as JSON booleans, so they match a boolean element", () => {
        expect.assertions(1);

        expect(
            toFilterClauses([
                { column: "flags", operator: "has", value: "true" },
                { column: "flags", operator: "has", value: " false " },
            ]),
        ).toStrictEqual([
            { column: "flags", operator: "has", value: true },
            { column: "flags", operator: "has", value: false },
        ]);
    });

    it("leaves an eq on the text true as text, so the boolean fix does not change equality", () => {
        expect.assertions(1);

        expect(toFilterClauses([{ column: "flag", operator: "eq", value: "true" }])).toStrictEqual([{ column: "flag", operator: "eq", value: "true" }]);
    });
});
