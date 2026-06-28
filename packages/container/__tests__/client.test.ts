import { describe, expect, it, vi } from "vitest";

import type { ContainerNamespaceLike } from "../src/index";
import { createContainerContext, createContainerTestContext } from "../src/index";

const JURISDICTION_UNSUPPORTED = /does not support jurisdiction/;

/** A fake DO namespace recording which instance names were targeted. */
const fakeNamespace = (): { names: string[]; namespace: ContainerNamespaceLike; requests: Request[] } => {
    const names: string[] = [];
    const requests: Request[] = [];

    return {
        names,
        namespace: {
            get: () => {
                return {
                    fetch: async (request: Request) => {
                        requests.push(request);

                        return new Response("ok");
                    },
                };
            },
            idFromName: (name: string) => {
                names.push(name);

                return name;
            },
        },
        requests,
    };
};

describe(createContainerContext, () => {
    it("routes .get(name) to the named instance with a path request", async () => {
        expect.assertions(3);

        const { names, namespace, requests } = fakeNamespace();
        const containers = createContainerContext({ CONTAINER_TRANSCODER: namespace }, [
            { binding: "CONTAINER_TRANSCODER", exportName: "transcoder", maxInstances: 5 },
        ]);

        const response = await containers.transcoder!.get("video-42").fetch("/transcode", { method: "POST" });

        await expect(response.text()).resolves.toBe("ok");
        expect(names).toStrictEqual(["video-42"]);
        // Assert only the path: the synthetic `container` origin is an internal
        // routing detail, and a literal http URL trips the clear-text lint.
        expect(new URL(requests[0]!.url).pathname).toBe("/transcode");
    });

    it("passes a full Request through unchanged", async () => {
        expect.assertions(1);

        const { namespace, requests } = fakeNamespace();
        const containers = createContainerContext({ CONTAINER_TRANSCODER: namespace }, [{ binding: "CONTAINER_TRANSCODER", exportName: "transcoder" }]);

        await containers.transcoder!.get("a").fetch(new Request("https://example.com/probe"));

        expect(requests[0]!.url).toBe("https://example.com/probe");
    });

    it(".any() picks a pool instance within maxInstances", async () => {
        expect.assertions(2);

        const { names, namespace } = fakeNamespace();
        const containers = createContainerContext({ CONTAINER_TRANSCODER: namespace }, [
            { binding: "CONTAINER_TRANSCODER", exportName: "transcoder", maxInstances: 2 },
        ]);

        vi.spyOn(Math, "random").mockReturnValue(0.99);

        await containers.transcoder!.any().fetch("/probe");

        expect(names).toStrictEqual(["pool-1"]);

        await containers.transcoder!.any(10).fetch("/probe");

        expect(names[1]).toBe("pool-9");

        vi.restoreAllMocks();
    });

    it("throws a directed error when the binding is missing", () => {
        expect.assertions(1);

        const containers = createContainerContext({}, [{ binding: "CONTAINER_TRANSCODER", exportName: "transcoder" }]);

        expect(() => containers.transcoder!.get("a")).toThrow('no "CONTAINER_TRANSCODER" Durable Object binding found');
    });

    it("throws the same directed error from .any() and .pool() when the binding is missing", () => {
        expect.assertions(2);

        const containers = createContainerContext({}, [{ binding: "CONTAINER_TRANSCODER", exportName: "transcoder" }]);

        expect(() => containers.transcoder!.any()).toThrow('no "CONTAINER_TRANSCODER" Durable Object binding found');
        expect(() => containers.transcoder!.pool()).toThrow('no "CONTAINER_TRANSCODER" Durable Object binding found');
    });

    it("treats a partial namespace (missing get/idFromName) as a missing binding", () => {
        expect.assertions(1);

        // A value present on env but not shaped like a DO namespace must not be
        // mistaken for a usable binding — it routes to the directed error.
        const containers = createContainerContext({ CONTAINER_TRANSCODER: { idFromName: () => "x" } }, [
            { binding: "CONTAINER_TRANSCODER", exportName: "transcoder" },
        ]);

        expect(() => containers.transcoder!.get("a")).toThrow('no "CONTAINER_TRANSCODER" Durable Object binding found');
    });

    it("routes through a jurisdiction-pinned subnamespace when configured", async () => {
        expect.assertions(2);

        const inner = fakeNamespace();
        const jurisdictionCalls: string[] = [];
        const namespace: ContainerNamespaceLike = {
            get: () => {
                throw new Error("should resolve via the jurisdiction subnamespace, not the root namespace");
            },
            idFromName: () => {
                throw new Error("should resolve via the jurisdiction subnamespace, not the root namespace");
            },
            jurisdiction: (j) => {
                jurisdictionCalls.push(j);

                return inner.namespace;
            },
        };

        const containers = createContainerContext({ CONTAINER_TRANSCODER: namespace }, [{ binding: "CONTAINER_TRANSCODER", exportName: "transcoder" }], "us");

        await containers.transcoder!.get("video-42").fetch("/transcode", { method: "POST" });

        expect(jurisdictionCalls).toStrictEqual(["us"]);
        expect(inner.names).toStrictEqual(["video-42"]);
    });

    it("fails closed when the binding lacks jurisdiction support", () => {
        expect.assertions(1);

        const { namespace } = fakeNamespace();

        expect(() =>
            createContainerContext({ CONTAINER_TRANSCODER: namespace }, [{ binding: "CONTAINER_TRANSCODER", exportName: "transcoder" }], "eu"),
        ).toThrow(JURISDICTION_UNSUPPORTED);
    });
});

describe("ctx.containers.<name>.get() lifecycle controls", () => {
    /** A namespace whose stub records lifecycle calls + their args. */
    const lifecycleNamespace = (): { calls: { arg: unknown; method: string }[]; namespace: ContainerNamespaceLike } => {
        const calls: { arg: unknown; method: string }[] = [];
        const recordVoid =
            (method: string) =>
            async (arg?: unknown): Promise<void> => {
                calls.push({ arg, method });
            };

        return {
            calls,
            namespace: {
                get: () => {
                    return {
                        destroy: recordVoid("destroy"),
                        fetch: async () => new Response("ok"),
                        getState: async () => {
                            calls.push({ arg: undefined, method: "getState" });

                            return { lastChange: 7, running: true };
                        },
                        start: recordVoid("start"),
                        stop: recordVoid("stop"),
                    };
                },
                idFromName: (name: string) => name,
            },
        };
    };

    it("forwards start/stop/destroy/getState to the named instance's DO", async () => {
        expect.assertions(5);

        const { calls, namespace } = lifecycleNamespace();
        const handle = createContainerContext({ CONTAINER_TRANSCODER: namespace }, [
            { binding: "CONTAINER_TRANSCODER", exportName: "transcoder" },
        ]).transcoder!.get("video-1");

        await handle.start({ envVars: { LEVEL: "debug" } });
        await handle.stop("SIGTERM");
        await handle.destroy();
        const state = await handle.getState();

        expect(calls.map((call) => call.method)).toStrictEqual(["start", "stop", "destroy", "getState"]);
        expect(calls[0]!.arg).toStrictEqual({ envVars: { LEVEL: "debug" } });
        expect(calls[1]!.arg).toBe("SIGTERM");
        expect(calls[2]!.arg).toBeUndefined();
        expect(state).toStrictEqual({ lastChange: 7, running: true });
    });

    it("throws a directed error when the runtime stub lacks a lifecycle method", async () => {
        expect.assertions(1);

        // A fetch-only stub (older @lunora/container/do) → stop() is unavailable.
        const namespace: ContainerNamespaceLike = {
            get: () => {
                return { fetch: async () => new Response("ok") };
            },
            idFromName: (name) => name,
        };
        const handle = createContainerContext({ CONTAINER_TRANSCODER: namespace }, [
            { binding: "CONTAINER_TRANSCODER", exportName: "transcoder" },
        ]).transcoder!.get("a");

        await expect(handle.stop()).rejects.toThrow("does not expose stop()");
    });

    it("forwards renewActivityTimeout and the egress controls to the DO with the right args", async () => {
        expect.assertions(2);

        const calls: { arg: unknown; method: string }[] = [];
        const recordVoid =
            (method: string) =>
            async (arg?: unknown): Promise<void> => {
                calls.push({ arg, method });
            };
        const egressNamespace: ContainerNamespaceLike = {
            get: () => {
                return {
                    allowHost: recordVoid("allowHost"),
                    denyHost: recordVoid("denyHost"),
                    fetch: async () => new Response("ok"),
                    removeAllowedHost: recordVoid("removeAllowedHost"),
                    removeDeniedHost: recordVoid("removeDeniedHost"),
                    renewActivityTimeout: recordVoid("renewActivityTimeout"),
                    setAllowedHosts: recordVoid("setAllowedHosts"),
                    setDeniedHosts: recordVoid("setDeniedHosts"),
                };
            },
            idFromName: (name) => name,
        };

        const handle = createContainerContext({ CONTAINER_TRANSCODER: egressNamespace }, [
            { binding: "CONTAINER_TRANSCODER", exportName: "transcoder" },
        ]).transcoder!.get("video-1");

        await handle.renewActivityTimeout();
        await handle.egress.allow("api.stripe.com");
        await handle.egress.deny("evil.com");
        await handle.egress.setAllowed(["a.com", "b.com"]);
        await handle.egress.setDenied(["c.com"]);
        await handle.egress.removeAllowed("a.com");
        await handle.egress.removeDenied("c.com");

        expect(calls.map((call) => call.method)).toStrictEqual([
            "renewActivityTimeout",
            "allowHost",
            "denyHost",
            "setAllowedHosts",
            "setDeniedHosts",
            "removeAllowedHost",
            "removeDeniedHost",
        ]);
        // ReadonlyArray args are copied to a fresh mutable array before the RPC.
        expect(calls.find((call) => call.method === "setAllowedHosts")!.arg).toStrictEqual(["a.com", "b.com"]);
    });

    it("routes .port(n) requests with the cf-container-target-port header across get/any/pool", async () => {
        expect.assertions(4);

        const { namespace, requests } = fakeNamespace();
        const containers = createContainerContext({ CONTAINER_TRANSCODER: namespace }, [
            { binding: "CONTAINER_TRANSCODER", exportName: "transcoder", maxInstances: 3 },
        ]);

        await containers.transcoder!.get("video-1").port(9090).fetch("/admin");
        await containers.transcoder!.any().port(7000).fetch("/admin");
        await containers.transcoder!.pool().port(6000).fetch("/admin");
        await containers.transcoder!.get("video-1").fetch("/no-port");

        expect(requests[0]!.headers.get("cf-container-target-port")).toBe("9090");
        expect(requests[1]!.headers.get("cf-container-target-port")).toBe("7000");
        expect(requests[2]!.headers.get("cf-container-target-port")).toBe("6000");
        expect(requests[3]!.headers.get("cf-container-target-port")).toBeNull();
    });
});

/** A namespace whose every `fetch` runs the next scripted step (response or throw). */
const scriptedNamespace = (steps: ReadonlyArray<() => Promise<Response>>): { calls: number; namespace: ContainerNamespaceLike } => {
    const state = { calls: 0 };

    return {
        get calls() {
            return state.calls;
        },
        namespace: {
            get: () => {
                return {
                    fetch: async () => {
                        const step = steps[Math.min(state.calls, steps.length - 1)]!;

                        state.calls += 1;

                        return step();
                    },
                };
            },
            idFromName: (name: string) => name,
        },
    };
};

describe("ctx.containers.<name>.pool()", () => {
    const ok = async (): Promise<Response> => new Response("ok");
    const serverError = async (): Promise<Response> => new Response("boom", { status: 503 });
    const thrown = (): Promise<Response> => Promise.reject(new Error("container start failed"));

    it("returns the first healthy response without retrying", async () => {
        expect.assertions(2);

        const scripted = scriptedNamespace([ok]);
        const containers = createContainerContext({ CONTAINER_TRANSCODER: scripted.namespace }, [
            { binding: "CONTAINER_TRANSCODER", exportName: "transcoder" },
        ]);

        const response = await containers.transcoder!.pool({ backoffMs: 0 }).fetch("/probe");

        await expect(response.text()).resolves.toBe("ok");
        expect(scripted.calls).toBe(1);
    });

    it("retries a 5xx on another instance and returns the eventual success", async () => {
        expect.assertions(2);

        const scripted = scriptedNamespace([serverError, serverError, ok]);
        const containers = createContainerContext({ CONTAINER_TRANSCODER: scripted.namespace }, [
            { binding: "CONTAINER_TRANSCODER", exportName: "transcoder" },
        ]);

        const response = await containers.transcoder!.pool({ attempts: 3, backoffMs: 0 }).fetch("/probe");

        await expect(response.text()).resolves.toBe("ok");
        expect(scripted.calls).toBe(3);
    });

    it("retries a thrown error and recovers", async () => {
        expect.assertions(2);

        const scripted = scriptedNamespace([thrown, ok]);
        const containers = createContainerContext({ CONTAINER_TRANSCODER: scripted.namespace }, [
            { binding: "CONTAINER_TRANSCODER", exportName: "transcoder" },
        ]);

        const response = await containers.transcoder!.pool({ attempts: 2, backoffMs: 0 }).fetch("/probe");

        await expect(response.text()).resolves.toBe("ok");
        expect(scripted.calls).toBe(2);
    });

    it("returns the last 5xx response when attempts are exhausted", async () => {
        expect.assertions(2);

        const scripted = scriptedNamespace([serverError]);
        const containers = createContainerContext({ CONTAINER_TRANSCODER: scripted.namespace }, [
            { binding: "CONTAINER_TRANSCODER", exportName: "transcoder" },
        ]);

        const response = await containers.transcoder!.pool({ attempts: 2, backoffMs: 0 }).fetch("/probe");

        expect(response.status).toBe(503);
        expect(scripted.calls).toBe(2);
    });

    it("propagates the error when every attempt throws", async () => {
        expect.assertions(1);

        const scripted = scriptedNamespace([thrown]);
        const containers = createContainerContext({ CONTAINER_TRANSCODER: scripted.namespace }, [
            { binding: "CONTAINER_TRANSCODER", exportName: "transcoder" },
        ]);

        await expect(containers.transcoder!.pool({ attempts: 2, backoffMs: 0 }).fetch("/probe")).rejects.toThrow("container start failed");
    });

    it("does not retry a 5xx when attempts is 1", async () => {
        expect.assertions(2);

        const scripted = scriptedNamespace([serverError, ok]);
        const containers = createContainerContext({ CONTAINER_TRANSCODER: scripted.namespace }, [
            { binding: "CONTAINER_TRANSCODER", exportName: "transcoder" },
        ]);

        const response = await containers.transcoder!.pool({ attempts: 1, backoffMs: 0 }).fetch("/probe");

        expect(response.status).toBe(503);
        expect(scripted.calls).toBe(1);
    });

    it("clamps the exponential backoff to the ceiling for large attempt indices", async () => {
        expect.assertions(1);

        // Capture every backoff sleep without actually waiting: each scheduled
        // timer fires immediately while recording its requested delay.
        const delays: number[] = [];
        const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, ms?: number) => {
            delays.push(ms ?? 0);
            handler();

            return 0 as unknown as ReturnType<typeof setTimeout>;
        }) as typeof setTimeout);

        try {
            // Always 5xx so every attempt retries: with base 1000ms and a 5s cap,
            // the raw doubling (1000, 2000, 4000, 8000, 16000, 32000) is clamped.
            const scripted = scriptedNamespace([serverError]);
            const containers = createContainerContext({ CONTAINER_TRANSCODER: scripted.namespace }, [
                { binding: "CONTAINER_TRANSCODER", exportName: "transcoder" },
            ]);

            await containers.transcoder!.pool({ attempts: 7, backoffMs: 1000, maxBackoffMs: 5000 }).fetch("/probe");

            expect(delays).toStrictEqual([1000, 2000, 4000, 5000, 5000, 5000]);
        } finally {
            timeoutSpy.mockRestore();
        }
    });

    it("honors a custom retryOn predicate", async () => {
        expect.assertions(2);

        const scripted = scriptedNamespace([async () => new Response("rate limited", { status: 429 }), ok]);
        const containers = createContainerContext({ CONTAINER_TRANSCODER: scripted.namespace }, [
            { binding: "CONTAINER_TRANSCODER", exportName: "transcoder" },
        ]);

        const response = await containers.transcoder!.pool({ attempts: 2, backoffMs: 0, retryOn: (r) => r.status === 429 }).fetch("/probe");

        await expect(response.text()).resolves.toBe("ok");
        expect(scripted.calls).toBe(2);
    });
});

describe(createContainerTestContext, () => {
    it("plays the container via the provided handler", async () => {
        expect.assertions(3);

        const handler = vi.fn<(request: Request, instance: { name: string }) => Promise<Response>>(
            async (request, instance) => new Response(`${instance.name}:${new URL(request.url).pathname}`),
        );
        const containers = createContainerTestContext({ transcoder: handler });

        const response = await containers.transcoder!.get("video-1").fetch("/transcode");

        await expect(response.text()).resolves.toBe("video-1:/transcode");
        expect(handler).toHaveBeenCalledTimes(1);

        const pooled = await containers.transcoder!.any().fetch("/probe");

        await expect(pooled.text()).resolves.toBe("pool-0:/probe");
    });
});
