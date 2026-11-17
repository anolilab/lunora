import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { emitProjectAssetHeaders } from "../../src/cloudflare/project-asset-headers";

describe(emitProjectAssetHeaders, () => {
    let projectRoot: string;
    let output: string;

    const writeWrangler = (config: Record<string, unknown>): void => {
        writeFileSync(join(projectRoot, "wrangler.jsonc"), JSON.stringify({ name: "app", ...config }), "utf8");
    };

    const logger = { info: vi.fn<(message: string) => void>(), warn: vi.fn<(message: string) => void>() };

    const run = (overrides: Partial<Parameters<typeof emitProjectAssetHeaders>[0]> = {}) =>
        emitProjectAssetHeaders(
            {
                hashedDirectory: "_astro",
                outputDirectory: output,
                projectRoot,
                requireAssetsDirectory: true,
                schemaDir: "lunora",
                target: "cloudflare",
                ...overrides,
            },
            logger,
        );

    beforeEach(() => {
        projectRoot = mkdtempSync(join(tmpdir(), "lunora-project-asset-headers-"));
        output = join(projectRoot, "dist", "client");
        mkdirSync(output, { recursive: true });
        mkdirSync(join(projectRoot, "lunora"));
    });

    afterEach(() => {
        rmSync(projectRoot, { force: true, recursive: true });
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
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

    it("reads LUNORA_SECURITY_HEADERS from the top-level vars, or the env block's own, when lunora.config sets nothing", () => {
        expect.assertions(4);

        const headersFor = (environment: string | undefined): string => {
            if (environment === undefined) {
                vi.unstubAllEnvs();
            } else {
                vi.stubEnv("CLOUDFLARE_ENV", environment);
            }

            rmSync(join(output, "_headers"), { force: true });
            run();

            return existsSync(join(output, "_headers")) ? readFileSync(join(output, "_headers"), "utf8") : "";
        };

        writeWrangler({
            assets: { directory: "./dist/client" },
            env: { open: { vars: {} }, staging: { vars: { LUNORA_SECURITY_HEADERS: "false" } } },
            vars: { LUNORA_SECURITY_HEADERS: "off" },
        });

        expect(headersFor(undefined)).not.toContain("nosniff");
        expect(headersFor("staging")).not.toContain("nosniff");
        // `vars` is not inheritable: an env block without the key does not inherit the top-level off.
        expect(headersFor("open")).toContain("nosniff");

        writeWrangler({ assets: { directory: "./dist/client" } });

        expect(headersFor(undefined)).toContain("nosniff");
    });

    it("prefers lunora.config's security.headers over the env var, as the Worker does", () => {
        expect.assertions(1);

        writeWrangler({ assets: { directory: "./dist/client" }, vars: { LUNORA_SECURITY_HEADERS: "off" } });
        writeFileSync(join(projectRoot, "lunora.config.ts"), 'export default { security: { headers: { crossOriginOpenerPolicy: "unsafe-none" } } };\n', "utf8");
        run();

        expect(readFileSync(join(output, "_headers"), "utf8")).toContain("  Cross-Origin-Opener-Policy: unsafe-none");
    });

    it("keeps the defaults for a security.headers that would break a header line", () => {
        expect.assertions(1);

        writeWrangler({ assets: { directory: "./dist/client" } });
        writeFileSync(
            join(projectRoot, "lunora.config.ts"),
            'export default { security: { headers: { frameAncestors: ["https://a.example; script-src *"] } } };\n',
            "utf8",
        );
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        run();

        expect(readFileSync(join(output, "_headers"), "utf8")).toContain("  X-Frame-Options: SAMEORIGIN");
    });

    it("caches the hashed directory for good only once a wrangler config says how a miss is handled", () => {
        expect.assertions(4);

        run({ requireAssetsDirectory: false });

        expect(readFileSync(join(output, "_headers"), "utf8")).not.toContain("immutable");
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("no long-term caching for _astro/, because no wrangler.jsonc or wrangler.json was found"),
        );

        writeFileSync(join(projectRoot, "wrangler.jsonc"), '{ "name": "app", "assets": { ', "utf8");
        run({ requireAssetsDirectory: false });

        expect(readFileSync(join(output, "_headers"), "utf8")).not.toContain("immutable");

        writeWrangler({ assets: { directory: "./dist/client" } });
        run({ requireAssetsDirectory: false });

        expect(readFileSync(join(output, "_headers"), "utf8")).toContain("/_astro/*\n  Cache-Control: public, max-age=31536000, immutable");
    });

    it("reports the headers left to the user's own rules, and each warning, through the build's logger", () => {
        expect.assertions(2);

        writeWrangler({ assets: { directory: "./dist/client" } });
        writeFileSync(join(output, "_headers"), "/*\n  X-Frame-Options: DENY\n/admin/*\n  Referrer-Policy: no-referrer\n", "utf8");
        run();

        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("kept your own X-Frame-Options"));
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('"/admin/*" sets Referrer-Policy'));
    });
});
