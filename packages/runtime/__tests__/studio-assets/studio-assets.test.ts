import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Unstable_DevWorker } from "wrangler";
import { unstable_dev } from "wrangler";

/**
 * Studio's documents shipped as Workers Static Assets, through wrangler's real
 * asset routing (`run_worker_first`, the router and asset workers, their path
 * decoding). A file in the assets directory is public unless the Worker runs
 * first for its path, so the proof is that no request outside the admin route
 * gets the document, in any spelling of its path.
 */

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixture");
const ADMIN_TOKEN = "studio-assets-admin";
const DOCUMENT: unknown = JSON.parse(readFileSync(join(fixture, "assets", "_lunora", "studio", "openapi.json"), "utf8"));
const MARKER = "studio-assets fixture";

let worker: Unstable_DevWorker;

describe("studio documents served from Workers Static Assets", () => {
    beforeAll(async () => {
        worker = await unstable_dev(join(fixture, "worker.ts"), {
            config: join(fixture, "wrangler.jsonc"),
            experimental: { disableExperimentalWarning: true },
            ip: "127.0.0.1",
            logLevel: "none",
            persist: false,
        });
    }, 120_000);

    afterAll(async () => {
        await worker.stop();
    });

    it("serves the document to an admin through the binding, uncached", async () => {
        expect.assertions(3);

        const response = await worker.fetch("/_lunora/admin/openapi", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });

        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        await expect(response.json()).resolves.toStrictEqual(DOCUMENT);
    });

    it("refuses the admin route without the token", async () => {
        expect.assertions(1);

        const response = await worker.fetch("/_lunora/admin/openapi");

        expect(response.status).toBe(403);
    });

    it.each([
        "/_lunora/studio/openapi.json",
        "/_lunora/studio/openapi",
        "/_lunora%2Fstudio/openapi.json",
        "/%5Flunora/studio/openapi.json",
        "/_lunora/studio/%6Fpenapi.json",
        "/_lunora/./studio/openapi.json",
        "//_lunora/studio/openapi.json",
    ])("never answers %s with the file, unauthenticated or as a page load", async (path) => {
        expect.assertions(2);

        const plain = await worker.fetch(path, { redirect: "manual" });
        const navigation = await worker.fetch(path, { headers: { accept: "text/html", "sec-fetch-mode": "navigate" }, redirect: "manual" });

        await expect(plain.text()).resolves.not.toContain(MARKER);
        await expect(navigation.text()).resolves.not.toContain(MARKER);
    });
});
