import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { codegenPlugin } from "../src/codegen-plugin.js";
import type { ResolvedCirrusPluginOptions } from "../src/types.js";

const SCHEMA_SOURCE = `import { defineSchema, defineTable, v } from "@cirrus/server";

export const schema = defineSchema({
    messages: defineTable({
        channelId: v.id("channels"),
        text: v.string(),
    })
        .shardBy("channelId")
        .index("by_channel", ["channelId"]),

    users: defineTable({
        email: v.string(),
        name: v.string(),
    })
        .global()
        .index("by_email", ["email"], { unique: true }),
});
`;

const MESSAGES_SOURCE = `import { mutation, query, v } from "@cirrus/server";

export const list = query({
    args: { channelId: v.id("channels"), limit: v.optional(v.number()) },
    handler: async (_context, args) => {
        return { channelId: args.channelId, limit: args.limit ?? 50 };
    },
});

export const send = mutation({
    args: { channelId: v.id("channels"), text: v.string() },
    handler: async (_context, args) => {
        return { channelId: args.channelId, text: args.text };
    },
});
`;

let workdir: string;

const writeFixture = (root: string): void => {
    mkdirSync(join(root, "cirrus"), { recursive: true });
    writeFileSync(join(root, "cirrus", "schema.ts"), SCHEMA_SOURCE, "utf8");
    writeFileSync(join(root, "cirrus", "messages.ts"), MESSAGES_SOURCE, "utf8");
};

const makeOptions = (projectRoot: string): ResolvedCirrusPluginOptions => {
 return {
    cloudflare: false,
    dashboard: false,
    generatedDir: "cirrus/_generated",
    overlay: false,
    projectRoot,
    schemaDir: "cirrus",
    validateWrangler: false,
};
};

describe("codegen-plugin", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "cirrus-vite-codegen-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    describe("codegenPlugin", () => {
        it("buildStart runs codegen and emits the three generated files", () => {
            expect.assertions(10);

            writeFixture(workdir);

            const plugin = codegenPlugin(makeOptions(workdir));
            const hook = plugin.buildStart;

            expect(typeof hook).toBe("function");

            // Vite's buildStart is invoked with a rollup-style context. We pass `undefined`
            // because our implementation doesn't touch it.
            (hook as (this: unknown) => void).call(undefined);

            const generatedDirectory = join(workdir, "cirrus", "_generated");

            expect(existsSync(join(generatedDirectory, "api.ts"))).toBe(true);
            expect(existsSync(join(generatedDirectory, "server.ts"))).toBe(true);
            expect(existsSync(join(generatedDirectory, "dataModel.ts"))).toBe(true);

            const api = readFileSync(join(generatedDirectory, "api.ts"), "utf8");

            expect(api).toContain("export interface ApiTypes");
            expect(api).toContain("messages:");
            expect(api).toContain('list: FunctionReference<"query"');
            expect(api).toContain('send: FunctionReference<"mutation"');

            const dataModel = readFileSync(join(generatedDirectory, "dataModel.ts"), "utf8");

            expect(dataModel).toContain("export interface Doc_messages");
            expect(dataModel).toContain("export interface Doc_users");
        });

        it("buildStart logs a warning when schema.ts is missing (does not crash)", () => {
            expect.assertions(2);

            const warnings: string[] = [];
            const errors: string[] = [];
            const originalWarn = console.warn;
            const originalError = console.error;

            // eslint-disable-next-line no-console
            console.warn = (message: string) => warnings.push(message);
            // eslint-disable-next-line no-console
            console.error = (message: string) => errors.push(message);

            try {
                const plugin = codegenPlugin(makeOptions(workdir));

                (plugin.buildStart as (this: unknown) => void).call(undefined);

                expect(warnings.some((warning) => warning.includes("schema.ts not found"))).toBe(true);
                expect(errors).toHaveLength(0);
            } finally {
                // eslint-disable-next-line no-console
                console.warn = originalWarn;
                // eslint-disable-next-line no-console
                console.error = originalError;
            }
        });

        it("plugin exposes the expected name and configureServer hook", () => {
            expect.assertions(2);

            const plugin = codegenPlugin(makeOptions(workdir));

            expect(plugin.name).toBe("cirrus:codegen");

            expect(typeof plugin.configureServer).toBe("function");
        });
    });
});
