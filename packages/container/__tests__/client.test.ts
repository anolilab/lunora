import { describe, expect, it, vi } from "vitest";

import type { ContainerNamespaceLike } from "../src/index";
import { createContainerContext, createContainerTestContext } from "../src/index";

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
