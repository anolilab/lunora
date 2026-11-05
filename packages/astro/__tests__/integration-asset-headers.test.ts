import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { lunora } from "../src/integration";

/** `astro:config:done`, then `astro:build:done` for the client output at `dist/client`, as `astro build` runs them. */
const build = async (root: string, vite?: unknown): Promise<void> => {
    const integration = lunora();
    const configDone = integration.hooks["astro:config:done"] as (context: unknown) => void;
    const buildDone = integration.hooks["astro:build:done"] as (context: unknown) => Promise<void>;
    const logger = { info: vi.fn<(message: string) => void>(), warn: vi.fn<(message: string) => void>() };

    configDone({ config: { build: { assets: "_astro" }, publicDir: pathToFileURL(join(root, "public/")), root: pathToFileURL(`${root}/`), vite }, logger });
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

    it.each([
        ["a file-name pattern without [hash]", { assetFileNames: "_astro/[name][extname]" }],
        ["a file-name function", { chunkFileNames: () => "_astro/[name].js" }],
    ])("writes no immutable rule for _astro/ when vite.build.rollupOptions.output sets %s", async (_reason, output) => {
        expect.assertions(2);

        writeFileSync(join(root, "wrangler.jsonc"), '{ "name": "app", "assets": { "directory": "./dist/client" } }\n', "utf8");

        await build(root, { build: { rollupOptions: { output } } });

        const text = readFileSync(join(root, "dist", "client", "_headers"), "utf8");

        expect(text).toContain("  X-Content-Type-Options: nosniff");
        expect(text).not.toContain("Cache-Control");
    });

    it("writes no immutable rule for _astro/ when the build left a fixed-name file there", async () => {
        expect.assertions(2);

        writeFileSync(join(root, "wrangler.jsonc"), '{ "name": "app", "assets": { "directory": "./dist/client" } }\n', "utf8");
        mkdirSync(join(root, "dist", "client", "_astro"), { recursive: true });
        writeFileSync(join(root, "dist", "client", "_astro", "index.Ab12Cd34.js"), "", "utf8");
        writeFileSync(join(root, "dist", "client", "_astro", "logo.Ab12Cd34_opts.webp"), "", "utf8");

        await build(root);

        expect(readFileSync(join(root, "dist", "client", "_headers"), "utf8")).toContain("/_astro/*\n  Cache-Control");

        writeFileSync(join(root, "dist", "client", "_astro", "partytown.js"), "", "utf8");

        await build(root);

        expect(readFileSync(join(root, "dist", "client", "_headers"), "utf8")).not.toContain("Cache-Control");
    });

    it("writes nothing when wrangler deploys another directory", async () => {
        expect.assertions(1);

        writeFileSync(join(root, "wrangler.jsonc"), '{ "name": "app", "assets": { "directory": "./dist" } }\n', "utf8");

        await build(root);

        expect(existsSync(join(root, "dist", "client", "_headers"))).toBe(false);
    });
});
