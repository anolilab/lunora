import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverCountReads from "../../src/discover/count-reads";
import discoverSchema from "../../src/discover/schema";

let workdir: string;

/** `count()` reads of `lunora/counts.ts`, as `table → indexed`, after the schema in `schemaSource` is read. */
const indexedByTable = (schemaSource: string): Record<string, boolean> => {
    writeFileSync(join(workdir, "lunora", "schema.ts"), schemaSource, "utf8");
    writeFileSync(
        join(workdir, "lunora", "counts.ts"),
        `export const tally = internalMutation.mutation(async ({ ctx }) => {
    await ctx.db.count("posts");
    await ctx.db.jobs.count({ state: "open" });
    await ctx.db.count("jobs", { state: "open" });
    await ctx.db.users.count();
    await ctx.db.count("ghost");
    await ctx.db.count(dynamicTable);
    await ctx.db.query("posts").collect();
});
`,
        "utf8",
    );

    const project = new Project({ skipAddingFilesFromTsConfig: true });
    const schema = discoverSchema(project, join(workdir, "lunora", "schema.ts"));
    const reads = discoverCountReads(project, join(workdir, "lunora"), schema.tables);

    return Object.fromEntries(reads.map((read) => [`${read.table}@${read.line.toString()}`, read.indexed]));
};

const SCHEMA_WITH_INLINE_AND_STANDALONE = `import { defineAggregateIndex, defineSchema, defineTable, v } from "@lunora/server";

export default defineSchema(
    {
        jobs: defineTable({ state: v.string() }).aggregateIndex("byState", { by: ["state"] }),
        posts: defineTable({ title: v.string() }),
        users: defineTable({ name: v.string() }),
    },
    {},
    { byName: defineAggregateIndex("byName", { on: "users", by: ["name"] }) },
);
`;

describe("discover/count-reads", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-count-reads-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("flags a count on a table with no aggregate index, in both the table-name and facade forms", () => {
        expect.assertions(2);

        const indexed = indexedByTable(SCHEMA_WITH_INLINE_AND_STANDALONE);

        // `posts` declares no aggregate index, so its count is a scan.
        expect(indexed["posts@2"]).toBe(false);
        // `users` is covered by the standalone `defineAggregateIndex`, so it is not.
        expect(indexed["users@5"]).toBe(true);
    });

    it("reads a table with an inline aggregate index as indexed, whatever the where", () => {
        expect.assertions(2);

        const indexed = indexedByTable(SCHEMA_WITH_INLINE_AND_STANDALONE);

        expect(indexed["jobs@3"]).toBe(true);
        expect(indexed["jobs@4"]).toBe(true);
    });

    it("reads an unknown table or a dynamic table name as indexed, so it is never reported", () => {
        expect.assertions(2);

        const indexed = indexedByTable(SCHEMA_WITH_INLINE_AND_STANDALONE);

        expect(indexed["ghost@6"]).toBe(true);
        expect(indexed["@7"]).toBe(true);
    });

    it("ignores a read that is not a count", () => {
        expect.assertions(1);

        const indexed = indexedByTable(SCHEMA_WITH_INLINE_AND_STANDALONE);

        // The `query("posts")` on line 8 is a read, not a count, so no row keys it.
        expect(Object.keys(indexed)).not.toContain("posts@8");
    });

    it("marks every table when the standalone aggregate argument cannot be read", () => {
        expect.assertions(1);

        // `aggregateIndexes` is a name, not a literal, so its entries could name any table.
        const indexed = indexedByTable(
            `import { defineSchema, defineTable, v } from "@lunora/server";
const aggregateIndexes = {};

export default defineSchema({ posts: defineTable({ title: v.string() }), users: defineTable({ name: v.string() }) }, {}, aggregateIndexes);
`,
        );

        expect(Object.values(indexed).every(Boolean)).toBe(true);
    });
});
