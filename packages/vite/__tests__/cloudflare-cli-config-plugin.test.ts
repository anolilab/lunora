import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CLOUDFLARE_CLI_CONFIG_WARNING_ENV } from "@lunora/config/cloudflare";
import type { Plugin, ResolvedConfig } from "vite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import cloudflareCliConfigPlugin from "../src/cloudflare-cli-config-plugin";
import { lunora } from "../src/index";
import type { ResolvedLunoraPluginOptions } from "../src/types";

const makeOptions = (projectRoot: string): ResolvedLunoraPluginOptions => {
    return {
        allowUnauthenticatedShardAccess: false,
        apiSpec: "openapi",
        cloudflare: false,
        generatedDir: "lunora/_generated",
        overlay: false,
        projectRoot,
        schemaDir: "lunora",
        shard: {},
        studio: false,
        target: "cloudflare",
        validateWrangler: false,
    };
};

/** Run `configResolved` with a config whose `logger.warn` is the given spy — the only shape the plugin reads. */
const runConfigResolved = (plugin: Plugin, warn: (message: string) => void): void => {
    const hook = plugin.configResolved;
    const fn = typeof hook === "function" ? hook : hook?.handler;

    (fn as (config: ResolvedConfig) => void).call(plugin, { logger: { warn } } as unknown as ResolvedConfig);
};

describe(cloudflareCliConfigPlugin, () => {
    let workdir: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-vite-cf-config-"));
        writeFileSync(join(workdir, "wrangler.jsonc"), "{}\n", "utf8");
        // Clear the once-per-process-tree guard; restored by `unstubAllEnvs`.
        vi.stubEnv(CLOUDFLARE_CLI_CONFIG_WARNING_ENV, "");
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
        vi.unstubAllEnvs();
    });

    it("warns once per process tree, not on every config reload", () => {
        expect.assertions(3);

        writeFileSync(join(workdir, "cloudflare.config.ts"), "export default {};\n", "utf8");

        const warn = vi.fn<(message: string) => void>();

        // A Vite restart re-resolves the config and runs the hook again.
        runConfigResolved(cloudflareCliConfigPlugin(makeOptions(workdir)), warn);
        runConfigResolved(cloudflareCliConfigPlugin(makeOptions(workdir)), warn);

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toContain("cloudflare.config.ts found next to wrangler.jsonc");
        expect(warn.mock.calls[0]?.[0]).toContain("https://github.com/anolilab/lunora/issues/964");
    });

    it("stays quiet when `lunora dev` already claimed the warning before spawning Vite", () => {
        expect.assertions(1);

        vi.stubEnv(CLOUDFLARE_CLI_CONFIG_WARNING_ENV, "1");
        writeFileSync(join(workdir, "cloudflare.config.ts"), "export default {};\n", "utf8");

        const warn = vi.fn<(message: string) => void>();

        runConfigResolved(cloudflareCliConfigPlugin(makeOptions(workdir)), warn);

        expect(warn).not.toHaveBeenCalled();
    });

    it("still registers and warns under LUNORA_CODEGEN=0 with every check switched off", () => {
        expect.assertions(2);

        vi.stubEnv("LUNORA_CODEGEN", "0");
        writeFileSync(join(workdir, "cloudflare.config.ts"), "export default {};\n", "utf8");

        const plugin = lunora({ cloudflare: false, overlay: false, projectRoot: workdir, studio: false, validateWrangler: false }).find(
            (candidate) => candidate.name === "lunora:cf-config-warning",
        );
        const warn = vi.fn<(message: string) => void>();

        runConfigResolved(plugin as Plugin, warn);

        expect(plugin).toBeDefined();
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it("runs on build as well as serve, and is registered even with validateWrangler off", () => {
        expect.assertions(2);

        const plugin = lunora({ cloudflare: false, projectRoot: workdir, studio: false, validateWrangler: false }).find(
            (candidate) => candidate.name === "lunora:cf-config-warning",
        );

        expect(plugin).toBeDefined();
        expect(plugin?.apply).toBeUndefined();
    });
});
