import { describe, expect, it } from "vitest";

import { formatSql } from "../src/sql-editor-panel";

describe("formatSql", () => {
    it("upper-cases known keywords as whole words", () => {
        expect.assertions(1);

        expect(formatSql("select id from messages")).toBe("SELECT id\nFROM messages");
    });

    it("does not upper-case a keyword that is part of an identifier", () => {
        expect.assertions(1);

        // `format` contains `or`/`as`; `selection` starts with `select` — neither is a whole-word keyword.
        expect(formatSql("select format from selection")).toBe("SELECT format\nFROM selection");
    });

    it("breaks a new line before each major clause", () => {
        expect.assertions(1);

        const out = formatSql("SELECT a, b FROM t WHERE a > 1 ORDER BY b LIMIT 10");

        expect(out).toBe("SELECT a, b\nFROM t\nWHERE a > 1\nORDER BY b\nLIMIT 10");
    });

    it("collapses runs of whitespace", () => {
        expect.assertions(1);

        expect(formatSql("SELECT    a,\n\n   b   FROM   t")).toBe("SELECT a, b\nFROM t");
    });

    it("preserves string literals verbatim and never rewrites their contents", () => {
        expect.assertions(1);

        // `from`/`where` inside the literal must stay lower-case and on one line.
        expect(formatSql("select * from t where name = 'from where order by'")).toBe("SELECT *\nFROM t\nWHERE name = 'from where order by'");
    });

    it("does not mistake a bare numeric literal for a stashed-literal placeholder", () => {
        expect.assertions(1);

        // A standalone `5` surrounded by spaces must survive — the sentinel is NUL, not a space.
        expect(formatSql("select 5 as n from t limit 50")).toBe("SELECT 5 AS n\nFROM t\nLIMIT 50");
    });

    it("is idempotent — formatting an already-formatted query is a no-op", () => {
        expect.assertions(1);

        const once = formatSql("select id, body from messages where author = 'ada' order by id desc limit 50");

        expect(formatSql(once)).toBe(once);
    });

    it("upper-cases multi-word and join clauses", () => {
        expect.assertions(1);

        expect(formatSql("select * from a left join b on a.id = b.id group by a.id")).toBe("SELECT *\nFROM a\nLEFT JOIN b ON a.id = b.id\nGROUP BY a.id");
    });
});
