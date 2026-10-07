import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectWranglerQueueProducers } from "../src/cloudflare/wrangler-queue-producers";

describe("collectWranglerQueueProducers", () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-wrangler-queue-producers-"));
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    it("reads the producers of the top level and every env block, skipping malformed entries", () => {
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

        expect(collectWranglerQueueProducers(root)).toStrictEqual([
            { binding: "QUEUE_JOBS", queue: "jobs" },
            { binding: "QUEUE_JOBS", queue: "jobs-preview" },
        ]);
    });

    it("returns [] without a wrangler config", () => {
        expect.assertions(1);

        expect(collectWranglerQueueProducers(root)).toStrictEqual([]);
    });
});
