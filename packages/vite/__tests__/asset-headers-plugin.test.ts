import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import assetHeadersPlugin from "../src/asset-headers-plugin";
import type { ResolvedLunoraPluginOptions } from "../src/types";

let projectRoot: string;

const options = (target = "cloudflare"): ResolvedLunoraPluginOptions => ({ projectRoot, target }) as ResolvedLunoraPluginOptions;

/** Drive the plugin through the two hooks a client build calls, with the given plugin names in the resolved config. */
const build = (plugin: ReturnType<typeof assetHeadersPlugin>, pluginNames: string[]): { info: ReturnType<typeof vi.fn<(message: string) => void>> } => {
    const info = vi.fn<(message: string) => void>();
    const logger = { info, warn: vi.fn<(message: string) => void>() };

    (plugin.configResolved as (config: unknown) => void)({
        plugins: pluginNames.map((name) => {
            return { name };
        }),
    });
    (plugin.writeBundle as (this: unknown) => void).call({ environment: { config: { build: { outDir: "dist/client" }, logger, root: projectRoot } } });

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

    it("writes the security headers into the client outDir, merged after a _headers copied from publicDir", () => {
        expect.assertions(3);

        writeFileSync(headersFile(), "/*\n  X-Frame-Options: DENY\n", "utf8");

        const { info } = build(assetHeadersPlugin(options()), ["vite-plugin-cloudflare"]);
        const text = readFileSync(headersFile(), "utf8");

        expect(text).toContain("  Strict-Transport-Security: max-age=31536000; includeSubDomains");
        expect(text.endsWith("# END lunora-managed\n\n/*\n  X-Frame-Options: DENY\n")).toBe(true);
        expect(info).toHaveBeenCalledWith(expect.stringContaining("kept your own X-Frame-Options"));
    });

    it("writes nothing without @cloudflare/vite-plugin in the build, or on another target", () => {
        expect.assertions(2);

        build(assetHeadersPlugin(options()), ["vite:build"]);

        expect(existsSync(headersFile())).toBe(false);

        build(assetHeadersPlugin(options("celld")), ["vite-plugin-cloudflare"]);

        expect(existsSync(headersFile())).toBe(false);
    });

    it("leaves the security headers out when wrangler vars turn LUNORA_SECURITY_HEADERS off", () => {
        expect.assertions(1);

        writeFileSync(join(projectRoot, "wrangler.jsonc"), '{ "name": "app", "vars": { "LUNORA_SECURITY_HEADERS": "off" } }\n', "utf8");

        build(assetHeadersPlugin(options()), ["vite-plugin-cloudflare"]);

        expect(existsSync(headersFile())).toBe(false);
    });
});
