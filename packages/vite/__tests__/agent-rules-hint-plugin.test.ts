import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AGENT_RULES_HINT_ENV } from "@lunora/config";
import type { ViteDevServer } from "vite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import agentRulesHintPlugin from "../src/agent-rules-hint-plugin";
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
        target: "cloudflare",
        studio: false,
        validateWrangler: false,
    };
};

/** A dev-server stub whose `config.logger.warn` is a spy; only the shape the plugin reads. */
const makeStubServer = () => {
    const warn = vi.fn<(message: string) => void>();

    return { server: { config: { logger: { warn } } } as unknown as ViteDevServer, warn };
};

/**
 * Run `configureServer` and invoke its returned post-startup hook (the plugin
 * defers the notice to the returned closure so it prints after Vite's banner).
 */
const runConfigureServer = (plugin: import("vite").Plugin, server: ViteDevServer): void => {
    const hook = plugin.configureServer;
    const fn = typeof hook === "function" ? hook : hook?.handler;
    const post = (fn as (server: ViteDevServer) => undefined | (() => void)).call(plugin, server);

    post?.();
};

describe("agentRulesHintPlugin", () => {
    let workdir: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-vite-rules-"));
        // The hint is gated by a once-per-process-tree env var; clear it so each
        // test exercises the first-claim path deterministically. `stubEnv` is
        // restored in afterEach via `unstubAllEnvs`.
        vi.stubEnv(AGENT_RULES_HINT_ENV, "");
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
        vi.unstubAllEnvs();
    });

    it("is a serve-only plugin with the expected name", () => {
        expect.assertions(2);

        const plugin = agentRulesHintPlugin(makeOptions(workdir));

        expect(plugin.name).toBe("lunora:agent-rules-hint");
        expect(plugin.apply).toBe("serve");
    });

    it("warns once when the agent rules are not installed", () => {
        expect.assertions(2);

        const plugin = agentRulesHintPlugin(makeOptions(workdir));
        const { server, warn } = makeStubServer();

        runConfigureServer(plugin, server);

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toContain("lunora rules install");
    });

    it("stays silent when the rules are already installed", () => {
        expect.assertions(1);

        // `detectAgentRules` keys on the router skill's SKILL.md.
        mkdirSync(join(workdir, ".agents", "skills", "lunora"), { recursive: true });
        writeFileSync(join(workdir, ".agents", "skills", "lunora", "SKILL.md"), "# lunora\n", "utf8");

        const plugin = agentRulesHintPlugin(makeOptions(workdir));
        const { server, warn } = makeStubServer();

        runConfigureServer(plugin, server);

        expect(warn).not.toHaveBeenCalled();
    });

    it("warns at most once across two dev-server starts (process-tree guard)", () => {
        expect.assertions(1);

        const plugin = agentRulesHintPlugin(makeOptions(workdir));
        const first = makeStubServer();
        const second = makeStubServer();

        runConfigureServer(plugin, first.server);
        runConfigureServer(plugin, second.server);

        // The second start reuses the same process env flag, so it stays quiet.
        expect(first.warn.mock.calls.length + second.warn.mock.calls.length).toBe(1);
    });
});
