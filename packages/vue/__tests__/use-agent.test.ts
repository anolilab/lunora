import type { FunctionReference } from "@lunora/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { effectScope, nextTick } from "vue";

import type { UseAgentApi, UseAgentResult } from "../src/use-agent";
import { useAgent } from "../src/use-agent";
import { createFakeClient } from "./fake-client";

const makeRef = (reference: string): FunctionReference => {
    return { __lunoraRef: reference };
};

const THREAD_REF = "agents:agentThread";
const RUN_REF = "chat:startRun";
const CANCEL_REF = "chat:cancelRun";

const buildApi = (): UseAgentApi =>
    ({
        agents: {
            agentThread: makeRef(THREAD_REF),
        },
    }) as unknown as UseAgentApi;

describe(useAgent, () => {
    // `useAgent` is built on `useSubscription`, which gates its subscription on
    // a browser `window` (SSR guard); the vitest env is `node` (no `window`),
    // so define one for these client-path tests. The dedicated SSR test below
    // removes it to exercise the guard, mirroring `@lunora/vue`'s
    // `use-presence.test.ts`.
    beforeEach(() => {
        Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    });

    afterEach(() => {
        Reflect.deleteProperty(globalThis, "window");
    });

    it("subscribes to the thread channel and flows live status through", () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const scope = effectScope();
        const agent = scope.run(() =>
            fake.provide((): UseAgentResult =>
                useAgent({
                    api: buildApi(),
                    cancel: makeRef(CANCEL_REF) as FunctionReference<"mutation">,
                    run: makeRef(RUN_REF) as FunctionReference<"mutation">,
                    threadKey: "t1",
                }),
            ),
        )!;

        expect(fake.subscribeCalls.map((call) => call.functionPath)).toStrictEqual([THREAD_REF]);
        expect(agent.status.value).toBeUndefined();

        fake.push(THREAD_REF, { key: "t1" }, { instanceId: "wf-1", status: "running" });

        expect(agent.status.value).toBe("running");
        expect(agent.thread.value).toStrictEqual({ instanceId: "wf-1", status: "running" });

        scope.stop();
    });

    it("fires the run mutation with the input, thread key, and merged run args", async () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const scope = effectScope();
        const agent = scope.run(() =>
            fake.provide((): UseAgentResult =>
                useAgent({
                    api: buildApi(),
                    run: makeRef(RUN_REF) as FunctionReference<"mutation">,
                    runArgs: { owner: "u_1" },
                    threadKey: "t1",
                }),
            ),
        )!;

        await agent.run("hello", { title: "greeting" });

        expect(fake.mutationSpy).toHaveBeenCalledWith(
            expect.objectContaining({ __lunoraRef: RUN_REF }),
            { input: "hello", owner: "u_1", threadKey: "t1", title: "greeting" },
            undefined,
        );

        scope.stop();
    });

    it("reflects the in-flight run through the pending ref", async () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        let release: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        // The mutation stays pending until `release()` so we can observe the
        // `pending` ref flip true mid-flight, then settle false once it resolves.
        // eslint-disable-next-line @typescript-eslint/no-misused-promises -- the spy's default signature is void-returning; a deferred promise is exactly the intent here.
        fake.mutationSpy.mockImplementation(() => gate);

        const scope = effectScope();
        const agent = scope.run(() =>
            fake.provide((): UseAgentResult => useAgent({ api: buildApi(), run: makeRef(RUN_REF) as FunctionReference<"mutation">, threadKey: "t1" })),
        )!;

        expect(agent.pending.value).toBe(false);

        const pending = agent.run("hi");

        await nextTick();

        expect(agent.pending.value).toBe(true);

        release?.();
        await pending;
        await nextTick();

        expect(agent.pending.value).toBe(false);

        scope.stop();
    });

    it("cancel is a no-op when no run is in flight", async () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const scope = effectScope();
        const agent = scope.run(() =>
            fake.provide((): UseAgentResult =>
                useAgent({
                    api: buildApi(),
                    cancel: makeRef(CANCEL_REF) as FunctionReference<"mutation">,
                    run: makeRef(RUN_REF) as FunctionReference<"mutation">,
                    threadKey: "t1",
                }),
            ),
        )!;

        await agent.cancel();

        expect(fake.mutationSpy).not.toHaveBeenCalled();

        scope.stop();
    });

    it("cancel terminates the in-flight run with the instanceId and thread key", async () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const scope = effectScope();
        const agent = scope.run(() =>
            fake.provide((): UseAgentResult =>
                useAgent({
                    api: buildApi(),
                    cancel: makeRef(CANCEL_REF) as FunctionReference<"mutation">,
                    run: makeRef(RUN_REF) as FunctionReference<"mutation">,
                    threadKey: "t1",
                }),
            ),
        )!;

        fake.push(THREAD_REF, { key: "t1" }, { instanceId: "wf-1", status: "running" });

        await agent.cancel();

        expect(fake.mutationSpy).toHaveBeenCalledWith(expect.objectContaining({ __lunoraRef: CANCEL_REF }), { instanceId: "wf-1", threadKey: "t1" }, undefined);

        scope.stop();
    });

    it("cancel is a no-op when no cancel mutation was supplied", async () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const scope = effectScope();
        const agent = scope.run(() =>
            fake.provide((): UseAgentResult => useAgent({ api: buildApi(), run: makeRef(RUN_REF) as FunctionReference<"mutation">, threadKey: "t1" })),
        )!;

        fake.push(THREAD_REF, { key: "t1" }, { instanceId: "wf-1", status: "running" });

        await agent.cancel();

        expect(fake.mutationSpy).not.toHaveBeenCalled();

        scope.stop();
    });

    // A session expiry or RLS denial on the thread/history subscription used to be
    // dropped: `status` simply froze with nothing to read and no handler to call.
    // Matches React's `useAgent` / `useAgentChat` error channel.
    it("surfaces a thread subscription error on `error` and through `onError`", () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const seen: { code?: string; message: string }[] = [];
        const scope = effectScope();
        const agent = scope.run(() =>
            fake.provide((): UseAgentResult =>
                useAgent({
                    api: buildApi(),
                    onError: (subscriptionError) => seen.push(subscriptionError),
                    run: makeRef(RUN_REF) as FunctionReference<"mutation">,
                    threadKey: "t1",
                }),
            ),
        )!;

        fake.subscribeCalls[0]?.options.onError?.({ code: "FORBIDDEN", message: "denied" });

        expect(agent.error.value?.message).toBe("denied");
        expect(seen).toStrictEqual([{ code: "FORBIDDEN", message: "denied" }]);

        scope.stop();
    });
});
