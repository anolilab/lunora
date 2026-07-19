import type { FunctionReference, LunoraClient } from "@lunora/client";
import { get } from "svelte/store";
import { describe, expect, it, vi } from "vitest";

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

    const subscribe = vi.fn<(function_: FunctionReference, args: SubscribeCall["args"], callback: (value: unknown) => void) => () => void>(
        (function_, args, callback) => {
            subscribeCalls.push({ args, callback, functionPath: function_["__lunoraRef"] });

            return unsubscribeSpy;
        },
    );

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

describe(agent, () => {
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
});
