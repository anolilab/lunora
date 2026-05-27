import { describe, expect, test } from "vitest";

import { insertTableIntoSchema } from "../../../.vis/templates/_helpers/insert-table.js";

const baseSchema = `import { defineSchema, defineTable, v } from "@cirrus/server";

export const schema = defineSchema({
    users: defineTable({
        email: v.string(),
    }),
});
`;

describe("insertTableIntoSchema", () => {
    test("adds a new table to an existing defineSchema call", () => {
        const result = insertTableIntoSchema(baseSchema, "messages");

        expect(result.ok).toBe(true);

        if (!result.ok) {
            return;
        }

        expect(result.text).toContain("users: defineTable({");
        expect(result.text).toContain("messages: defineTable({");
    });

    test("preserves the original users table unchanged", () => {
        const result = insertTableIntoSchema(baseSchema, "messages");

        expect(result.ok).toBe(true);

        if (!result.ok) {
            return;
        }

        // The original users entry survives the rewrite verbatim, comments
        // and all — that's the whole point of going through ts-morph rather
        // than string-splicing.
        expect(result.text).toContain("email: v.string(),");
    });

    test("rejects a duplicate table name", () => {
        const result = insertTableIntoSchema(baseSchema, "users");

        expect(result).toEqual({ ok: false, reason: "duplicate" });
    });

    test("rejects a file without a defineSchema(...) call", () => {
        const source = `export const schema = {};\n`;
        const result = insertTableIntoSchema(source, "messages");

        expect(result).toEqual({ ok: false, reason: "no-define-schema" });
    });

    test("rejects defineSchema called with a non-object literal argument", () => {
        const source = `import { defineSchema } from "@cirrus/server";

const tables = { users: {} };
export const schema = defineSchema(tables);
`;
        const result = insertTableIntoSchema(source, "messages");

        expect(result).toEqual({ ok: false, reason: "non-object-argument" });
    });

    test("reports no-define-schema when the import is aliased", () => {
        // Documented edge case: alias-aware matching is not implemented.
        // The test pins the current behaviour so a future change to support
        // aliases doesn't silently flip semantics.
        const source = `import { defineSchema as ds } from "@cirrus/server";

export const schema = ds({
    users: defineTable({}),
});
`;
        const result = insertTableIntoSchema(source, "messages");

        expect(result).toEqual({ ok: false, reason: "no-define-schema" });
    });
});
