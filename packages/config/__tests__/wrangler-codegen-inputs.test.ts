import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCodegen } from "@lunora/codegen";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { wranglerCodegenInputs } from "../src/cloudflare/wrangler-codegen-inputs";

describe("wranglerCodegenInputs — wranglerQueueProducers", () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-wrangler-codegen-inputs-"));
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    it("reads the producers of the top level and every env block, with their scope, skipping malformed entries", () => {
        expect.assertions(1);

        writeFileSync(
            join(root, "wrangler.jsonc"),
            `{
                "name": "app",
                "queues": { "producers": [{ "binding": "QUEUE_JOBS", "queue": "jobs" }] },
                "env": {
                    // Per-environment queue names, same binding.
                    "preview": { "queues": { "producers": [{ "binding": "QUEUE_JOBS", "queue": "jobs-preview" }, null, { "binding": "QUEUE_X" }] } },
                    "staging": null,
                },
            }`,
            "utf8",
        );

        expect(wranglerCodegenInputs(root).wranglerQueueProducers).toStrictEqual([
            { binding: "QUEUE_JOBS", queue: "jobs" },
            { binding: "QUEUE_JOBS", env: "preview", queue: "jobs-preview" },
        ]);
    });

    it("ignores a producers value that is not an array", () => {
        expect.assertions(1);

        writeFileSync(
            join(root, "wrangler.jsonc"),
            `{ "name": "app", "queues": { "producers": {} }, "env": { "preview": { "queues": { "producers": "QUEUE_JOBS" } } } }`,
            "utf8",
        );

        expect(wranglerCodegenInputs(root).wranglerQueueProducers).toStrictEqual([]);
    });

    it("returns empty inputs without a wrangler config", () => {
        expect.assertions(1);

        expect(wranglerCodegenInputs(root)).toStrictEqual({ wranglerQueueProducers: [], wranglerVariables: [] });
    });
});

describe("wranglerCodegenInputs — spaAssetsBindings", () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-wrangler-codegen-inputs-"));
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    it("names the binding of an assets block that falls back to a single-page app, top level or env", () => {
        expect.assertions(4);

        writeFileSync(
            join(root, "wrangler.jsonc"),
            '{ "name": "app", "assets": { "binding": "ASSETS", "not_found_handling": "single-page-application" } }',
            "utf8",
        );

        expect(wranglerCodegenInputs(root).spaAssetsBindings).toStrictEqual(["ASSETS"]);

        writeFileSync(
            join(root, "wrangler.jsonc"),
            '{ "name": "app", "assets": { "binding": "ASSETS" }, "env": { "spa": { "assets": { "binding": "STATIC", "not_found_handling": "single-page-application" } } } }',
            "utf8",
        );

        expect(wranglerCodegenInputs(root).spaAssetsBindings).toStrictEqual(["STATIC"]);

        // Each environment's block replaces the top-level one whole, so each binding name is kept, once.
        writeFileSync(
            join(root, "wrangler.jsonc"),
            '{ "name": "app", "assets": { "binding": "ASSETS", "not_found_handling": "single-page-application" }, "env": { "preview": { "assets": { "binding": "STATIC", "not_found_handling": "single-page-application" } }, "staging": { "assets": { "binding": "ASSETS", "not_found_handling": "single-page-application" } } } }',
            "utf8",
        );

        expect(wranglerCodegenInputs(root).spaAssetsBindings).toStrictEqual(["ASSETS", "STATIC"]);

        // No binding: the Worker has nothing to serve the shell from.
        writeFileSync(join(root, "wrangler.jsonc"), '{ "name": "app", "assets": { "not_found_handling": "single-page-application" } }', "utf8");

        expect(wranglerCodegenInputs(root).spaAssetsBindings).toBeUndefined();
    });
});

describe("wranglerCodegenInputs — workerEntry", () => {
    const LOADS_ENV = `import { env } from "cloudflare:workers";\n\nexport const binding = () => env;\n`;
    const HANDLER = "export default { fetch: () => new Response() };\n";
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-wrangler-worker-entry-"));
        mkdirSync(join(root, "lunora"));
        writeFileSync(
            join(root, "lunora", "schema.ts"),
            `import { defineSchema, defineTable, v } from "@lunora/server";\n\nexport default defineSchema({ todos: defineTable({ text: v.string() }) });\n`,
        );
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    const source = (path: string, text: string): void => {
        mkdirSync(join(root, path, ".."), { recursive: true });
        writeFileSync(join(root, path), text);
    };

    /** The cloudflare: refusals a node build of the project gets from codegen, fed the same way every caller feeds it. */
    const cloudflareRefusals = (): string[] =>
        runCodegen({ dryRun: true, projectRoot: root, target: "node", ...wranglerCodegenInputs(root, "node") })
            .platformDiagnostics.map((entry) => entry.message)
            .filter((message) => message.includes("cloudflare:"));

    it("is wrangler's main when it names a file", () => {
        expect.assertions(1);

        source("worker/main.ts", HANDLER);
        writeFileSync(join(root, "wrangler.jsonc"), `{ "name": "app", "main": "worker/main.ts" }`);

        expect(wranglerCodegenInputs(root).workerEntry).toBe(join(root, "worker", "main.ts"));
    });

    it("falls back to src/server.ts with no main, and codegen refuses its cloudflare: import on node", () => {
        expect.assertions(2);

        source("src/server.ts", LOADS_ENV);
        writeFileSync(join(root, "wrangler.jsonc"), `{ "name": "app" }`);

        expect(wranglerCodegenInputs(root).workerEntry).toBe(join(root, "src", "server.ts"));
        expect(cloudflareRefusals().join("\n")).toContain("src/server.ts (cloudflare:workers)");
    });

    it("falls back to src/server.ts with no wrangler config at all", () => {
        expect.assertions(1);

        source("src/server.ts", HANDLER);

        expect(wranglerCodegenInputs(root).workerEntry).toBe(join(root, "src", "server.ts"));
    });

    it("is the composed src/worker.ts over an unused main, whose cloudflare: import is not refused", () => {
        expect.assertions(2);

        // `lunora deploy` bundles src/worker.ts in place of main, so main never reaches the bundle.
        source("src/worker.ts", HANDLER);
        source("worker/main.ts", LOADS_ENV);
        writeFileSync(join(root, "wrangler.jsonc"), `{ "name": "app", "main": "worker/main.ts" }`);

        expect(wranglerCodegenInputs(root).workerEntry).toBe(join(root, "src", "worker.ts"));
        expect(cloudflareRefusals()).toStrictEqual([]);
    });

    it("is absent for the composed virtual:lunora/worker entry", () => {
        expect.assertions(1);

        source("src/index.ts", LOADS_ENV);
        writeFileSync(join(root, "wrangler.jsonc"), `{ "name": "app", "main": "virtual:lunora/worker" }`);

        expect(wranglerCodegenInputs(root).workerEntry).toBeUndefined();
    });
});
