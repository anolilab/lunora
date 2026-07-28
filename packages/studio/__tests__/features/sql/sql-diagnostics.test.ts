import { describe, expect, it } from "vitest";

import type { SqlSchema } from "../../../src/features/sql/sql-autocomplete";
import type { SqlDiagnostic } from "../../../src/features/sql/sql-diagnostics";
import { lintDraft, maskNonCode } from "../../../src/features/sql/sql-diagnostics";
import { toSpans } from "../../../src/features/sql/sql-diagnostics-ui";

const schema: SqlSchema = {
    columns: { messages: ["id", "body", "authorId"], users: ["id", "name"] },
    tables: ["messages", "users", "posts"],
};

describe("maskNonCode", () => {
    it("blanks string literals and comments while preserving offsets", () => {
        expect.assertions(2);

        const sql = "SELECT 'DELETE me' FROM t -- DROP everything";
        const masked = maskNonCode(sql);

        expect(masked).toHaveLength(sql.length);
        // The forbidden words survive only where they are real code (nowhere here).
        expect(masked).not.toMatch(/DELETE|DROP/u);
    });

    it("keeps newlines so line geometry is unchanged", () => {
        expect.assertions(1);

        expect(maskNonCode("-- a\nSELECT 1")).toBe("    \nSELECT 1");
    });
});

describe("lintDraft — read-only gate", () => {
    it("stays silent on an empty draft", () => {
        expect.assertions(2);

        expect(lintDraft("", schema)).toStrictEqual([]);
        expect(lintDraft("   \n  ", schema)).toStrictEqual([]);
    });

    it("flags a write before it is ever run, pointing at the verb", () => {
        expect.assertions(3);

        const draft = "DELETE FROM messages";
        const [diagnostic] = lintDraft(draft, schema);

        expect(diagnostic).toMatchObject({ severity: "error", source: "gate" });
        expect(draft.slice(diagnostic?.offset ?? 0, (diagnostic?.offset ?? 0) + (diagnostic?.length ?? 0))).toBe("DELETE");
        expect(lintDraft(draft, schema)).toHaveLength(1);
    });

    it("suppresses schema noise once the gate has already refused the statement", () => {
        expect.assertions(2);

        // `userz` is unknown too, but the operator needs the one message that
        // explains why nothing will run.
        const diagnostics = lintDraft("DELETE FROM userz", schema);

        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]?.source).toBe("gate");
    });
});

describe("lintDraft — unknown tables", () => {
    it("flags an unknown FROM source", () => {
        expect.assertions(3);

        const draft = "SELECT * FROM userz";
        const [diagnostic] = lintDraft(draft, schema);

        expect(diagnostic).toMatchObject({ severity: "error", source: "schema" });
        expect(draft.slice(diagnostic?.offset ?? 0, (diagnostic?.offset ?? 0) + (diagnostic?.length ?? 0))).toBe("userz");
        expect(diagnostic?.message).toMatch(/userz/u);
    });

    it("accepts known tables, in any case, across a join", () => {
        expect.assertions(1);

        expect(lintDraft("SELECT * FROM Messages JOIN users ON users.id = Messages.authorId", schema)).toStrictEqual([]);
    });

    it("does not flag a CTE name bound by WITH", () => {
        expect.assertions(1);

        expect(lintDraft("WITH recent AS (SELECT * FROM messages) SELECT * FROM recent", schema)).toStrictEqual([]);
    });

    it("does not flag reserved or SQLite-internal tables", () => {
        expect.assertions(2);

        expect(lintDraft("SELECT * FROM __lunora_metrics", schema)).toStrictEqual([]);
        expect(lintDraft("SELECT * FROM sqlite_master", schema)).toStrictEqual([]);
    });

    it("does not flag a subquery source", () => {
        expect.assertions(1);

        expect(lintDraft("SELECT * FROM (SELECT 1) AS x", schema)).toStrictEqual([]);
    });

    it("ignores a table name that only appears inside a string literal", () => {
        expect.assertions(1);

        expect(lintDraft("SELECT * FROM messages WHERE body = 'from nowhere'", schema)).toStrictEqual([]);
    });
});

describe("lintDraft — unknown columns", () => {
    it("flags a qualified column the table does not have", () => {
        expect.assertions(2);

        const draft = "SELECT messages.nope FROM messages";
        const [diagnostic] = lintDraft(draft, schema);

        expect(diagnostic?.message).toMatch(/no column `nope`/u);
        expect(draft.slice(diagnostic?.offset ?? 0, (diagnostic?.offset ?? 0) + (diagnostic?.length ?? 0))).toBe("nope");
    });

    it("resolves aliases before checking columns", () => {
        expect.assertions(2);

        expect(lintDraft("SELECT m.body FROM messages m", schema)).toStrictEqual([]);
        expect(lintDraft("SELECT m.nope FROM messages AS m", schema)).toHaveLength(1);
    });

    it("never warns about a table whose columns were not probed", () => {
        expect.assertions(1);

        // `posts` is a known table but absent from `schema.columns` — warning from
        // absent knowledge is the one way this linter could actively mislead.
        expect(lintDraft("SELECT posts.anything FROM posts", schema)).toStrictEqual([]);
    });

    it("leaves unqualified columns alone", () => {
        expect.assertions(1);

        // Genuinely ambiguous across a join without a real parser.
        expect(lintDraft("SELECT nope FROM messages", schema)).toStrictEqual([]);
    });

    it("does not treat a keyword after the table as an alias", () => {
        expect.assertions(1);

        // `where` must not be bound as an alias for `messages`.
        expect(lintDraft("SELECT messages.body FROM messages WHERE id = 1", schema)).toStrictEqual([]);
    });
});

describe("toSpans", () => {
    const span = (offset: number, length: number): SqlDiagnostic => {
        return { length, message: "x", offset, severity: "error", source: "schema" };
    };

    it("orders spans and drops ones with no extent", () => {
        expect.assertions(2);

        const spans = toSpans([span(10, 2), span(0, 3), span(5, 0)], 100);

        expect(spans.map((entry) => entry.start)).toStrictEqual([0, 10]);
        expect(spans).toHaveLength(2);
    });

    it("drops a span nested inside an earlier, wider one", () => {
        expect.assertions(1);

        // A=[0,10] B=[5,6] C=[6,8]: comparing each span against its NEIGHBOUR in
        // the sorted list lets C through (it clears B), even though C sits inside
        // A — which desynchronises the overlay from the textarea for the rest of
        // the statement. The comparison must be against the last KEPT span.
        expect(toSpans([span(0, 10), span(5, 1), span(6, 2)], 100)).toHaveLength(1);
    });

    it("ignores diagnostics with no span at all", () => {
        expect.assertions(1);

        expect(toSpans([{ message: "statement-wide", severity: "error", source: "gate" }], 100)).toStrictEqual([]);
    });

    it("clamps a span that runs past the end of the draft", () => {
        expect.assertions(1);

        expect(toSpans([span(3, 99)], 10)).toStrictEqual([{ end: 10, severity: "error", start: 3 }]);
    });
});
