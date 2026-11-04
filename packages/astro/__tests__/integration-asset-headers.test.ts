import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { lunora } from "../src/integration";

/** `astro:config:done`, then `astro:build:done` for the client output at `dist/client`, as `astro build` runs them. */
const build = async (root: string): Promise<void> => {
    const integration = lunora();
    const configDone = integration.hooks["astro:config:done"] as (context: unknown) => void;
    const buildDone = integration.hooks["astro:build:done"] as (context: unknown) => Promise<void>;
    const logger = { info: vi.fn<(message: string) => void>(), warn: vi.fn<(message: string) => void>() };

    configDone({ config: { build: { assets: "_astro" }, publicDir: pathToFileURL(join(root, "public/")), root: pathToFileURL(`${root}/`) }, logger });
    await buildDone({ dir: pathToFileURL(join(root, "dist", "client/")), logger });
};

describe("lunora() Astro integration — managed _headers", () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-astro-headers-"));
        mkdirSync(join(root, "dist", "client"), { recursive: true });
        mkdirSync(join(root, "lunora"));
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    it("writes the security headers and caches _astro/ for good when wrangler serves the client output", async () => {
        expect.assertions(2);

        writeFileSync(join(root, "wrangler.jsonc"), '{ "name": "app", "assets": { "directory": "./dist/client" } }\n', "utf8");

        await build(root);

        const text = readFileSync(join(root, "dist", "client", "_headers"), "utf8");

        expect(text).toContain("  X-Content-Type-Options: nosniff");
        expect(text).toContain("/_astro/*\n  Cache-Control: public, max-age=31536000, immutable");
    });

    it("writes nothing when wrangler deploys another directory", async () => {
        expect.assertions(1);

        writeFileSync(join(root, "wrangler.jsonc"), '{ "name": "app", "assets": { "directory": "./dist" } }\n', "utf8");

        await build(root);

        expect(existsSync(join(root, "dist", "client", "_headers"))).toBe(false);
    });
});
