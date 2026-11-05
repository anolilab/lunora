import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import assetHeadersPlugin from "../src/asset-headers-plugin";
import type { ResolvedLunoraPluginOptions } from "../src/types";

let projectRoot: string;

const options = (target = "cloudflare"): ResolvedLunoraPluginOptions => ({ projectRoot, schemaDir: "lunora", target }) as ResolvedLunoraPluginOptions;

/** Drive the plugin through the two hooks a client build calls, with the given plugin names in the resolved config. */
const build = async (
    plugin: ReturnType<typeof assetHeadersPlugin>,
    pluginNames: string[],
    buildConfig: Record<string, unknown> = {},
    bundle: Record<string, unknown> = {},
): Promise<{ info: ReturnType<typeof vi.fn<(message: string) => void>> }> => {
    const info = vi.fn<(message: string) => void>();
    const logger = { info, warn: vi.fn<(message: string) => void>() };

    (plugin.configResolved as (config: unknown) => void)({
        plugins: pluginNames.map((name) => {
            return { name };
        }),
    });
    await (plugin.writeBundle as (this: unknown, outputOptions: unknown, outputBundle: unknown) => Promise<void>).call(
        {
            environment: {
                config: {
                    build: { assetsDir: "assets", outDir: "dist/client", rolldownOptions: {}, ...buildConfig },
                    logger,
                    publicDir: join(projectRoot, "public"),
                    root: projectRoot,
                },
            },
        },
        {},
        bundle,
    );

    return { info };
};

const headersFile = (): string => join(projectRoot, "dist", "client", "_headers");

describe(assetHeadersPlugin, () => {
    beforeEach(() => {
        projectRoot = mkdtempSync(join(tmpdir(), "lunora-asset-headers-plugin-"));
        mkdirSync(join(projectRoot, "dist", "client"), { recursive: true });
        writeFileSync(join(projectRoot, "wrangler.jsonc"), '{ "name": "app", "assets": { "directory": "./dist/client" } }\n', "utf8");
    });

    afterEach(() => {
        rmSync(projectRoot, { force: true, recursive: true });
    });

    it("runs on the client environment of a build only", () => {
        expect.assertions(3);

        const plugin = assetHeadersPlugin(options());
        const applies = plugin.applyToEnvironment as (environment: { name: string }) => boolean;

        expect(plugin.apply).toBe("build");
        expect(applies({ name: "client" })).toBe(true);
        expect(applies({ name: "ssr" })).toBe(false);
    });

    it("writes the security headers into the client outDir, merged after a _headers copied from publicDir", async () => {
        expect.assertions(3);

        writeFileSync(headersFile(), "/*\n  X-Frame-Options: DENY\n", "utf8");

        const { info } = await build(assetHeadersPlugin(options()), ["vite-plugin-cloudflare"]);
        const text = readFileSync(headersFile(), "utf8");

        expect(text).toContain("  Strict-Transport-Security: max-age=31536000; includeSubDomains");
        expect(text.endsWith("# END lunora-managed\n\n/*\n  X-Frame-Options: DENY\n")).toBe(true);
        expect(info).toHaveBeenCalledWith(expect.stringContaining("kept your own X-Frame-Options"));
    });

    it("writes nothing without @cloudflare/vite-plugin in the build, or on another target", async () => {
        expect.assertions(2);

        await build(assetHeadersPlugin(options()), ["vite:build"]);

        expect(existsSync(headersFile())).toBe(false);

        await build(assetHeadersPlugin(options("celld")), ["vite-plugin-cloudflare"]);

        expect(existsSync(headersFile())).toBe(false);
    });

    it("leaves the security headers out when wrangler vars turn LUNORA_SECURITY_HEADERS off", async () => {
        expect.assertions(2);

        writeFileSync(join(projectRoot, "wrangler.jsonc"), '{ "name": "app", "vars": { "LUNORA_SECURITY_HEADERS": "off" } }\n', "utf8");

        await build(assetHeadersPlugin(options()), ["vite-plugin-cloudflare"]);

        const text = readFileSync(headersFile(), "utf8");

        expect(text).not.toContain("X-Frame-Options");
        // Caching is not a security layer, so the opt-out leaves it on.
        expect(text).toContain("/assets/*\n  Cache-Control: public, max-age=31536000, immutable");
    });

    it("writes the security.headers lunora.config sets, the value codegen also hands the Worker", async () => {
        expect.assertions(2);

        writeFileSync(
            join(projectRoot, "lunora.config.ts"),
            'export default { security: { headers: { crossOriginOpenerPolicy: "same-origin", frameAncestors: ["https://partner.example"] } } };\n',
            "utf8",
        );

        await build(assetHeadersPlugin(options()), ["vite-plugin-cloudflare"]);

        const text = readFileSync(headersFile(), "utf8");

        expect(text).toContain("  Cross-Origin-Opener-Policy: same-origin\n");
        expect(text).toContain("frame-ancestors 'self' https://partner.example");
    });

    it("caches Vite's hashed assets directory for good", async () => {
        expect.assertions(1);

        await build(assetHeadersPlugin(options()), ["vite-plugin-cloudflare"], { assetsDir: "static" });

        expect(readFileSync(headersFile(), "utf8")).toContain("/static/*\n  Cache-Control: public, max-age=31536000, immutable\n");
    });

    it.each([
        ["an output name has no [hash]", { rolldownOptions: { output: { assetFileNames: "assets/[name][extname]" } } }],
        [
            "Vite 6/7's rollupOptions names an output without [hash]",
            { rolldownOptions: undefined, rollupOptions: { output: { entryFileNames: "assets/[name].js" } } },
        ],
        ["an output name is a function", { rolldownOptions: { output: [{ chunkFileNames: () => "assets/chunk.js" }] } }],
        ["the assets sit at the root", { assetsDir: "" }],
    ])("writes no immutable rule when %s", async (_reason, buildConfig: Record<string, unknown>) => {
        expect.assertions(2);

        await build(assetHeadersPlugin(options()), ["vite-plugin-cloudflare"], buildConfig);

        const text = readFileSync(headersFile(), "utf8");

        expect(text).not.toContain("Cache-Control");
        // The security headers still go out.
        expect(text).toContain("X-Content-Type-Options: nosniff");
    });

    it("caches the assets directory when every file the bundle wrote there has a hashed name, source maps included", async () => {
        expect.assertions(1);

        await build(
            assetHeadersPlugin(options()),
            ["vite-plugin-cloudflare"],
            {},
            {
                "assets/index-Ab12_d-Z.js": {},
                "assets/index-Ab12_d-Z.js.map": {},
                "assets/logo-0aB1cD2e.svg": {},
                "index.html": {},
                "sw.js": {},
            },
        );

        expect(readFileSync(headersFile(), "utf8")).toContain("/assets/*\n  Cache-Control: public, max-age=31536000, immutable");
    });

    it("writes no immutable rule when a plugin emitted a fixed file name into the assets directory", async () => {
        expect.assertions(1);

        await build(assetHeadersPlugin(options()), ["vite-plugin-cloudflare"], {}, { "assets/index-Ab12Cd34.js": {}, "assets/worker.js": {} });

        expect(readFileSync(headersFile(), "utf8")).not.toContain("Cache-Control");
    });

    it("reads the wrangler config @cloudflare/vite-plugin was pointed at, not the project's own", async () => {
        expect.assertions(1);

        const custom = join(projectRoot, "wrangler.spa.jsonc");

        writeFileSync(custom, '{ "name": "app", "assets": { "directory": "./dist/client", "not_found_handling": "single-page-application" } }\n', "utf8");

        await build(assetHeadersPlugin(options(), custom), ["vite-plugin-cloudflare"]);

        expect(readFileSync(headersFile(), "utf8")).not.toContain("Cache-Control");
    });

    it("writes no immutable rule when a publicDir subfolder of the same name copies unhashed files into it", async () => {
        expect.assertions(1);

        mkdirSync(join(projectRoot, "public", "assets"), { recursive: true });

        await build(assetHeadersPlugin(options()), ["vite-plugin-cloudflare"]);

        expect(readFileSync(headersFile(), "utf8")).not.toContain("Cache-Control");
    });

    it.each([["single-page-application"], ["404-page"]])(
        "writes no immutable rule under not_found_handling %s, whose fallback page would be cached for a year",
        async (mode) => {
            expect.assertions(1);

            writeFileSync(
                join(projectRoot, "wrangler.jsonc"),
                `{ "name": "app", "assets": { "directory": "./dist/client", "not_found_handling": "${mode}" } }\n`,
                "utf8",
            );

            await build(assetHeadersPlugin(options()), ["vite-plugin-cloudflare"]);

            expect(readFileSync(headersFile(), "utf8")).not.toContain("Cache-Control");
        },
    );

    it("reads not_found_handling from the CLOUDFLARE_ENV block, which overrides the top level", async () => {
        expect.assertions(1);

        writeFileSync(
            join(projectRoot, "wrangler.jsonc"),
            '{ "name": "app", "assets": { "directory": "./dist/client", "not_found_handling": "single-page-application" }, "env": { "api": { "assets": { "directory": "./dist/client", "not_found_handling": "none" } } } }\n',
            "utf8",
        );
        vi.stubEnv("CLOUDFLARE_ENV", "api");

        try {
            await build(assetHeadersPlugin(options()), ["vite-plugin-cloudflare"]);
        } finally {
            vi.unstubAllEnvs();
        }

        expect(readFileSync(headersFile(), "utf8")).toContain("Cache-Control: public, max-age=31536000, immutable");
    });
});
