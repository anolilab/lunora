/**
 * Real-workerd boot smoke for `@lunora/container`.
 *
 * Boundary: a real container runtime is NOT available here — Miniflare's
 * container support requires a Docker engine,
 * which CI sandboxes don't have, so the wrangler config declares the Container
 * DO class WITHOUT a `containers` section. That makes the deepest runnable
 * smoke: the `LunoraContainer` module graph (`@cloudflare/containers` +
 * `cloudflare:workers`) loads and the generated DO subclass is instantiable up
 * to `@cloudflare/containers`' own guard — the constructor's directed
 * "Containers have not been enabled" error surfaces through a real DO stub
 * call, proving the class boots in workerd right up to the missing container
 * runtime. On top of that, the `ctx.containers.&lt;name>` surface
 * (`createContainerContext`) resolves real Durable Object namespace bindings
 * and exposes the `.get`/`.any`/`.pool` handles (a missing binding degrades to
 * a directed error), and the container→Lunora bridge client
 * (`createContainerBridge`) round-trips a real workerd HTTP request against
 * the worker's `/_lunora/rpc` endpoint (success envelope, bearer forwarding,
 * and the typed error envelope).
 *
 * Actually starting a container (proxied fetch reaching an app, lifecycle
 * start/stop) needs Docker and stays out of scope for this suite.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { ContainerBridgeError, createContainerBridge } from "../../src/bridge";
import { createContainerContext } from "../../src/client";
import { containerBindingName } from "../../src/define-container";

/** The guard `@cloudflare/containers` raises when the DO has no container runtime. */
const NO_RUNTIME_GUARD = /Containers have not been enabled/;

describe("@lunora/container (workerd)", () => {
    it("boots the generated LunoraContainer DO up to the no-container-runtime guard", async () => {
        expect.hasAssertions();

        // The DO class itself constructs in workerd until @cloudflare/containers'
        // `ctx.container === undefined` guard — the directed error propagating
        // through a real stub call proves the module graph + class boot in workerd.
        const stub = env.CONTAINER_SMOKE.get(env.CONTAINER_SMOKE.idFromName("boot-guard"));

        await expect(stub.fetch("https://container.internal/ping")).rejects.toThrow(NO_RUNTIME_GUARD);
    });

    it("ctx.containers resolves the real DO namespace binding into typed handles", async () => {
        expect.hasAssertions();

        const containers = createContainerContext(env as unknown as Record<string, unknown>, [{ binding: containerBindingName("smoke"), exportName: "smoke" }]);

        const handle = containers.smoke!.get("tenant-1", { attempts: 1 });

        // The full instance-handle surface is wired over the real namespace.
        expect(handle.fetch).toBeTypeOf("function");
        expect(handle.start).toBeTypeOf("function");
        expect(handle.stop).toBeTypeOf("function");
        expect(handle.destroy).toBeTypeOf("function");
        expect(handle.getState).toBeTypeOf("function");
        expect(containers.smoke!.any).toBeTypeOf("function");
        expect(containers.smoke!.pool).toBeTypeOf("function");

        // Driving the handle reaches the real Durable Object — and stops at the
        // documented no-runtime boundary.
        await expect(handle.fetch("/ping")).rejects.toThrow(NO_RUNTIME_GUARD);
    });

    it("a missing container binding degrades to a directed error on use", () => {
        expect.hasAssertions();

        const containers = createContainerContext(env as unknown as Record<string, unknown>, [{ binding: containerBindingName("ghost"), exportName: "ghost" }]);

        expect(() => containers.ghost!.get("x")).toThrow(/no "CONTAINER_GHOST" Durable Object binding found/);
    });

    it("the container bridge round-trips a Lunora RPC over real workerd HTTP", async () => {
        expect.hasAssertions();

        const bridge = createContainerBridge({
            baseUrl: "https://lunora-container-test-worker.test",
            fetch: (url, init) => SELF.fetch(url, init),
            token: "smoke-token",
        });

        const result = await bridge.query<{ authorization: string; echoed: Record<string, unknown> }>("smoke:echo", { limit: 20 });

        expect(result).toEqual({ authorization: "Bearer smoke-token", echoed: { limit: 20 } });
    });

    it("the bridge surfaces a Lunora error envelope as a typed ContainerBridgeError", async () => {
        expect.hasAssertions();

        const bridge = createContainerBridge({
            baseUrl: "https://lunora-container-test-worker.test",
            fetch: (url, init) => SELF.fetch(url, init),
        });

        const failure = bridge.call("smoke:doesNotExist");

        await expect(failure).rejects.toBeInstanceOf(ContainerBridgeError);
        await expect(failure).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
});
