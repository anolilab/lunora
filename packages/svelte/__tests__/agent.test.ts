import type { FunctionReference, LunoraClient, SubscriptionError } from "@lunora/client";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentApi } from "../src/agent";
import { agent } from "../src/agent";

const makeRef = (reference: string): FunctionReference => {
    return { __lunoraRef: reference };
};

const THREAD_REF = "agents:agentThread";
const RUN_REF = "chat:startRun";
const CANCEL_REF = "chat:cancelRun";

interface SubscribeCall {
    args: { key: string };
    callback: (value: unknown) => void;
    functionPath: string;
    onError?: (error: SubscriptionError) => void;
}

const buildApi = (): AgentApi =>
    ({
        agents: {
            agentThread: makeRef(THREAD_REF),
        },
    }) as unknown as AgentApi;

const createFakeClient = () => {
    const subscribeCalls: SubscribeCall[] = [];
    const unsubscribeSpy = vi.fn<() => void>();
    const mutationSpy = vi.fn<() => Promise<{ resolved: boolean }>>(async () => {
        return { resolved: true };
    });

    const subscribe = vi.fn<
        (
            function_: FunctionReference,
            args: SubscribeCall["args"],
            callback: (value: unknown) => void,
            options?: { onError?: (error: SubscriptionError) => void },
        ) => () => void
    >((function_, args, callback, options) => {
        subscribeCalls.push({ args, callback, functionPath: function_["__lunoraRef"], onError: options?.onError });

        return unsubscribeSpy;
    });

    const client = { mutation: mutationSpy, subscribe } as unknown as LunoraClient;

    return {
        client,
        mutationSpy,
        /** Push `value` to every subscription opened on `functionPath`. */
        push: (functionPath: string, value: unknown): void => {
            for (const call of subscribeCalls) {
                if (call.functionPath === functionPath) {
                    call.callback(value);
                }
            }
        },
        subscribeCalls,
        unsubscribeSpy,
    };
};

// Solid (`createEffect`/`onMount`) and Angular (`shouldOpenSubscription`/
// `PLATFORM_ID`) are SSR-safe by construction — do not port this guard there
// (plan 282 §1/§8).
describe(agent, () => {
    beforeEach(() => {
        // `agent` gates its thread subscription on a browser `window`
        // (SVELTE-01); the vitest env is `node` (no `window`), so define one
        // for these client-path tests. The SSR test below removes it to
        // exercise the guard, mirroring `presence.test.ts`.
        Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    });

    afterEach(() => {
        Reflect.deleteProperty(globalThis, "window");
    });

    it("subscribes to the thread channel and flows live status through", () => {
        const fake = createFakeClient();
        const handle = agent(fake.client, {
            api: buildApi(),
            cancel: makeRef(CANCEL_REF) as FunctionReference<"mutation">,
            run: makeRef(RUN_REF) as FunctionReference<"mutation">,
            threadKey: "t1",
        });

        expect(fake.subscribeCalls.map((call) => call.functionPath)).toStrictEqual([THREAD_REF]);
        expect(get(handle.status)).toBeUndefined();

        fake.push(THREAD_REF, { instanceId: "wf-1", status: "running" });

        expect(get(handle.status)).toBe("running");
        expect(get(handle.thread)).toStrictEqual({ instanceId: "wf-1", status: "running" });

        handle.teardown();

        expect(fake.unsubscribeSpy).toHaveBeenCalledTimes(1);
    });

    it("forwards onError so a thread subscription error reaches the caller", () => {
        // Without an error channel a session expiry left `thread` / `status`
        // frozen at their last value with nothing surfaced.
        const fake = createFakeClient();
        const errors: SubscriptionError[] = [];

        agent(fake.client, {
            api: buildApi(),
            onError: (error) => errors.push(error),
            run: makeRef(RUN_REF) as FunctionReference<"mutation">,
            threadKey: "t1",
        });

        fake.subscribeCalls[0]?.onError?.({ code: "UNAUTHORIZED", message: "session expired" });

        expect(errors).toStrictEqual([{ code: "UNAUTHORIZED", message: "session expired" }]);
    });

    it("fires the run mutation with the input, thread key, and merged run args", async () => {
        const fake = createFakeClient();
        const handle = agent(fake.client, {
            api: buildApi(),
            run: makeRef(RUN_REF) as FunctionReference<"mutation">,
            runArgs: { owner: "u_1" },
            threadKey: "t1",
        });

        await handle.run("hello", { title: "greeting" });

        expect(fake.mutationSpy).toHaveBeenCalledWith(
            expect.objectContaining({ __lunoraRef: RUN_REF }),
            { input: "hello", owner: "u_1", threadKey: "t1", title: "greeting" },
            undefined,
        );

        handle.teardown();
    });

    it("cancel is a no-op when no run is in flight", async () => {
        const fake = createFakeClient();
        const handle = agent(fake.client, {
            api: buildApi(),
            cancel: makeRef(CANCEL_REF) as FunctionReference<"mutation">,
            run: makeRef(RUN_REF) as FunctionReference<"mutation">,
            threadKey: "t1",
        });

        await handle.cancel();

        expect(fake.mutationSpy).not.toHaveBeenCalled();

        handle.teardown();
    });

    it("cancel terminates the in-flight run with the instanceId and thread key", async () => {
        const fake = createFakeClient();
        const handle = agent(fake.client, {
            api: buildApi(),
            cancel: makeRef(CANCEL_REF) as FunctionReference<"mutation">,
            run: makeRef(RUN_REF) as FunctionReference<"mutation">,
            threadKey: "t1",
        });

        fake.push(THREAD_REF, { instanceId: "wf-1", status: "running" });

        await handle.cancel();

        expect(fake.mutationSpy).toHaveBeenCalledWith(expect.objectContaining({ __lunoraRef: CANCEL_REF }), { instanceId: "wf-1", threadKey: "t1" }, undefined);

        handle.teardown();
    });

    it("cancel is a no-op when no cancel mutation was supplied", async () => {
        const fake = createFakeClient();
        const handle = agent(fake.client, { api: buildApi(), run: makeRef(RUN_REF) as FunctionReference<"mutation">, threadKey: "t1" });

        fake.push(THREAD_REF, { instanceId: "wf-1", status: "running" });

        await handle.cancel();

        expect(fake.mutationSpy).not.toHaveBeenCalled();

        handle.teardown();
    });

    it("does not open the thread subscription during SSR (no window) (SVELTE-01)", () => {
        const fake = createFakeClient();

        // Simulate the server render: no browser `window` (this package pairs
        // with `@lunora/nuxt`'s server rendering, where a component's init runs
        // inside `renderToString` with no `window`). Opening a live WS
        // subscription there fires during `renderToString` with no
        // corresponding `onDestroy` to close it — every server render would
        // leak a subscription.
        Reflect.deleteProperty(globalThis, "window");

        const handle = agent(fake.client, {
            api: buildApi(),
            cancel: makeRef(CANCEL_REF) as FunctionReference<"mutation">,
            run: makeRef(RUN_REF) as FunctionReference<"mutation">,
            threadKey: "t1",
        });

        expect(fake.subscribeCalls).toHaveLength(0);
        expect(get(handle.status)).toBeUndefined();
        expect(get(handle.thread)).toBeUndefined();

        // Teardown itself must not throw with nothing live to unsubscribe.
        expect(() => {
            handle.teardown();
        }).not.toThrow();
        expect(fake.unsubscribeSpy).not.toHaveBeenCalled();
    });
});
