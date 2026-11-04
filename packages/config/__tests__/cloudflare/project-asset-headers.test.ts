import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeProjectAssetHeaders } from "../../src/cloudflare/project-asset-headers";

describe(writeProjectAssetHeaders, () => {
    let projectRoot: string;
    let output: string;

    const writeWrangler = (config: Record<string, unknown>): void => {
        writeFileSync(join(projectRoot, "wrangler.jsonc"), JSON.stringify({ name: "app", ...config }), "utf8");
    };

    const run = (overrides: Partial<Parameters<typeof writeProjectAssetHeaders>[0]> = {}) =>
        writeProjectAssetHeaders({
            hashedDirectory: "_astro",
            outputDirectory: output,
            projectRoot,
            requireAssetsDirectory: true,
            schemaDir: "lunora",
            target: "cloudflare",
            ...overrides,
        });

    beforeEach(() => {
        projectRoot = mkdtempSync(join(tmpdir(), "lunora-project-asset-headers-"));
        output = join(projectRoot, "dist", "client");
        mkdirSync(output, { recursive: true });
        mkdirSync(join(projectRoot, "lunora"));
    });

    afterEach(() => {
        rmSync(projectRoot, { force: true, recursive: true });
        vi.unstubAllEnvs();
    });

    it("writes into the build output when it is wrangler's assets.directory", () => {
        expect.assertions(3);

        writeWrangler({ assets: { directory: "./dist/client" } });

        expect(run().written).toBe(true);

        const text = readFileSync(join(output, "_headers"), "utf8");

        expect(text).toContain("  X-Content-Type-Options: nosniff");
        expect(text).toContain("/_astro/*\n  Cache-Control: public, max-age=31536000, immutable");
    });

    it("writes nothing into an output wrangler does not deploy, where _headers would be served as a file", () => {
        expect.assertions(3);

        writeWrangler({ assets: { directory: "./dist" } });

        expect(run()).toStrictEqual({ reason: "the build output is not wrangler's assets.directory (./dist)", written: false });

        writeWrangler({});

        expect(run().written).toBe(false);
        expect(existsSync(join(output, "_headers"))).toBe(false);
    });

    it("matches the CLOUDFLARE_ENV block's assets.directory, which overrides the top level", () => {
        expect.assertions(1);

        writeWrangler({ assets: { directory: "./dist" }, env: { staging: { assets: { directory: "./dist/client" } } } });
        vi.stubEnv("CLOUDFLARE_ENV", "staging");

        expect(run().written).toBe(true);
    });

    it("writes nothing for another target", () => {
        expect.assertions(1);

        writeWrangler({ assets: { directory: "./dist/client" } });

        expect(run({ target: "celld" }).written).toBe(false);
    });

    it.each([
        ["not_found_handling is a fallback, whose page the rule would cache for a year", { not_found_handling: "single-page-application" }, false],
        ["a public/ folder of the same name copies unhashed files in", {}, true],
    ])("leaves the immutable rule out when %s", (_reason, assets, publicCollision) => {
        expect.assertions(2);

        writeWrangler({ assets: { directory: "./dist/client", ...assets } });

        const publicDirectory = join(projectRoot, "public");

        mkdirSync(join(publicDirectory, publicCollision ? "_astro" : "other"), { recursive: true });

        run({ publicDirectory });

        const text = readFileSync(join(output, "_headers"), "utf8");

        expect(text).toContain("  X-Content-Type-Options: nosniff");
        expect(text).not.toContain("Cache-Control");
    });
});
