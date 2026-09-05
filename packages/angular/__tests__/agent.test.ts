import type { FunctionReference } from "@lunora/client";
import { describe, expect, it } from "vitest";

import type { AgentApi, AgentResult } from "../src/agent";
import { agent } from "../src/agent";
import { createFakeClient, createFakeDestroyRef } from "./fake-client";

const makeRef = (reference: string): FunctionReference => {
    return { __lunoraRef: reference };
};

const THREAD_REF = "agents:agentThread";
const RUN_REF = "chat:startRun";
const CANCEL_REF = "chat:cancelRun";

const buildApi = (): AgentApi =>
    ({
        agents: {
            agentThread: makeRef(THREAD_REF),
        },
    }) as unknown as AgentApi;

describe(agent, () => {
    it("subscribes to the thread channel and flows live status through", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const result: AgentResult = agent({
            api: buildApi(),
            cancel: makeRef(CANCEL_REF) as FunctionReference<"mutation">,
            client: fake.asClient,
            destroyRef: destroy.asDestroyRef,
            run: makeRef(RUN_REF) as FunctionReference<"mutation">,
            threadKey: "t1",
        });

        expect(fake.subscriptions.map((sub) => sub.functionPath)).toStrictEqual([THREAD_REF]);
        expect(result.status()).toBeUndefined();

        fake.push(THREAD_REF, { key: "t1" }, { instanceId: "wf-1", status: "running" });

        expect(result.status()).toBe("running");
        expect(result.thread()).toStrictEqual({ instanceId: "wf-1", status: "running" });

        destroy.destroy();
    });

    it("fires the run mutation with the input, thread key, and merged run args", async () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const result: AgentResult = agent({
            api: buildApi(),
            client: fake.asClient,
            destroyRef: destroy.asDestroyRef,
            run: makeRef(RUN_REF) as FunctionReference<"mutation">,
            runArgs: { owner: "u_1" },
            threadKey: "t1",
        });

        await result.run("hello", { title: "greeting" });

        expect(fake.mutationCalls).toContainEqual({
            args: { input: "hello", owner: "u_1", threadKey: "t1", title: "greeting" },
            functionPath: RUN_REF,
            options: undefined,
        });

        destroy.destroy();
    });

    it("reflects the in-flight run through the pending signal", async () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        let release: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        // The mutation stays pending until `release()` so we can observe the
        // `pending` signal flip true mid-flight, then settle false once it resolves.
        fake.setMutationResult(gate);

        const result: AgentResult = agent({
            api: buildApi(),
            client: fake.asClient,
            destroyRef: destroy.asDestroyRef,
            run: makeRef(RUN_REF) as FunctionReference<"mutation">,
            threadKey: "t1",
        });

        expect(result.pending()).toBe(false);

        const pending = result.run("hi");

        // `run` flips `pending` synchronously before its first `await`.
        expect(result.pending()).toBe(true);

        release?.();
        await pending;

        expect(result.pending()).toBe(false);

        destroy.destroy();
    });

    it("cancel is a no-op when no run is in flight", async () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const result: AgentResult = agent({
            api: buildApi(),
            cancel: makeRef(CANCEL_REF) as FunctionReference<"mutation">,
            client: fake.asClient,
            destroyRef: destroy.asDestroyRef,
            run: makeRef(RUN_REF) as FunctionReference<"mutation">,
            threadKey: "t1",
        });

        await result.cancel();

        expect(fake.mutationCalls).toHaveLength(0);

        destroy.destroy();
    });

    it("cancel terminates the in-flight run with the instanceId and thread key", async () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const result: AgentResult = agent({
            api: buildApi(),
            cancel: makeRef(CANCEL_REF) as FunctionReference<"mutation">,
            client: fake.asClient,
            destroyRef: destroy.asDestroyRef,
            run: makeRef(RUN_REF) as FunctionReference<"mutation">,
            threadKey: "t1",
        });

        fake.push(THREAD_REF, { key: "t1" }, { instanceId: "wf-1", status: "running" });

        await result.cancel();

        expect(fake.mutationCalls).toContainEqual({ args: { instanceId: "wf-1", threadKey: "t1" }, functionPath: CANCEL_REF, options: undefined });

        destroy.destroy();
    });

    it("cancel is a no-op when no cancel mutation was supplied", async () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const result: AgentResult = agent({
            api: buildApi(),
            client: fake.asClient,
            destroyRef: destroy.asDestroyRef,
            run: makeRef(RUN_REF) as FunctionReference<"mutation">,
            threadKey: "t1",
        });

        fake.push(THREAD_REF, { key: "t1" }, { instanceId: "wf-1", status: "running" });

        await result.cancel();

        expect(fake.mutationCalls).toHaveLength(0);

        destroy.destroy();
    });

    // A session expiry or RLS denial on the thread/history subscription used to be
    // dropped: `status` simply froze with nothing to read and no handler to call.
    // Matches React's `useAgent` / `useAgentChat` error channel.
    it("surfaces a thread subscription error on `error` and through `onError`", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();
        const seen: { code?: string; message: string }[] = [];

        const result: AgentResult = agent({
            api: buildApi(),
            client: fake.asClient,
            destroyRef: destroy.asDestroyRef,
            onError: (subscriptionError) => seen.push(subscriptionError),
            run: makeRef(RUN_REF) as FunctionReference<"mutation">,
            threadKey: "t1",
        });

        fake.subscriptions[0]?.emitError({ code: "FORBIDDEN", message: "denied" });

        expect(result.error()?.message).toBe("denied");
        expect(seen).toStrictEqual([{ code: "FORBIDDEN", message: "denied" }]);

        destroy.destroy();
    });
});
