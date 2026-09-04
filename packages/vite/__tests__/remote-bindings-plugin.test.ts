import type { Plugin } from "vite";
import { describe, expect, it } from "vitest";

import type { PlanViteRemoteOptions } from "../src/remote-bindings-plugin";
import { planViteRemoteBindings, remoteBindingsPlugin, withRemoteBindings } from "../src/remote-bindings-plugin";

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

/** Remote-on plan options whose materializer is the injected stub. */
const remoteOnOptions = (materialize: PlanViteRemoteOptions["materialize"]): PlanViteRemoteOptions => {
    return { materialize, projectRoot: "/proj", readPreference: () => undefined, remoteEnv: "1" };
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

describe("remoteBindingsPlugin", () => {
    it("materializes the temp config in the `config` hook, never at factory time", () => {
        expect.assertions(2);

        // Regression: materializing at factory time copied `wrangler.jsonc` BEFORE
        // `wranglerValidatorPlugin`'s `config` hook provisioned the inferred
        // bindings into it, so the dev worker booted against a snapshot missing
        // the binding Lunora had just written.
        let materializations = 0;
        const plugin = remoteBindingsPlugin(
            {},
            remoteOnOptions(() => {
                materializations += 1;

                return { cleanup: (): void => {}, configPath: "/work/wrangler.remote.jsonc", enabled: true, remoteBindings: [] };
            }),
        );

        expect(materializations).toBe(0);

        callConfig(plugin, "serve");

        expect(materializations).toBe(1);
    });

    it("injects configPath into the shared options object during serve (deferred to hook time)", () => {
        expect.assertions(2);

        // Regression: the old wiring evaluated the serve check eagerly at factory
        // time — where Vite's resolved `command` is still undefined — so `configPath`
        // was always stripped and remote bindings never activated on `vite dev`.
        const options: { configPath?: string } = {};
        const plugin = remoteBindingsPlugin(options, remoteOnOptions(materializeWith("/work/wrangler.remote.jsonc")));

        // Before the `config` hook runs, nothing is injected.
        expect(options.configPath).toBeUndefined();

        callConfig(plugin, "serve");

        // The hook mutates the SAME object handed to `cloudflare()`.
        expect(options.configPath).toBe("/work/wrangler.remote.jsonc");
    });

    it("never injects configPath — or materializes — during a production build", () => {
        expect.assertions(2);

        let materializations = 0;
        const options: { configPath?: string } = {};
        const plugin = remoteBindingsPlugin(
            options,
            remoteOnOptions(() => {
                materializations += 1;

                return { cleanup: (): void => {}, configPath: "/work/wrangler.remote.jsonc", enabled: true, remoteBindings: [] };
            }),
        );

        callConfig(plugin, "build");

        expect(options.configPath).toBeUndefined();
        expect(materializations).toBe(0);
    });

    it("never overrides a user-supplied configPath", () => {
        expect.assertions(1);

        const options: { configPath?: string } = { configPath: "/user/wrangler.jsonc" };
        const plugin = remoteBindingsPlugin(options, remoteOnOptions(materializeWith("/work/wrangler.remote.jsonc")));

        callConfig(plugin, "serve");

        expect(options.configPath).toBe("/user/wrangler.jsonc");
    });

    it('runs before the cloudflare plugin via enforce: "pre"', () => {
        expect.assertions(1);

        const plugin = remoteBindingsPlugin({}, { projectRoot: "/proj", readPreference: () => false, remoteEnv: undefined });

        expect(plugin.enforce).toBe("pre");
    });

    it("runs the materialized disposer on buildEnd and closeBundle", () => {
        expect.assertions(3);

        let calls = 0;
        const plugin = remoteBindingsPlugin(
            {},
            remoteOnOptions(
                materializeWith("/work/wrangler.remote.jsonc", () => {
                    calls += 1;
                }),
            ),
        );

        // Nothing is materialized yet, so the disposer is a no-op — it must read
        // the plan the `config` hook produces, not a factory-time capture.
        (plugin.buildEnd as () => void).call(plugin);

        expect(calls).toBe(0);

        callConfig(plugin, "serve");
        (plugin.buildEnd as () => void).call(plugin);

        expect(calls).toBe(1);

        (plugin.closeBundle as () => void).call(plugin);

        // The real disposer is idempotent; the plugin fires on both hooks.
        expect(calls).toBe(2);
    });

    it("re-points configPath at the new temp config when `config` runs twice", () => {
        expect.assertions(2);

        // A second `config` pass unlinks temp A and materializes temp B. The
        // injected path from the first pass is still sitting on the shared
        // options object, and `withRemoteBindings` reads any `configPath` there as
        // the user's explicit choice — so it left the cloudflare plugin pointed at
        // a file that had just been deleted. A materializer answering the same
        // path twice cannot see this; a real one mints a fresh temp file per call.
        const paths = ["/work/wrangler.remote.a.jsonc", "/work/wrangler.remote.b.jsonc"];
        const options: { configPath?: string } = {};
        const plugin = remoteBindingsPlugin(
            options,
            remoteOnOptions(() => {
                return { cleanup: (): void => {}, configPath: paths.shift(), enabled: true, remoteBindings: [] };
            }),
        );

        callConfig(plugin, "serve");

        expect(options.configPath).toBe("/work/wrangler.remote.a.jsonc");

        callConfig(plugin, "serve");

        expect(options.configPath).toBe("/work/wrangler.remote.b.jsonc");
    });

    it("disposes the previous temp config when `config` runs twice", () => {
        expect.assertions(1);

        let calls = 0;
        const plugin = remoteBindingsPlugin(
            {},
            remoteOnOptions(
                materializeWith("/work/wrangler.remote.jsonc", () => {
                    calls += 1;
                }),
            ),
        );

        callConfig(plugin, "serve");
        callConfig(plugin, "serve");

        expect(calls).toBe(1);
    });
});
