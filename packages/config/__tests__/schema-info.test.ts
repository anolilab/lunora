import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverSchemaInfo } from "../src/schema-info";

/**
 * What the CLI and the Vite plugin read out of a project's `schema.ts` without
 * executing it.
 *
 * The `vectorMetadata` half is the load-bearing one, and its failure mode is
 * silent: Cloudflare only filters on a Vectorize metadata property that has an
 * explicit metadata index, and a missing (or wrongly typed) index makes
 * `filter` match *nothing* — no error, no warning, just an empty result set
 * that looks like "no documents matched". Both consumers derive the exact index
 * to create from what this returns, so a property missed here, or paired with
 * the wrong column kind, produces an index that can never match.
 */

const SCHEMA_HEADER = `import { defineSchema, defineTable, v } from "@lunora/server";

const embed = async (text: string): Promise<number[]> => [text.length];
`;

let workdir: string;

const seedSchema = (source: string): string => {
    mkdirSync(join(workdir, "lunora"), { recursive: true });
    writeFileSync(join(workdir, "lunora", "schema.ts"), source, "utf8");

    return workdir;
};

// One outer block so the shared temp-dir setup lives inside a describe, as the
// suite convention requires.
describe("schema info", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-schema-info-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    describe("discoverSchemaInfo", () => {
        it("returns nothing at all when the project has no schema", () => {
            expect.assertions(2);

            const result = discoverSchemaInfo(workdir, "lunora");

            // Absent, not an error: plenty of commands run before `lunora init`.
            expect(result.info).toBeUndefined();
            expect(result.error).toBeUndefined();
        });

        it("pairs each declared metadata property with the column's kind", () => {
            expect.assertions(1);

            seedSchema(`${SCHEMA_HEADER}
    export const schema = defineSchema({
        docs: defineTable({
            body: v.string(),
            published: v.boolean(),
            rank: v.number(),
            workspaceId: v.id("workspaces"),
        }).vectorize("body", { dimensions: 1024, embed, index: "docs-body", metadata: ["workspaceId", "published", "rank"], metric: "cosine" }),
    });
    `);

            // The kind is what decides the metadata index's *type*, and Vectorize
            // will not match a filter against an index created with the wrong one.
            expect(discoverSchemaInfo(workdir, "lunora").info?.vectorMetadata).toStrictEqual([
                { index: "docs-body", kind: "id", property: "workspaceId" },
                { index: "docs-body", kind: "boolean", property: "published" },
                { index: "docs-body", kind: "number", property: "rank" },
            ]);
        });

        it("reports a metadata property that names no column, rather than dropping it", () => {
            expect.assertions(1);

            seedSchema(`${SCHEMA_HEADER}
    export const schema = defineSchema({
        docs: defineTable({
            body: v.string(),
        }).vectorize("body", { dimensions: 1024, embed, index: "docs-body", metadata: ["ghost"], metric: "cosine" }),
    });
    `);

            // An unresolvable kind has to survive as `undefined` so the callers can
            // say "this can never be filtered on" — silently omitting it would look
            // identical to a schema that never declared it.
            expect(discoverSchemaInfo(workdir, "lunora").info?.vectorMetadata).toStrictEqual([{ index: "docs-body", kind: undefined, property: "ghost" }]);
        });

        it("yields an empty list for a vector index that declares no metadata", () => {
            expect.assertions(2);

            seedSchema(`${SCHEMA_HEADER}
    export const schema = defineSchema({
        docs: defineTable({ body: v.string() }).vectorize("body", { dimensions: 1024, embed, index: "docs-body", metric: "cosine" }),
    });
    `);

            const { info } = discoverSchemaInfo(workdir, "lunora");

            // The index still exists (it needs a wrangler binding); it just has
            // nothing to filter on.
            expect(info?.vectorIndexNames).toStrictEqual(["docs-body"]);
            expect(info?.vectorMetadata).toStrictEqual([]);
        });

        it("reports whether any table is global, which decides the D1 binding", () => {
            expect.assertions(2);

            seedSchema(`${SCHEMA_HEADER}
    export const schema = defineSchema({
        messages: defineTable({ channelId: v.id("channels"), text: v.string() }).shardBy("channelId"),
    });
    `);

            expect(discoverSchemaInfo(workdir, "lunora").info?.hasGlobalTable).toBe(false);

            seedSchema(`${SCHEMA_HEADER}
    export const schema = defineSchema({
        users: defineTable({ email: v.string() }).global(),
    });
    `);

            expect(discoverSchemaInfo(workdir, "lunora").info?.hasGlobalTable).toBe(true);
        });

        it("degrades to empty information on a schema it cannot make sense of, rather than throwing", () => {
            expect.assertions(3);

            seedSchema(`export const schema = defineSchema({{{ broken`);

            const result = discoverSchemaInfo(workdir, "lunora");

            // Every caller is a lint/validate/scaffold path that has other findings
            // to report, so a schema mid-edit must not take them down with it. The
            // parser is lenient and simply finds no tables; a real syntax error is
            // `lint:types`' and codegen's to report, not this one's.
            expect(result.error).toBeUndefined();
            expect(result.info?.vectorMetadata).toStrictEqual([]);
            expect(result.info?.hasGlobalTable).toBe(false);
        });
    });
});
