import { describe, expect, it } from "vitest";

import { tokenize } from "../../../../src/features/api/openapi/json-highlight";

/** Re-join every token's text — the highlighter must never drop or reorder characters. */
const joined = (source: string): string =>
    tokenize(source)
        .map((token) => token.text)
        .join("");

describe("tokenize", () => {
    it("classifies keys, string/number/boolean values, and leaves structure plain", () => {
        expect.assertions(4);

        const tokens = tokenize('{\n  "id": 1,\n  "name": "Mars",\n  "live": true\n}');
        const kindOf = (text: string): string | undefined => tokens.find((token) => token.text === text)?.kind;

        // A quoted run trailed by `:` is a key; the same text as a value is a string.
        expect(kindOf('"id"')).toBe("key");
        expect(kindOf('"Mars"')).toBe("string");
        expect(kindOf("1")).toBe("number");
        expect(kindOf("true")).toBe("boolean");
    });

    it("round-trips the source — concatenated token text equals the input", () => {
        expect.assertions(1);

        const source = '{"nested":{"a":[1,2.5,null]},"flag":false}';

        expect(joined(source)).toBe(source);
    });
});
