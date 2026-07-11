import type { Plugin } from "vite";
import { describe, expect, it } from "vitest";

import { planViteRemoteBindings, remoteBindingsCleanupPlugin, remoteBindingsConfigPlugin, withRemoteBindings } from "../src/remote-bindings-plugin";

/** Call a plugin's `config` hook regardless of whether it is a fn or `{ handler }`. */
const callConfig = (plugin: Plugin, command: "build" | "serve"): void => {
    const hook = plugin.config;
    const run = typeof hook === "function" ? hook : hook?.handler;

    // eslint-disable-next-line @typescript-eslint/no-floating-promises -- fire-and-forget config hook in a unit test
    run?.call({} as never, {} as never, { command, mode: "development" } as never);
};

/** A materialize stub: enabled with a temp configPath + a disposer we can observe. */
const materializeWith = (configPath: string | undefined, onCleanup?: () => void) => () => {
    return {
        cleanup: onCleanup ?? ((): void => {}),
        configPath,
        enabled: true,
        remoteBindings: [],
    };
};

describe("planViteRemoteBindings", () => {
    it("is disabled when neither LUNORA_REMOTE nor lunora.json opts in", () => {
        expect.assertions(2);

        const plan = planViteRemoteBindings({
            materialize: materializeWith("/work/should-not-be-used.jsonc"),
            projectRoot: "/proj",
            readPreference: () => undefined,
            remoteEnv: undefined,
        });

        expect(plan.enabled).toBe(false);
        expect(plan.configPath).toBeUndefined();
    });

    it("enables + materializes a configPath when LUNORA_REMOTE=1", () => {
        expect.assertions(2);

        const plan = planViteRemoteBindings({
            materialize: materializeWith("/work/wrangler.remote.jsonc"),
            projectRoot: "/proj",
            readPreference: () => undefined,
            remoteEnv: "1",
        });

        expect(plan.enabled).toBe(true);
        expect(plan.configPath).toBe("/work/wrangler.remote.jsonc");
    });

    it("enables via the lunora.json `remote` preference when the env is unset", () => {
        expect.assertions(2);

        const plan = planViteRemoteBindings({
            materialize: materializeWith("/work/wrangler.remote.jsonc"),
            projectRoot: "/proj",
            readPreference: () => true,
            remoteEnv: undefined,
        });

        expect(plan.enabled).toBe(true);
        expect(plan.configPath).toBe("/work/wrangler.remote.jsonc");
    });

    it("lets LUNORA_REMOTE win over a lunora.json `remote: false`", () => {
        expect.assertions(1);

        const plan = planViteRemoteBindings({
            materialize: materializeWith("/work/wrangler.remote.jsonc"),
            projectRoot: "/proj",
            readPreference: () => false,
            remoteEnv: "true",
        });

        expect(plan.enabled).toBe(true);
    });

    it("stays enabled-but-configless when there is nothing to materialize", () => {
        expect.assertions(2);

        const plan = planViteRemoteBindings({
            materialize: () => {
                return { cleanup: () => {}, enabled: true, reason: "wrangler.jsonc not found", remoteBindings: [] };
            },
            projectRoot: "/proj",
            readPreference: () => true,
            remoteEnv: undefined,
        });

        expect(plan.enabled).toBe(true);
        expect(plan.configPath).toBeUndefined();
    });
});

describe("withRemoteBindings", () => {
    it("sets configPath on the cloudflare options when remote is on", () => {
        expect.assertions(1);

        const options = withRemoteBindings(
            {},
            {
                cleanup: () => {},
                configPath: "/work/wrangler.remote.jsonc",
                enabled: true,
            },
        );

        expect((options as { configPath?: string }).configPath).toBe("/work/wrangler.remote.jsonc");
    });

    it("is a no-op when remote mode is disabled", () => {
        expect.assertions(1);

        const options = withRemoteBindings({}, { cleanup: () => {}, enabled: false });

        expect((options as { configPath?: string }).configPath).toBeUndefined();
    });

    it("never overrides a user-supplied configPath", () => {
        expect.assertions(1);

        const options = withRemoteBindings(
            { configPath: "/user/wrangler.jsonc" },
            {
                cleanup: () => {},
                configPath: "/work/wrangler.remote.jsonc",
                enabled: true,
            },
        );

        expect((options as { configPath?: string }).configPath).toBe("/user/wrangler.jsonc");
    });
});

describe("remoteBindingsConfigPlugin", () => {
    it("injects configPath into the shared options object during serve (deferred to hook time)", () => {
        expect.assertions(2);

        // Regression: the old wiring evaluated the serve check eagerly at factory
        // time — where Vite's resolved `command` is still undefined — so `configPath`
        // was always stripped and remote bindings never activated on `vite dev`.
        const options: { configPath?: string } = {};
        const plugin = remoteBindingsConfigPlugin(options, { cleanup: () => {}, configPath: "/work/wrangler.remote.jsonc", enabled: true });

        // Before the `config` hook runs, nothing is injected.
        expect(options.configPath).toBeUndefined();

        callConfig(plugin, "serve");

        // The hook mutates the SAME object handed to `cloudflare()`.
        expect(options.configPath).toBe("/work/wrangler.remote.jsonc");
    });

    it("never injects configPath during a production build", () => {
        expect.assertions(1);

        const options: { configPath?: string } = {};
        const plugin = remoteBindingsConfigPlugin(options, { cleanup: () => {}, configPath: "/work/wrangler.remote.jsonc", enabled: true });

        callConfig(plugin, "build");

        expect(options.configPath).toBeUndefined();
    });

    it("never overrides a user-supplied configPath", () => {
        expect.assertions(1);

        const options: { configPath?: string } = { configPath: "/user/wrangler.jsonc" };
        const plugin = remoteBindingsConfigPlugin(options, { cleanup: () => {}, configPath: "/work/wrangler.remote.jsonc", enabled: true });

        callConfig(plugin, "serve");

        expect(options.configPath).toBe("/user/wrangler.jsonc");
    });

    it('runs before the cloudflare plugin via enforce: "pre"', () => {
        expect.assertions(1);

        const plugin = remoteBindingsConfigPlugin({}, { cleanup: () => {}, enabled: false });

        expect(plugin.enforce).toBe("pre");
    });
});

describe("remoteBindingsCleanupPlugin", () => {
    it("runs the disposer on buildEnd and closeBundle (idempotent)", () => {
        expect.assertions(2);

        let calls = 0;
        const plugin = remoteBindingsCleanupPlugin(() => {
            calls += 1;
        });

        (plugin.buildEnd as () => void).call(plugin);

        expect(calls).toBe(1);

        (plugin.closeBundle as () => void).call(plugin);

        // The real disposer is idempotent; the plugin fires on both hooks.
        expect(calls).toBe(2);
    });
});
