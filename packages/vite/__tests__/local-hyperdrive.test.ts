import type { Plugin } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";

import localHyperdrive from "../src/local-hyperdrive";

type Start = NonNullable<Parameters<typeof localHyperdrive>[0]["start"]>;

/** Run the plugin's `config` hook the way Vite does for `vite dev` or `vite build`. */
const runConfigHook = async (plugin: Plugin, command: "build" | "serve", isPreview = false): Promise<void> => {
    const hook = plugin.config;
    const run = typeof hook === "function" ? hook : hook?.handler;

    await run?.call({} as never, {} as never, { command, isPreview, mode: "development" } as never);
};

describe(localHyperdrive, () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("starts the embedded Postgres for a dev server, before the Cloudflare plugin resolves bindings", async () => {
        expect.assertions(2);

        vi.spyOn(console, "info").mockImplementation(() => {});

        const start = vi.fn<Start>(async () => {
            return { bindings: ["HYPERDRIVE"], stop: async () => {} };
        });

        await runConfigHook(localHyperdrive({ projectRoot: "/project/serve", start }), "serve");

        expect(start).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: "/project/serve" }));
        expect(localHyperdrive({ projectRoot: "/x", start }).enforce).toBe("pre");
    });

    it("starts nothing for a production build or a preview, whose output is the deploy config", async () => {
        expect.assertions(1);

        const start = vi.fn<Start>(async () => undefined);
        const plugin = localHyperdrive({ projectRoot: "/project/build", start });

        await runConfigHook(plugin, "build");
        await runConfigHook(plugin, "serve", true);

        expect(start).not.toHaveBeenCalled();
    });

    it("starts once per project even when Vite resolves the config again after a restart", async () => {
        expect.assertions(1);

        vi.spyOn(console, "info").mockImplementation(() => {});

        const start = vi.fn<Start>(async () => {
            return { bindings: ["HYPERDRIVE"], stop: async () => {} };
        });
        const plugin = localHyperdrive({ projectRoot: "/project/restart", start });

        await Promise.all([runConfigHook(plugin, "serve"), runConfigHook(plugin, "serve")]);
        await runConfigHook(plugin, "serve");

        expect(start).toHaveBeenCalledTimes(1);
    });

    it("prints a warning the starter hands it, without failing the dev server", async () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const start = vi.fn<Start>(async ({ onWarning }) => {
            onWarning?.("install PGlite");

            return undefined;
        });

        await expect(runConfigHook(localHyperdrive({ projectRoot: "/project/warn", start }), "serve")).resolves.toBeUndefined();
        expect(warn.mock.calls.flat().join(" ")).toContain("install PGlite");
    });
});
