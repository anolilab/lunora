import { describe, expect, it } from "vitest";

import { toCsv, toJson, toSql } from "../../../src/features/data/grid-features";

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

    it("neutralizes spreadsheet formula-injection triggers with a leading tab", () => {
        expect.assertions(1);

        const csv = toCsv(["v"], [{ v: "=WEBSERVICE(1)" }, { v: "+1" }, { v: "-1+2" }, { v: "@foo" }, { v: "\tleading tab" }, { v: "\rleading cr" }]);

        expect(csv).toBe("v\n\t=WEBSERVICE(1)\n\t+1\n\t-1+2\n\t@foo\n\t\tleading tab\n\t\rleading cr");
    });

    it("does not alter number-typed negative values (neutralization is scoped to strings)", () => {
        expect.assertions(1);

        expect(toCsv(["n"], [{ n: -5 }])).toBe("n\n-5");
    });

    it("renders a bytes cell the way the grid does, not as the `{}` an ArrayBuffer stringifies to", () => {
        expect.assertions(2);

        expect(toCsv(["blob"], [{ blob: Uint8Array.from([1, 2, 3, 4]).buffer }])).toBe("blob\n<bytes: 4 B>");
        // And a nested bigint no longer throws mid-export.
        expect(toCsv(["meta"], [{ meta: { amount: 42n } }])).toBe('meta\n"{""amount"":""42""}"');
    });
});

describe("toJson", () => {
    it("pretty-prints the rows as a JSON array", () => {
        expect.assertions(1);

        expect(toJson([{ id: 1 }])).toBe('[\n  {\n    "id": 1\n  }\n]');
    });
});

describe("toSql", () => {
    it("writes one multi-row INSERT with quoted identifiers and typed literals", () => {
        expect.assertions(1);

        const sql = toSql(
            "users",
            ["id", "name", "active"],
            [
                { active: true, id: 1, name: "ada" },
                { active: false, id: 2, name: "grace" },
            ],
        );

        expect(sql).toBe('INSERT INTO "users" ("id", "name", "active") VALUES\n  (1, \'ada\', 1),\n  (2, \'grace\', 0);');
    });

    it("renders null/undefined as NULL, non-finite numbers as NULL, and structured values as quoted JSON", () => {
        expect.assertions(1);

        const sql = toSql("t", ["a", "b", "c", "d"], [{ a: null, b: undefined, c: Number.NaN, d: { nested: true } }]);

        expect(sql).toBe('INSERT INTO "t" ("a", "b", "c", "d") VALUES\n  (NULL, NULL, NULL, \'{"nested":true}\');');
    });

    it("doubles embedded single quotes in strings and double quotes in identifiers", () => {
        expect.assertions(1);

        const sql = toSql("query-result", ['we"ird'], [{ 'we"ird': "O'Brien" }]);

        expect(sql).toBe('INSERT INTO "query-result" ("we""ird") VALUES\n  (\'O\'\'Brien\');');
    });

    it("renders a bytes cell as its grid rendering rather than the empty `'{}'` an ArrayBuffer stringifies to", () => {
        expect.assertions(1);

        expect(toSql("t", ["blob"], [{ blob: Uint8Array.from([1, 2, 3, 4]).buffer }])).toBe('INSERT INTO "t" ("blob") VALUES\n  (\'<bytes: 4 B>\');');
    });

    it("returns an empty string when there are no columns or no rows", () => {
        expect.assertions(2);

        expect(toSql("t", [], [{ a: 1 }])).toBe("");
        expect(toSql("t", ["a"], [])).toBe("");
    });
});
