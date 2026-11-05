import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import writeNuxtAssetHeaders from "../src/asset-headers";

/** A built Nitro, as the `compiled` hook sees it: its public output already holds the preset's own route-rule headers. */
const nitroFor = (publicDirectory: string, dev = false): { dev: boolean; publicDirectory: string } => {
    return { dev, publicDirectory };
};

describe(writeNuxtAssetHeaders, () => {
    let root: string;
    let publicDirectory: string;
    const logger = { info: vi.fn<(message: string) => void>(), warn: vi.fn<(message: string) => void>() };

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-nuxt-headers-"));
        publicDirectory = join(root, ".output", "public");
        mkdirSync(publicDirectory, { recursive: true });
        mkdirSync(join(root, "lunora"));
        writeFileSync(join(root, "wrangler.jsonc"), '{ "name": "app", "assets": { "binding": "ASSETS", "directory": ".output/public" } }\n', "utf8");
        // What Nitro's `cloudflare_module` preset writes from Nuxt's route rules.
        writeFileSync(join(publicDirectory, "_headers"), "/_nuxt/builds/meta/*\n  cache-control: public, max-age=31536000, immutable\n", "utf8");
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    it("adds the security block above Nitro's own rules in the deployed public output", async () => {
        expect.assertions(3);

        await writeNuxtAssetHeaders(nitroFor(publicDirectory), root, logger);

        const text = readFileSync(join(publicDirectory, "_headers"), "utf8");

        expect(text.startsWith("# BEGIN lunora-managed")).toBe(true);
        expect(text).toContain("  X-Frame-Options: SAMEORIGIN");
        expect(text.endsWith("/_nuxt/builds/meta/*\n  cache-control: public, max-age=31536000, immutable\n")).toBe(true);
    });

    it("writes nothing in dev, or when wrangler deploys another directory", async () => {
        expect.assertions(2);

        await writeNuxtAssetHeaders(nitroFor(publicDirectory, true), root, logger);

        expect(readFileSync(join(publicDirectory, "_headers"), "utf8")).not.toContain("lunora-managed");

        writeFileSync(join(root, "wrangler.jsonc"), '{ "name": "app", "assets": { "directory": "dist" } }\n', "utf8");
        rmSync(join(publicDirectory, "_headers"));
        await writeNuxtAssetHeaders(nitroFor(publicDirectory), root, logger);

        expect(existsSync(join(publicDirectory, "_headers"))).toBe(false);
    });
});
