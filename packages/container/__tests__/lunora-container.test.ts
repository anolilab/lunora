/**
 * Node-side smoke test for the workerd-only `LunoraContainer` base class. The
 * `cloudflare:workers` import inside `@cloudflare/containers` is aliased to a
 * stub (see `vitest.config.ts`), and the Durable Object context is faked with
 * the surface the upstream `Container` constructor actually touches.
 */
import { Container } from "@cloudflare/containers";
import { LunoraError } from "@lunora/errors";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LunoraContainer } from "../src/do/index";
import { defineContainer } from "../src/index";

/** Overrides for the pieces the readiness/hard-timeout paths read off the ctx. */
interface FakeContextOverrides {
    /** The `ctx.container` stub (running flag + optional `getTcpPort`). */
    container?: unknown;
    /** Value `ctx.storage.get` resolves to (the stored hard-timeout generation). */
    storedGeneration?: number;
}

/** Minimal fake of the pieces `@cloudflare/containers` reads off the DO ctx. */
const fakeDurableObjectContext = (overrides: FakeContextOverrides = {}): Record<string, unknown> => {
    return {
        // The base ctor schedules alarms inside an un-awaited
        // `blockConcurrencyWhile(...)` critical section that touches the full
        // workerd storage surface. We're unit-testing field application (which
        // happens synchronously, outside this block), so we accept the callback
        // but don't run it — otherwise the alarm machinery becomes an unhandled
        // rejection that fails the run.
        blockConcurrencyWhile: async () => {},
        container: overrides.container ?? { running: false },
        storage: {
            deleteAlarm: async () => {},
            get: async () => overrides.storedGeneration,
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

/** Cast onto the private Secrets Store resolver + `envVars` the start path reads. */
type SecretsStoreProbe = { envVars: Record<string, string>; resolveSecretsStoreEnv: () => Promise<void> };

describe("lunoraContainer secretsStore resolution", () => {
    it("resolves Secrets Store bindings and merges them into envVars before start", async () => {
        expect.assertions(1);

        const definition = defineContainer({
            env: { LOG_LEVEL: "info" },
            image: "./app",
            secretsStore: { STRIPE_KEY: "STRIPE_SECRET" },
        });
        const env = { STRIPE_SECRET: { get: async () => "sk_live_123" } };

        const instance = new LunoraContainer(fakeDurableObjectContext() as never, env, definition, "transcoder") as unknown as SecretsStoreProbe;

        await instance.resolveSecretsStoreEnv();

        expect(instance.envVars).toStrictEqual({ LOG_LEVEL: "info", STRIPE_KEY: "sk_live_123" });
    });

    it("resolves each binding only once across repeated starts", async () => {
        expect.assertions(2);

        const get = vi.fn<() => Promise<string>>(async () => "sk_live_123");
        const definition = defineContainer({ image: "./app", secretsStore: { STRIPE_KEY: "STRIPE_SECRET" } });

        const instance = new LunoraContainer(
            fakeDurableObjectContext() as never,
            { STRIPE_SECRET: { get } },
            definition,
            "transcoder",
        ) as unknown as SecretsStoreProbe;

        await instance.resolveSecretsStoreEnv();
        await instance.resolveSecretsStoreEnv();

        expect(get).toHaveBeenCalledTimes(1);
        expect(instance.envVars).toStrictEqual({ STRIPE_KEY: "sk_live_123" });
    });

    it("retries resolution after a transient failure instead of caching the rejection forever", async () => {
        expect.assertions(3);

        // First `.get()` rejects (a transient Secrets Store hiccup), the second
        // succeeds. A cached rejected promise would poison every later start; the
        // memo must be cleared on failure so the next resolution retries.
        const get = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error("secrets store unavailable")).mockResolvedValueOnce("sk_live_123");
        const definition = defineContainer({ image: "./app", secretsStore: { STRIPE_KEY: "STRIPE_SECRET" } });

        const instance = new LunoraContainer(
            fakeDurableObjectContext() as never,
            { STRIPE_SECRET: { get } },
            definition,
            "transcoder",
        ) as unknown as SecretsStoreProbe;

        await expect(instance.resolveSecretsStoreEnv()).rejects.toThrow("secrets store unavailable");

        // The second attempt must re-run resolution (not replay the rejection).
        await instance.resolveSecretsStoreEnv();

        expect(get).toHaveBeenCalledTimes(2);
        expect(instance.envVars).toStrictEqual({ STRIPE_KEY: "sk_live_123" });
    });

    it("fails the start when the Secrets Store binding is missing from the worker env", async () => {
        expect.assertions(1);

        const definition = defineContainer({ image: "./app", secretsStore: { STRIPE_KEY: "STRIPE_SECRET" } });
        const instance = new LunoraContainer(fakeDurableObjectContext() as never, {}, definition, "transcoder") as unknown as SecretsStoreProbe;

        await expect(instance.resolveSecretsStoreEnv()).rejects.toThrow('binding "STRIPE_SECRET", which is not a Secrets Store binding');
    });

    it("fails the start when a Secrets Store value does not resolve to a string", async () => {
        expect.assertions(1);

        const definition = defineContainer({ image: "./app", secretsStore: { STRIPE_KEY: "STRIPE_SECRET" } });
        const env = { STRIPE_SECRET: { get: async () => undefined } };
        const instance = new LunoraContainer(fakeDurableObjectContext() as never, env, definition, "transcoder") as unknown as SecretsStoreProbe;

        await expect(instance.resolveSecretsStoreEnv()).rejects.toThrow("did not resolve to a string value");
    });

    it("is a no-op when no secretsStore is configured", async () => {
        expect.assertions(1);

        const definition = defineContainer({ env: { LOG_LEVEL: "info" }, image: "./app" });
        const instance = new LunoraContainer(fakeDurableObjectContext() as never, {}, definition, "transcoder") as unknown as SecretsStoreProbe;

        await instance.resolveSecretsStoreEnv();

        expect(instance.envVars).toStrictEqual({ LOG_LEVEL: "info" });
    });

    it("skips Secrets Store resolution when start() supplies its own envVars", async () => {
        expect.assertions(2);

        // The binding is missing from the worker env, so resolution *would* throw
        // — proving it's skipped when the caller overrides `envVars` (which
        // replace the env set wholesale, discarding any resolved secret anyway).
        const definition = defineContainer({ image: "./app", secretsStore: { STRIPE_KEY: "STRIPE_SECRET" } });
        const instance = new LunoraContainer(fakeDurableObjectContext() as never, {}, definition, "transcoder");

        const probe = instance as unknown as SecretsStoreProbe & { start: (options?: { envVars?: Record<string, string> }) => Promise<void> };
        const resolveSpy = vi.spyOn(probe, "resolveSecretsStoreEnv");
        // Stub the upstream `Container.start` (two prototypes up) — it would try
        // to boot a real container otherwise.
        const baseStart = vi
            .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(instance)) as { start: () => Promise<void> }, "start")
            .mockResolvedValue(undefined);

        await probe.start({ envVars: { STRIPE_KEY: "override" } });

        expect(resolveSpy).not.toHaveBeenCalled();
        expect(baseStart).toHaveBeenCalledTimes(1);

        baseStart.mockRestore();
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

    /**
     * Stub the base's `startAndWaitForPorts` down to the one part that matters
     * here: `@cloudflare/containers` ends it (and `start()`) with
     * `blockConcurrencyWhile(async () => { … await this.onStart(); })`
     * (from both `start()` and `startAndWaitForPorts()`), and workerd treats a *rejecting*
     * closure there as unrecoverable — it aborts the Durable Object and flattens
     * the error to a plain `Error`. Pulling the image and waiting for ports is
     * stubbed; the gate is reproduced, and the double records the abort so a
     * regression is visible rather than merely differently-worded.
     * @returns A record whose `aborted` flag flips if the gate saw a rejection.
     */
    const baseStartGate = (onContainerStarted?: () => void): { aborted: boolean } => {
        const record = { aborted: false };

        const gate = async function runGate(this: { onStart: () => Promise<void> }): Promise<void> {
            // `doStartContainer` ends with `state.setRunning()`, so a start that
            // reaches the gate has already flipped the container to running. A
            // double that left the flag alone made every start look like a first
            // start, which is exactly the case the run-identity logic must tell
            // apart from a no-op start on a live container.
            onContainerStarted?.();

            try {
                await this.onStart();
            } catch (error) {
                record.aborted = true;

                // workerd flattens the closure's error to a plain `Error` whose
                // message is the original's `name: message` and which carries none
                // of its own properties.
                throw new Error(String(error), { cause: error });
            }
        };

        // The base ends BOTH start entry points this way, and only
        // `startAndWaitForPorts` syncs the pending `onStop` first — so a test that
        // stubs only one of them cannot see the difference between the two paths.
        vi.spyOn(Container.prototype, "startAndWaitForPorts").mockImplementation(gate);
        vi.spyOn(Container.prototype, "start").mockImplementation(gate);

        return record;
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

    it("gates the start on readyOn probes until each returns its expected status", async () => {
        expect.assertions(3);

        vi.spyOn(console, "log").mockImplementation(() => {});

        const fetched: string[] = [];
        const context = fakeDurableObjectContext({
            container: {
                getTcpPort: (port: number) => {
                    return {
                        fetch: (url: string) => {
                            fetched.push(`${String(port)}:${url}`);

                            return Promise.resolve({ status: url.endsWith("/live") ? 204 : 200 });
                        },
                    };
                },
                // `running: false` keeps the base ctor off its monitor path; the
                // readiness probes only need `getTcpPort`, not a running flag.
                running: false,
            },
        });

        const definition = defineContainer({
            defaultPort: 8080,
            image: "./app",
            readyOn: [{ path: "/ready" }, { path: "live", port: 9090, status: 204 }],
        });
        const instance = new LunoraContainer(context as never, {}, definition, "transcoder");

        baseStartGate();

        await expect(instance.startAndWaitForPorts()).resolves.toBeUndefined();
        // `/ready` resolves on the default port; `live` (no leading slash) is
        // normalized and probed on its own port against status 204.
        expect(fetched).toContain("8080:http://container/ready");
        expect(fetched).toContain("9090:http://container/live");
    });

    it("fails the start when a readyOn check has no port and no defaultPort", async () => {
        expect.assertions(2);

        vi.spyOn(console, "log").mockImplementation(() => {});

        const context = fakeDurableObjectContext({
            container: {
                getTcpPort: () => {
                    return { fetch: () => Promise.resolve({ status: 200 }) };
                },
                running: false,
            },
        });
        const definition = defineContainer({ image: "./app", readyOn: [{ path: "/ready" }] });
        const instance = new LunoraContainer(context as never, {}, definition, "transcoder");
        const state = baseStartGate();

        await expect(instance.startAndWaitForPorts()).rejects.toThrow("has no port");
        // A misconfigured probe is a config error, not grounds for tearing the
        // object down — it must surface from outside the start gate.
        expect(state.aborted).toBe(false);
    });

    it("aborts a readiness probe that never responds instead of hanging forever, and rejects at the deadline", async () => {
        expect.assertions(3);

        vi.spyOn(console, "log").mockImplementation(() => {});
        // The per-attempt deadline is a JS-land `setTimeout`
        // (shared/abort-deadline.ts), so fake timers drive it directly:
        // advancing to the readiness deadline fires the attempt's abort and
        // the loop's own deadline check in one pass, without a real 30s wait.
        vi.useFakeTimers();

        const context = fakeDurableObjectContext({
            container: {
                getTcpPort: () => {
                    return {
                        // A container that accepted the TCP connection but never
                        // answers: the returned promise only ever settles via the
                        // abort signal, exactly like a real `fetch` would.
                        fetch: (_url: string, init?: { signal?: AbortSignal }) =>
                            new Promise((_resolve, reject) => {
                                if (init?.signal?.aborted) {
                                    reject(new Error("aborted"));

                                    return;
                                }

                                init?.signal?.addEventListener("abort", () => {
                                    reject(new Error("aborted"));
                                });
                            }),
                    };
                },
                running: false,
            },
        });

        const definition = defineContainer({ defaultPort: 8080, image: "./app", readyOn: [{ path: "/ready" }] });
        const instance = new LunoraContainer(context as never, {}, definition, "transcoder");
        const state = baseStartGate();

        let thrown: unknown;

        try {
            // The start only settles once the fake timers below advance, so it is
            // kicked off here and awaited after they do.
            const pending = instance.startAndWaitForPorts().catch((error: unknown) => {
                thrown = error;
            });

            await vi.advanceTimersByTimeAsync(30_000);
            await pending;
        } finally {
            vi.useRealTimers();
        }

        // A wedged app is an ordinary, diagnosable failure. Waiting for it inside
        // the base's `blockConcurrencyWhile` would make workerd abort the Durable
        // Object and flatten the error to a plain `Error`, so the caller would get
        // an opaque message instead of the check, the port and the budget — and
        // the object would lose its in-memory state and its hibernating sockets on
        // every start attempt. The wait therefore runs outside the gate.
        expect(state.aborted).toBe(false);
        expect(thrown).toBeInstanceOf(LunoraError);
        expect((thrown as Error).message).toContain('readiness check "/ready" (port 8080) did not return 200 within 30000ms');
    });

    it("does not proxy a request while the readiness probes are still pending", async () => {
        expect.assertions(2);

        vi.spyOn(console, "log").mockImplementation(() => {});

        // The base commits the healthy state INSIDE its start gate, before our
        // probes run — so `super.containerFetch` skips the start path entirely and
        // would proxy to an app that never reported ready. Reproduce exactly that:
        // healthy, with a probe that never succeeds.
        const proxied = vi.spyOn(Container.prototype, "containerFetch").mockResolvedValue(new Response("from the app"));

        vi.spyOn(Container.prototype, "getState").mockResolvedValue({ status: "healthy" } as never);

        vi.useFakeTimers();

        // A container that accepts the connection and never answers — the probe
        // settles only via its abort signal, as with a real wedged app.
        const context = fakeDurableObjectContext({
            container: {
                getTcpPort: () => {
                    return {
                        fetch: (_url: string, init?: { signal?: AbortSignal }) =>
                            new Promise((_resolve, reject) => {
                                if (init?.signal?.aborted) {
                                    reject(new Error("aborted"));

                                    return;
                                }

                                init?.signal?.addEventListener("abort", () => {
                                    reject(new Error("aborted"));
                                });
                            }),
                    };
                },
                running: false,
            },
        });

        const definition = defineContainer({ defaultPort: 8080, image: "./app", readyOn: [{ path: "/ready" }] });
        const instance = new LunoraContainer(context as never, {}, definition, "transcoder");

        let thrown: unknown;

        try {
            const pending = instance.containerFetch("https://container/").catch((error: unknown) => {
                thrown = error;
            });

            await vi.advanceTimersByTimeAsync(30_000);
            await pending;
        } finally {
            vi.useRealTimers();
        }

        // The request fails on the readiness budget instead of being handed to an
        // app that never reported ready.
        expect(proxied).not.toHaveBeenCalled();
        expect((thrown as Error).message).toContain('readiness check "/ready"');
    });

    /** The `ctx.container` surface the readiness/start paths touch, with a mutable `running` flag. */
    interface RunningFlagContainer {
        getTcpPort: (port?: number) => { fetch: (url: string, init?: RequestInit) => Promise<Response> };
        monitor: () => Promise<void>;
        running: boolean;
    }

    /** A `ctx.container` stub whose `running` flag is mutable, the way the real one is. */
    const runningFlagContainer = (running: boolean): RunningFlagContainer => {
        return {
            getTcpPort: () => {
                return { fetch: async () => new Response("ok", { status: 200 }) };
            },
            // The base attaches a monitor whenever it finds the container already
            // running; the real one settles when the container exits.
            monitor: () => new Promise<void>(() => {}),
            running,
        };
    };

    it("re-arms and re-probes when a start follows a run that exited without an onStop", async () => {
        expect.assertions(3);

        vi.spyOn(console, "log").mockImplementation(() => {});

        const definition = defineContainer({ defaultPort: 8080, hardTimeout: "30s", image: "./app", readyOn: [{ path: "/ready" }] });
        const container = runningFlagContainer(false);
        const instance = new LunoraContainer(fakeDurableObjectContext({ container }) as never, {}, definition, "transcoder");
        const scheduleSpy = vi.spyOn(instance, "schedule").mockResolvedValue(undefined as never);
        const probes = vi.spyOn(container, "getTcpPort");

        baseStartGate(() => {
            container.running = true;
        });

        await instance.startAndWaitForPorts();

        expect(scheduleSpy).toHaveBeenCalledTimes(1);

        // The run ends — a crash, `sleepAfter`, or the hard timeout's own SIGTERM.
        // The base's monitor callback records the exit and nothing else: `onStop`
        // is only reached through `syncPendingStoppedEvents`, which `start()` never
        // calls and the alarm loop can take up to three minutes to reach. So the
        // next start MUST NOT be handed the finished run's settled gate — that
        // skips both the hard-timeout re-arm and the `readyOn` probes.
        container.running = false;

        await instance.start();

        expect(scheduleSpy).toHaveBeenCalledTimes(2);
        expect(probes).toHaveBeenCalledTimes(2);
    });

    it("does not re-arm the hard timeout when a start finds the container already running", async () => {
        expect.assertions(2);

        vi.spyOn(console, "log").mockImplementation(() => {});

        // The mirror case: an isolate recycled under a live container has no gate
        // in memory, but the run's hard-timeout schedule row is durable (SQLite)
        // and still armed. Re-arming stamps a fresh generation, so the row that
        // would have killed the run is ignored and a periodic "ensure started"
        // call pushes the "total lifetime" cap out indefinitely.
        const definition = defineContainer({ defaultPort: 8080, hardTimeout: "30s", image: "./app", readyOn: [{ path: "/ready" }] });
        const container = runningFlagContainer(true);
        const instance = new LunoraContainer(fakeDurableObjectContext({ container }) as never, {}, definition, "transcoder");
        const scheduleSpy = vi.spyOn(instance, "schedule").mockResolvedValue(undefined as never);
        const probes = vi.spyOn(container, "getTcpPort");

        baseStartGate(() => {
            container.running = true;
        });

        await instance.start();

        expect(scheduleSpy).not.toHaveBeenCalled();
        // Readiness is still established for this isolate — it has no gate on
        // record and must not proxy on the base's healthy state alone.
        expect(probes).toHaveBeenCalledTimes(1);
    });

    it("resolves the Secrets Store env on the startAndWaitForPorts path", async () => {
        expect.assertions(2);

        vi.spyOn(console, "log").mockImplementation(() => {});

        // The start path `containerFetch` routes through, and the one an app can
        // call itself. `doStartContainer` reads `this.envVars`, so skipping
        // resolution here starts the container without its `secretsStore` values.
        const get = vi.fn<() => Promise<string>>(async () => "sk_live_123");
        const definition = defineContainer({ image: "./app", secretsStore: { STRIPE_KEY: "STRIPE_SECRET" } });
        const container = runningFlagContainer(false);
        const instance = new LunoraContainer(fakeDurableObjectContext({ container }) as never, { STRIPE_SECRET: { get } }, definition, "transcoder");

        baseStartGate(() => {
            container.running = true;
        });

        await instance.startAndWaitForPorts();

        expect(get).toHaveBeenCalledTimes(1);
        expect((instance as unknown as { envVars: Record<string, string> }).envVars).toStrictEqual({ STRIPE_KEY: "sk_live_123" });
    });

    it("arms a hard-timeout schedule on start, stamped with the bumped run generation", async () => {
        expect.assertions(2);

        vi.spyOn(console, "log").mockImplementation(() => {});

        const definition = defineContainer({ hardTimeout: "30s", image: "./app" });
        const instance = new LunoraContainer(fakeDurableObjectContext({ storedGeneration: 4 }) as never, {}, definition, "transcoder");
        const scheduleSpy = vi.spyOn(instance, "schedule").mockResolvedValue(undefined as never);

        baseStartGate();

        await instance.startAndWaitForPorts();

        expect(scheduleSpy).toHaveBeenCalledTimes(1);
        // 30s → 30 seconds; generation 4 → 5 (bumped so a stale schedule is detectable).
        expect(scheduleSpy).toHaveBeenCalledWith(30, "onHardTimeoutExpired", { generation: 5 });
    });

    it("onHardTimeoutExpired stops a running instance whose generation matches", async () => {
        expect.assertions(2);

        const spy = vi.spyOn(console, "log").mockImplementation(() => {});

        const definition = defineContainer({ hardTimeout: "30s", image: "./app" });
        // `monitor` is reached by the base ctor when `running` is true.
        const instance = new LunoraContainer(
            fakeDurableObjectContext({ container: { monitor: () => Promise.resolve(), running: true }, storedGeneration: 3 }) as never,
            {},
            definition,
            "transcoder",
        );
        const stopSpy = vi.spyOn(instance, "stop").mockResolvedValue(undefined);

        await instance.onHardTimeoutExpired({ generation: 3 });

        expect(stopSpy).toHaveBeenCalledTimes(1);
        expect(JSON.parse((spy.mock.calls.at(-1)![0] as string) ?? "{}")).toMatchObject({ event: "stop", message: "hard timeout reached" });
    });

    it("onHardTimeoutExpired ignores a stale generation or an already-stopped instance", async () => {
        expect.assertions(2);

        vi.spyOn(console, "log").mockImplementation(() => {});

        const definition = defineContainer({ hardTimeout: "30s", image: "./app" });

        const stale = new LunoraContainer(
            fakeDurableObjectContext({ container: { monitor: () => Promise.resolve(), running: true }, storedGeneration: 5 }) as never,
            {},
            definition,
            "transcoder",
        );
        const staleStop = vi.spyOn(stale, "stop").mockResolvedValue(undefined);

        await stale.onHardTimeoutExpired({ generation: 2 });

        const stopped = new LunoraContainer(
            fakeDurableObjectContext({ container: { running: false }, storedGeneration: 1 }) as never,
            {},
            definition,
            "transcoder",
        );
        const stoppedStop = vi.spyOn(stopped, "stop").mockResolvedValue(undefined);

        await stopped.onHardTimeoutExpired({ generation: 1 });

        expect(staleStop).not.toHaveBeenCalled();
        expect(stoppedStop).not.toHaveBeenCalled();
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
