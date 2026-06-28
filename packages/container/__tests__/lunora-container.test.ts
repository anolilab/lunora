/**
 * Node-side smoke test for the workerd-only `LunoraContainer` base class. The
 * `cloudflare:workers` import inside `@cloudflare/containers` is aliased to a
 * stub (see `vitest.config.ts`), and the Durable Object context is faked with
 * the surface the upstream `Container` constructor actually touches.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { LunoraContainer } from "../src/do/index";
import { defineContainer } from "../src/index";

/** Minimal fake of the pieces `@cloudflare/containers` reads off the DO ctx. */
const fakeDurableObjectContext = (): Record<string, unknown> => {
    return {
        // The base ctor schedules alarms inside an un-awaited
        // `blockConcurrencyWhile(...)` critical section that touches the full
        // workerd storage surface. We're unit-testing field application (which
        // happens synchronously, outside this block), so we accept the callback
        // but don't run it — otherwise the alarm machinery becomes an unhandled
        // rejection that fails the run.
        blockConcurrencyWhile: async () => {},
        container: { running: false },
        storage: {
            deleteAlarm: async () => {},
            get: async () => undefined,
            getAlarm: async () => null,
            kv: {
                delete: () => {},
                get: () => undefined,
                put: () => {},
            },
            put: async () => {},
            setAlarm: async () => {},
            sql: {
                // The base class iterates exec() results, so return an (empty)
                // iterable carrying the cursor helpers it may reach for.
                exec: () => Object.assign([], { one: () => undefined, raw: () => [], toArray: () => [] }),
            },
        },
    };
};

describe(LunoraContainer, () => {
    it("applies the definition onto the Container base", () => {
        expect.assertions(4);

        const definition = defineContainer({
            defaultPort: 8080,
            enableInternet: false,
            env: { LOG_LEVEL: "info" },
            image: "./containers/transcoder",
            secrets: ["API_KEY"],
            sleepAfter: "5m",
        });

        const instance = new LunoraContainer(fakeDurableObjectContext() as never, { API_KEY: "s3cret" }, definition, "transcoder") as unknown as {
            defaultPort?: number;
            enableInternet: boolean;
            envVars: Record<string, string>;
            sleepAfter: number | string;
        };

        expect(instance.defaultPort).toBe(8080);
        expect(instance.sleepAfter).toBe("5m");
        expect(instance.enableInternet).toBe(false);
        expect(instance.envVars).toStrictEqual({ API_KEY: "s3cret", LOG_LEVEL: "info" });
    });

    it("applies the multi-port, egress-firewall, and labels fields onto the Container base", () => {
        expect.assertions(7);

        const definition = defineContainer({
            allowedHosts: ["*.stripe.com"],
            deniedHosts: ["*.evil.com"],
            entrypoint: ["node", "server.js"],
            image: "./app",
            interceptHttps: true,
            labels: { env: "prod", tenant: "acme" },
            pingEndpoint: "/healthz",
            requiredPorts: [8080, 9090],
        });

        const instance = new LunoraContainer(fakeDurableObjectContext() as never, {}, definition, "transcoder") as unknown as {
            allowedHosts: string[];
            deniedHosts: string[];
            entrypoint: string[];
            interceptHttps: boolean;
            labels: Record<string, string>;
            pingEndpoint: string;
            requiredPorts: number[];
        };

        expect(instance.requiredPorts).toStrictEqual([8080, 9090]);
        expect(instance.entrypoint).toStrictEqual(["node", "server.js"]);
        expect(instance.interceptHttps).toBe(true);
        expect(instance.allowedHosts).toStrictEqual(["*.stripe.com"]);
        expect(instance.deniedHosts).toStrictEqual(["*.evil.com"]);
        expect(instance.pingEndpoint).toBe("/healthz");
        expect(instance.labels).toStrictEqual({ env: "prod", tenant: "acme" });
    });

    it("fails fast when a declared secret is missing from the worker env", () => {
        expect.assertions(1);

        const definition = defineContainer({ image: "./app", secrets: ["API_KEY"] });

        expect(() => new LunoraContainer(fakeDurableObjectContext() as never, {}, definition, "transcoder")).toThrow('declared secret "API_KEY" is not set');
    });
});

describe("lunoraContainer lifecycle logging", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    const build = (): InstanceType<typeof LunoraContainer> => {
        const definition = defineContainer({ image: "./app" });

        return new LunoraContainer(fakeDurableObjectContext() as never, {}, definition, "transcoder");
    };

    it("emits a lunora container event on start", async () => {
        expect.assertions(1);

        const spy = vi.spyOn(console, "log").mockImplementation(() => {});

        await build().onStart();

        expect(JSON.parse((spy.mock.calls.at(-1)![0] as string) ?? "{}")).toMatchObject({
            container: "transcoder",
            event: "start",
            source: "lunora",
            type: "container",
        });
    });

    it("emits on stop with the exit reason", async () => {
        expect.assertions(1);

        const spy = vi.spyOn(console, "log").mockImplementation(() => {});

        await build().onStop({ exitCode: 137, reason: "runtime_signal" });

        expect(JSON.parse((spy.mock.calls.at(-1)![0] as string) ?? "{}")).toMatchObject({ event: "stop", message: "runtime_signal (exit 137)" });
    });

    it("emits a sleep event when activity expires", async () => {
        expect.assertions(1);

        const spy = vi.spyOn(console, "log").mockImplementation(() => {});

        await build().onActivityExpired();

        // Our envelope is logged before `super.onActivityExpired()`'s own plain
        // line, so it's the first call.
        expect(JSON.parse((spy.mock.calls[0]![0] as string) ?? "{}")).toMatchObject({
            container: "transcoder",
            event: "sleep",
            level: "info",
            source: "lunora",
            type: "container",
        });
    });

    it("emits an error event and re-throws (the base onError contract)", () => {
        expect.assertions(2);

        const spy = vi.spyOn(console, "error").mockImplementation(() => {});

        expect(() => build().onError(new Error("crashed"))).toThrow("crashed");
        expect(JSON.parse((spy.mock.calls[0]![0] as string) ?? "{}")).toMatchObject({ event: "error", level: "error", message: "crashed" });
    });

    it("does not break onStart when the ShardDO push throws (best-effort)", async () => {
        expect.assertions(2);

        const spy = vi.spyOn(console, "log").mockImplementation(() => {});

        // A SHARD namespace whose stub throws synchronously on `.fetch` — the
        // best-effort push must swallow it, so `onStart` still resolves and the
        // terminal still gets the event.
        const throwingStub = {
            fetch: () => {
                throw new Error("shard unreachable");
            },
        };
        const throwingShard = {
            get: () => throwingStub,
            idFromName: (name: string) => name,
        };

        const definition = defineContainer({ image: "./app" });
        const instance = new LunoraContainer(
            fakeDurableObjectContext() as never,
            { LUNORA_ADMIN_TOKEN: "s3cret", SHARD: throwingShard },
            definition,
            "transcoder",
        );

        await expect(instance.onStart()).resolves.toBeUndefined();
        expect(JSON.parse((spy.mock.calls.at(-1)![0] as string) ?? "{}")).toMatchObject({ event: "start", type: "container" });
    });
});
