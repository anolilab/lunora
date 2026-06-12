import { describe, expect, it } from "vitest";

import { toCsv, toJson } from "../../../src/features/data/grid-features";

describe("toCsv", () => {
    it("writes a header row then one row per record, in column order", () => {
        expect.assertions(1);

        const csv = toCsv(
            ["id", "name"],
            [
                { id: "1", name: "ada" },
                { id: "2", name: "grace" },
            ],
        );

        expect(csv).toBe("id,name\n1,ada\n2,grace");
    });

    it("renders null/undefined as empty and structured values as JSON", () => {
        expect.assertions(1);

        const csv = toCsv(["a", "b", "c"], [{ a: null, b: undefined, c: { nested: true } }]);

        expect(csv).toBe('a,b,c\n,,"{""nested"":true}"');
    });

    it("quotes (and doubles embedded quotes for) values with commas, quotes, or newlines", () => {
        expect.assertions(1);

        const csv = toCsv(["v"], [{ v: "a,b" }, { v: 'say "hi"' }, { v: "line1\nline2" }]);

        expect(csv).toBe('v\n"a,b"\n"say ""hi"""\n"line1\nline2"');
    });
});

describe("toJson", () => {
    it("pretty-prints the rows as a JSON array", () => {
        expect.assertions(1);

        expect(toJson([{ id: 1 }])).toBe('[\n  {\n    "id": 1\n  }\n]');
    });
});
