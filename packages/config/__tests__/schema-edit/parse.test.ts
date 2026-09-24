import { describe, expect, it } from "vitest";

import type { ParseSchemaResult, SchemaTable } from "../../src/schema-edit/parse";
import { parseSchema } from "../../src/schema-edit/parse";

const SCHEMA = `import { defineSchema, defineTable, v } from "@lunora/server";

export default defineSchema({
    users: defineTable({
        email: v.string(),
        name: v.string(),
    })
        .global()
        .index("by_email", ["email"], { unique: true }),

    posts: defineTable({
        authorId: v.id("users"),
        title: v.string(),
        imageKey: v.optional(v.string()),
    }).index("by_author", ["authorId"]),

    presence: defineTable({
        cursor: v.number(),
    }).shardBy("roomId"),
});
`;

/** Narrow a parse result to its tables, failing the test if it did not parse. */
const tablesOf = (result: ParseSchemaResult): ReadonlyArray<SchemaTable> => {
    if (!result.ok) {
        throw new Error(`expected ok parse, got ${result.reason}`);
    }

    return result.tables;
};

describe("parseSchema", () => {
    it("parses tables with typed columns, optional flags, indexes, shardBy and global", () => {
        expect.assertions(6);

        const tables = tablesOf(parseSchema(SCHEMA));
        const users = tables.find((table) => table.name === "users");
        const posts = tables.find((table) => table.name === "posts");
        const presence = tables.find((table) => table.name === "presence");

        expect(users?.global).toBe(true);
        expect(users?.indexes).toStrictEqual([{ fields: ["email"], name: "by_email", unique: true }]);
        expect(posts?.columns).toStrictEqual([
            { name: "authorId", optional: false, validator: 'v.id("users")' },
            { name: "title", optional: false, validator: "v.string()" },
            { name: "imageKey", optional: true, validator: "v.optional(v.string())" },
        ]);
        expect(posts?.indexes).toStrictEqual([{ fields: ["authorId"], name: "by_author", unique: false }]);
        expect(presence?.shardBy).toBe("roomId");
        expect(presence?.global).toBe(false);
    });

    it("reads the columns of a table declared without a trailing chain", () => {
        expect.assertions(1);

        // `defineTable({ … })` with no `.index()`/`.global()` IS the initializer
        // node, not a descendant of it — reading only descendants saw no columns.
        const chainless = `import { defineSchema, defineTable, v } from "@lunora/server";\n\nexport default defineSchema({\n    posts: defineTable({\n        title: v.string(),\n        body: v.optional(v.string()),\n    }),\n});\n`;

        expect(tablesOf(parseSchema(chainless))[0]?.columns).toStrictEqual([
            { name: "title", optional: false, validator: "v.string()" },
            { name: "body", optional: true, validator: "v.optional(v.string())" },
        ]);
    });

    it("reports no-define-schema when the file declares no schema", () => {
        expect.assertions(1);

        expect(parseSchema(`export const noop = 1;\n`)).toStrictEqual({ ok: false, reason: "no-define-schema" });
    });

    it("reports aliased-define-schema when the import is aliased", () => {
        expect.assertions(1);

        const aliased = `import { defineSchema as ds, defineTable, v } from "@lunora/server";\nexport default ds({ a: defineTable({ x: v.string() }) });\n`;

        expect(parseSchema(aliased)).toStrictEqual({ ok: false, reason: "aliased-define-schema" });
    });
});
