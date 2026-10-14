import type { SchemaTable } from "@lunora/config";
import { parseSchema } from "@lunora/config";
import { describe, expect, it } from "vitest";

import { innerValidator, mergeIntoSchema, planMerge } from "../src/commands/introspect/merge";
import type { IntrospectedDatabase } from "../src/commands/introspect/model";

/** A schema the developer has already edited: `title` was tightened, a comment added. */
const EXISTING = `import { defineSchema, defineTable, v } from "@lunora/server";

export default defineSchema({
    posts: defineTable({
        // Tightened by hand after the first introspect run.
        title: v.string(),
    })
        .global({ backend: "hyperdrive" })
        .index("by_title", ["title"]),
});
`;

/** Narrow `parseSchema` for fixtures — a fixture that doesn't parse is a broken test, not a case to handle. */
const tablesOf = (source: string): SchemaTable[] => {
    const parsed = parseSchema(source);

    if (!parsed.ok) {
        throw new Error(`fixture did not parse: ${parsed.reason}`);
    }

    return [...parsed.tables];
};

const database: IntrospectedDatabase = {
    dialect: "postgres",
    tables: [
        {
            columns: [
                { arrayDepth: 0, dataType: "text", name: "title", nullable: false },
                { arrayDepth: 0, dataType: "text", name: "subtitle", nullable: true },
            ],
            indexes: [
                { columns: ["title"], name: "by_title", unique: false },
                { columns: ["subtitle"], name: "by_subtitle", unique: false },
            ],
            name: "posts",
            primaryKey: [],
        },
        {
            columns: [{ arrayDepth: 0, dataType: "text", name: "email", nullable: false }],
            indexes: [],
            name: "authors",
            primaryKey: [],
        },
    ],
};

describe("mergeIntoSchema", () => {
    it("adds a newly-discovered table without touching the developer's edits", () => {
        expect.assertions(3);

        const result = mergeIntoSchema(EXISTING, database, "postgres");

        expect(result.text).toContain("authors: defineTable(");
        // The hand-written comment and the tightened validator both survive.
        expect(result.text).toContain("// Tightened by hand after the first introspect run.");
        expect(result.text).toContain("title: v.string(),");
    });

    it("marks a merged-in table .global() on the hyperdrive backend", () => {
        expect.assertions(1);

        const parsed = parseSchema(mergeIntoSchema(EXISTING, database, "postgres").text ?? "");

        expect(parsed).toMatchObject({ tables: expect.arrayContaining([expect.objectContaining({ global: true, name: "authors" })]) });
    });

    it("adds a new column to an existing table and a new index, skipping the ones already there", () => {
        expect.assertions(3);

        const text = mergeIntoSchema(EXISTING, database, "postgres").text ?? "";

        expect(text).toContain("subtitle:");
        expect(text).toContain('.index("by_subtitle", ["subtitle"])');
        // `by_title` was already declared — not duplicated.
        expect(text.match(/by_title/gu)).toHaveLength(1);
    });

    it("reports nothing to do when the schema already matches", () => {
        expect.assertions(2);

        const merged = mergeIntoSchema(EXISTING, { dialect: "postgres", tables: [database.tables[0] as never] }, "postgres");
        const second = mergeIntoSchema(merged.text ?? EXISTING, { dialect: "postgres", tables: [database.tables[0] as never] }, "postgres");

        expect(second.applied).toBe(0);
        expect(second.text).toBeUndefined();
    });

    it("leaves a column the source database dropped alone, because removing it would drop rows", () => {
        expect.assertions(1);

        const shrunk: IntrospectedDatabase = {
            dialect: "postgres",
            tables: [{ columns: [], indexes: [], name: "posts", primaryKey: [] }],
        };

        expect(mergeIntoSchema(EXISTING, shrunk, "postgres").text).toBeUndefined();
    });

    it("refuses to touch a schema it cannot parse rather than guessing", () => {
        expect.assertions(2);

        const result = mergeIntoSchema("export const nope = 1;", database, "postgres");

        expect(result.text).toBeUndefined();
        expect(result.warnings[0]).toContain("could not be parsed");
    });
});

describe("planMerge", () => {
    it("adds a required column as optional and says why", () => {
        expect.assertions(2);

        const plan = planMerge(database, tablesOf(EXISTING), "postgres");

        // A NOT NULL column added to a table that already exists still lands
        // optional, because tightening it needs a backfill.
        const required: IntrospectedDatabase = {
            dialect: "postgres",
            tables: [
                {
                    columns: [{ arrayDepth: 0, dataType: "text", name: "slug", nullable: false }],
                    indexes: [],
                    name: "posts",
                    primaryKey: [],
                },
            ],
        };
        const withRequired = planMerge(required, tablesOf(EXISTING), "postgres");

        expect(plan.edits.length).toBeGreaterThan(0);
        expect(withRequired.warnings.some((warning) => warning.includes("backfill migration"))).toBe(true);
    });

    it("skips names the schema editor's identifier rule would reject, and says so", () => {
        expect.assertions(2);

        const hostile: IntrospectedDatabase = {
            dialect: "postgres",
            tables: [{ columns: [{ arrayDepth: 0, dataType: "text", name: "a", nullable: false }], indexes: [], name: "order-items", primaryKey: [] }],
        };
        const plan = planMerge(hostile, [], "postgres");

        expect(plan.edits).toEqual([]);
        expect(plan.warnings[0]).toContain("bare identifier");
    });
});

describe("innerValidator", () => {
    it("unwraps v.optional so applyAdditiveEdit does not double it", () => {
        expect.assertions(2);

        expect(innerValidator("v.optional(v.string())")).toBe("v.string()");
        expect(innerValidator("v.string()")).toBe("v.string()");
    });
});
