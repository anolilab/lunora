import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ModuleKind, ModuleResolutionKind, Project, ScriptTarget } from "ts-morph";
import { describe, expect, it } from "vitest";

import { runCodegen } from "../src/index";
import { makeFixtureWorkdir } from "./golden-fixtures";

const here = dirname(fileURLToPath(import.meta.url));

// Fixture apps have no node_modules, so link the workspace `@lunora/*` packages next to them, the
// way an installed app resolves them. Diagnostics are kept to the generated files: the packages
// themselves are not under test here.
const repoPackages = join(here, "..", "..", "..", "packages");

const linkWorkspacePackages = (workdir: string): void => {
    const scope = join(workdir, "node_modules", "@lunora");

    mkdirSync(scope, { recursive: true });

    for (const directory of readdirSync(repoPackages)) {
        const manifest = join(repoPackages, directory, "package.json");

        if (existsSync(manifest)) {
            const { name } = JSON.parse(readFileSync(manifest, "utf8")) as { name: string };

            if (name.startsWith("@lunora/")) {
                symlinkSync(join(repoPackages, directory), join(scope, name.slice("@lunora/".length)));
            }
        }
    }
};

const compileGenerated = (app: string): string => {
    linkWorkspacePackages(dirname(app));

    const project = new Project({
        compilerOptions: {
            exactOptionalPropertyTypes: true,
            module: ModuleKind.ESNext,
            moduleResolution: ModuleResolutionKind.Bundler,
            noEmit: true,
            skipLibCheck: true,
            strict: true,
            target: ScriptTarget.ES2022,
        },
    });

    project.addSourceFileAtPath(join(app, "_generated", "shard.ts"));
    project.addSourceFileAtPath(join(app, "_generated", "app.ts"));

    const generated = project.getPreEmitDiagnostics().filter((diagnostic) => diagnostic.getSourceFile()?.getFilePath().includes("/_generated/"));

    return project.formatDiagnosticsWithColorAndContext(generated);
};

describe("generated strict optional properties", () => {
    it("compiles the complete shard for a counter app with identity", () => {
        expect.assertions(1);

        const workdir = mkdtempSync(join(here, "fixtures", ".workdir-"));
        const app = join(workdir, "lunora");

        try {
            mkdirSync(app);
            writeFileSync(
                join(app, "schema.ts"),
                `
                import { defineSchema, defineTable, v } from "@lunora/server";
                export default defineSchema({ counter: defineTable({ value: v.number() }) });
            `,
            );
            writeFileSync(
                join(app, "identity.ts"),
                `
                import { defineIdentity, v } from "@lunora/server";
                export const identity = defineIdentity({ userId: v.string() });
            `,
            );
            writeFileSync(
                join(app, "counter.ts"),
                `
                import { mutation, query, v } from "./_generated/server.js";
                export const read = query.input({}).query(async () => 0);
                export const write = mutation.input({ value: v.number() }).mutation(async ({ args }) => args.value);
            `,
            );
            runCodegen({ lint: false, projectRoot: workdir, wranglerQueueProducers: [] });

            expect(compileGenerated(app)).toBe("");
        } finally {
            rmSync(workdir, { force: true, recursive: true });
        }
    });

    it("compiles sharded vectors and a push queue", () => {
        expect.assertions(1);

        const workdir = mkdtempSync(join(here, "fixtures", ".workdir-"));
        const app = join(workdir, "lunora");

        try {
            mkdirSync(app);
            writeFileSync(
                join(app, "schema.ts"),
                `
                import { defineSchema, defineTable, v } from "@lunora/server";
                export default defineSchema({
                    docs: defineTable({ body: v.string(), tenantId: v.string() })
                        .shardBy("tenantId")
                        .vectorize("body", { dimensions: 4, index: "docs_search", metric: "cosine" }),
                });
            `,
            );
            writeFileSync(
                join(app, "queues.ts"),
                `
                import { defineQueue } from "@lunora/queue";
                export const notifications = defineQueue<{ to: string }>({
                    handler: (context, batch) => {
                        for (const message of batch.messages) {
                            message.ack();
                        }
                    },
                });
            `,
            );
            writeFileSync(
                join(app, "docs.ts"),
                `
                import { query, v } from "./_generated/server.js";
                export const count = query.input({}).query(async () => 0);
            `,
            );
            runCodegen({ lint: false, projectRoot: workdir, wranglerQueueProducers: [] });

            expect(compileGenerated(app)).toBe("");
        } finally {
            rmSync(workdir, { force: true, recursive: true });
        }
    });

    it.each(["agent-sandbox", "ai-search", "analytics-sql", "artifacts", "delta-sync", "hyperdrive-shape", "sdk-surface"])(
        "compiles the generated shard and app for the %s fixture",
        (fixture) => {
            expect.assertions(1);

            const workdir = makeFixtureWorkdir(join(here, "fixtures", fixture));

            try {
                runCodegen({ lint: false, projectRoot: workdir, wranglerQueueProducers: [] });

                expect(compileGenerated(join(workdir, "lunora"))).toBe("");
            } finally {
                rmSync(workdir, { force: true, recursive: true });
            }
        },
    );
});
