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
