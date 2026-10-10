import type { Plugin } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";

import localAiBinding from "../src/local-ai-binding";

interface WorkerConfig {
    ai?: { binding?: string } | null;
    name?: string;
}

type Customizer = (config: WorkerConfig) => Partial<WorkerConfig> | undefined;

/** Run the plugin's `config` hook the way Vite does for `vite dev` or `vite build`. */
const runConfigHook = (plugin: Plugin, command: "build" | "serve"): void => {
    const hook = plugin.config;
    const run = typeof hook === "function" ? hook : hook?.handler;

    // eslint-disable-next-line @typescript-eslint/no-floating-promises -- synchronous hook in a unit test
    run?.call({} as never, {} as never, { command, mode: "development" } as never);
};

/** What the Cloudflare plugin does with `config`: call it, then merge a returned object over the config. */
const resolveWorker = (options: { config?: unknown }, config: WorkerConfig): WorkerConfig => {
    const result = (options.config as Customizer)(config);

    return { ...config, ...result };
};

describe("localAiBinding", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("drops the ai binding from a dev worker when Cloudflare is logged out, and warns about it", () => {
        expect.assertions(3);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const options = {};
        const plugin = localAiBinding(options, { hasCredentials: () => false });

        runConfigHook(plugin, "serve");

        const worker = resolveWorker(options, { ai: { binding: "AI" }, name: "app" });
        const warnings = warn.mock.calls.map((call) => String(call[0]));

        expect(worker).toStrictEqual({ name: "app" });
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("wrangler login");
    });

    it("keeps the binding when Cloudflare is logged in", () => {
        expect.assertions(1);

        const options = {};
        const plugin = localAiBinding(options, { hasCredentials: () => true });

        runConfigHook(plugin, "serve");

        expect(resolveWorker(options, { ai: { binding: "AI" } })).toStrictEqual({ ai: { binding: "AI" } });
    });

    it("never touches a build, whose output is the deploy config", () => {
        expect.assertions(2);

        let probed = false;
        const options = {};
        const plugin = localAiBinding(options, {
            hasCredentials: () => {
                probed = true;

                return false;
            },
        });

        runConfigHook(plugin, "build");

        expect(resolveWorker(options, { ai: { binding: "AI" } })).toStrictEqual({ ai: { binding: "AI" } });
        expect(probed).toBe(false);
    });

    it("still runs the user's customizer and drops an ai binding it returns", () => {
        expect.assertions(2);

        vi.spyOn(console, "warn").mockImplementation(() => {});

        let called = false;
        const options: { config?: Customizer } = {
            config: () => {
                called = true;

                return { ai: { binding: "MY_AI" }, name: "renamed" };
            },
        };
        const plugin = localAiBinding(options, { hasCredentials: () => false });

        runConfigHook(plugin, "serve");

        expect(resolveWorker(options, { name: "app" })).toStrictEqual({ name: "renamed" });
        expect(called).toBe(true);
    });

    it("never probes credentials for a worker without an ai binding", () => {
        expect.assertions(1);

        let probed = false;
        const options = {};
        const plugin = localAiBinding(options, {
            hasCredentials: () => {
                probed = true;

                return false;
            },
        });

        runConfigHook(plugin, "serve");
        resolveWorker(options, { name: "app" });

        expect(probed).toBe(false);
    });

    it("wraps nothing with experimental.newConfig, which rejects a config customizer", () => {
        expect.assertions(2);

        const options = { experimental: { newConfig: {} } } as { config?: unknown; experimental: { newConfig: object } };
        const plugin = localAiBinding(options, { hasCredentials: () => false });

        runConfigHook(plugin, "serve");

        expect(options.config).toBeUndefined();
        expect(options.experimental.newConfig).toStrictEqual({});
    });

    it("still wraps the config when experimental.newConfig is false, the legacy path", () => {
        expect.assertions(1);

        const options: { config?: unknown; experimental: { newConfig: boolean } } = { experimental: { newConfig: false } };
        const plugin = localAiBinding(options, { hasCredentials: () => false });

        runConfigHook(plugin, "serve");

        expect(typeof options.config).toBe("function");
    });

    it("does not edit a plain-object config the user passed in", () => {
        expect.assertions(2);

        vi.spyOn(console, "warn").mockImplementation(() => {});

        const userConfig = { ai: { binding: "MY_AI" }, name: "renamed" };
        const options: { config?: unknown } = { config: userConfig };
        const plugin = localAiBinding(options, { hasCredentials: () => false });

        runConfigHook(plugin, "serve");

        const result = (options.config as Customizer)({ ai: { binding: "MY_AI" }, name: "app" });

        expect(result).toStrictEqual({ name: "renamed" });
        expect(userConfig).toStrictEqual({ ai: { binding: "MY_AI" }, name: "renamed" });
    });

    it("drops the ai binding from an auxiliary worker too, which has its own customizer", () => {
        expect.assertions(3);

        vi.spyOn(console, "warn").mockImplementation(() => {});

        const options: { auxiliaryWorkers?: { config?: unknown; configPath: string }[] } = { auxiliaryWorkers: [{ configPath: "svc/wrangler.jsonc" }] };
        const plugin = localAiBinding(options, { hasCredentials: () => false });

        runConfigHook(plugin, "serve");

        const worker = options.auxiliaryWorkers![0]!;
        const base: WorkerConfig = { ai: { binding: "AI" }, name: "svc" };

        // No customizer of its own, so nothing is returned, but the base loses `ai`.
        expect((worker.config as Customizer)(base)).toBeUndefined();
        expect(base).toStrictEqual({ name: "svc" });
        expect(worker.configPath).toBe("svc/wrangler.jsonc");
    });

    it("wraps an auxiliary worker once, however many times the config hook runs", () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const options: { auxiliaryWorkers?: { config?: unknown; configPath: string }[] } = { auxiliaryWorkers: [{ configPath: "svc/wrangler.jsonc" }] };
        const plugin = localAiBinding(options, { hasCredentials: () => false });

        runConfigHook(plugin, "serve");
        runConfigHook(plugin, "serve");

        (options.auxiliaryWorkers![0]!.config as Customizer)({ ai: { binding: "AI" } });

        expect(warn).toHaveBeenCalledTimes(1);
        expect(options.auxiliaryWorkers).toHaveLength(1);
    });
});
