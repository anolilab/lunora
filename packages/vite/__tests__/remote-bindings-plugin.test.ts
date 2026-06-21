import { describe, expect, it } from "vitest";

import { planViteRemoteBindings, remoteBindingsCleanupPlugin, withRemoteBindings } from "../src/remote-bindings-plugin";

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
    it("sets configPath on the cloudflare options during serve when remote is on", () => {
        expect.assertions(1);

        const options = withRemoteBindings({}, () => true, {
            cleanup: () => {},
            configPath: "/work/wrangler.remote.jsonc",
            enabled: true,
        });

        expect((options as { configPath?: string }).configPath).toBe("/work/wrangler.remote.jsonc");
    });

    it("never injects configPath during a production build", () => {
        expect.assertions(1);

        const options = withRemoteBindings({}, () => false, {
            cleanup: () => {},
            configPath: "/work/wrangler.remote.jsonc",
            enabled: true,
        });

        expect((options as { configPath?: string }).configPath).toBeUndefined();
    });

    it("is a no-op when remote mode is disabled", () => {
        expect.assertions(1);

        const options = withRemoteBindings({}, () => true, { cleanup: () => {}, enabled: false });

        expect((options as { configPath?: string }).configPath).toBeUndefined();
    });

    it("never overrides a user-supplied configPath", () => {
        expect.assertions(1);

        const options = withRemoteBindings({ configPath: "/user/wrangler.jsonc" }, () => true, {
            cleanup: () => {},
            configPath: "/work/wrangler.remote.jsonc",
            enabled: true,
        });

        expect((options as { configPath?: string }).configPath).toBe("/user/wrangler.jsonc");
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
