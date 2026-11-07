import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
