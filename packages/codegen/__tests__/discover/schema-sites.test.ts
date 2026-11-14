import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverSchema from "../../src/discover/schema";

/** The 1-based line of the first source line containing `text`. */
const lineOf = (source: string, text: string): number => source.split("\n").findIndex((line) => line.includes(text)) + 1;

let workdir: string;
let lunoraDirectory: string;
let schemaPath: string;

/** Write one file under `lunora/`, returning its absolute path. */
const writeLunora = (relative: string, source: string): string => {
    const full = join(lunoraDirectory, relative);

    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, source, "utf8");

    return full;
};

const discover = (schemaSource: string) => {
    writeLunora("schema.ts", schemaSource);

    return discoverSchema(new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false }), schemaPath, workdir);
};

describe("declaration sites on schema IR", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-schema-sites-"));
        lunoraDirectory = join(workdir, "lunora");
        schemaPath = join(lunoraDirectory, "schema.ts");
        mkdirSync(lunoraDirectory, { recursive: true });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("records the defineTable call's line for a table, below its JSDoc block", () => {
        expect.assertions(1);

        const source = `
            import { defineSchema, defineTable, v } from "@lunora/server";

            /** Chat messages. */
            export const schema = defineSchema({
                messages: defineTable({ text: v.string() }),
            });
        `;

        const messages = discover(source).tables.find((table) => table.name === "messages");

        expect(messages?.site).toStrictEqual({ file: "schema", line: lineOf(source, "messages: defineTable") });
    });

    it("records each index on the line of its method name, when the chain breaks across lines", () => {
        expect.assertions(2);

        const source = `
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                messages: defineTable({ channelId: v.string(), text: v.string() })
                    .index("by_channel", ["channelId"])
                    .searchIndex("by_text", { field: "text" }),
            });
        `;

        const messages = discover(source).tables.find((table) => table.name === "messages");

        expect(messages?.indexes[0]?.site).toStrictEqual({ file: "schema", line: lineOf(source, '.index("by_channel"') });
        expect(messages?.searchIndexes[0]?.site).toStrictEqual({ file: "schema", line: lineOf(source, ".searchIndex(") });
    });

    it("records a relation's property line on the relation, under the table that declares it", () => {
        expect.assertions(2);

        const source = `
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                users: defineTable({ email: v.string() }).relations((r) => ({
                    posts: r.many("posts", { field: "authorId" }),
                })),
                posts: defineTable({ authorId: v.id("users") }).relations((r) => ({
                    author: r.one("users", { field: "authorId" }),
                })),
            });
        `;

        const schema = discover(source);
        const posts = schema.tables.find((table) => table.name === "posts");

        expect(schema.tables.find((table) => table.name === "users")?.relations[0]?.site).toStrictEqual({
            file: "schema",
            line: lineOf(source, "posts: r.many"),
        });
        expect(posts?.relations[0]?.site).toStrictEqual({ file: "schema", line: lineOf(source, "author: r.one") });
    });

    it("records the table's own defineTable line when it is spread in from another lunora file", () => {
        expect.assertions(1);

        const sharedSource = `
            import { defineTable, v } from "@lunora/server";

            /** Shared tables. */
            export const sharedTables = {
                tags: defineTable({ label: v.string() }),
            };
        `;

        writeLunora("shared.ts", sharedSource);

        const schema = discover(`
            import { defineSchema } from "@lunora/server";
            import { sharedTables } from "./shared";

            export const schema = defineSchema({
                ...sharedTables,
            });
        `);

        expect(schema.tables.find((table) => table.name === "tags")?.site).toStrictEqual({
            file: "shared",
            line: lineOf(sharedSource, "tags: defineTable"),
        });
    });

    it("records the followed defineTable call for a table bound to a const", () => {
        expect.assertions(1);

        const source = `
            import { defineSchema, defineTable, v } from "@lunora/server";

            const usersTable = defineTable({ email: v.string() });

            export const schema = defineSchema({
                users: usersTable,
            });
        `;

        const users = discover(source).tables.find((table) => table.name === "users");

        expect(users?.site).toStrictEqual({ file: "schema", line: lineOf(source, "const usersTable = defineTable") });
    });
});
