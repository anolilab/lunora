import type { FunctionReference } from "@lunora/client";
import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";

import type { CreateAgentApi, CreateAgentResult } from "../src/create-agent";
import { createAgent } from "../src/create-agent";
import { LunoraProvider } from "../src/lunora-provider";
import { createFakeClient } from "./fake-client";

const makeRef = (reference: string): FunctionReference => {
    return { __lunoraRef: reference };
};

const THREAD_REF = "agents:agentThread";
const RUN_REF = "chat:startRun";
const CANCEL_REF = "chat:cancelRun";

const buildApi = (): CreateAgentApi =>
    ({
        agents: {
            agentThread: makeRef(THREAD_REF),
        },
    }) as unknown as CreateAgentApi;

const pushTo = (subscriptions: { functionPath: string; push: (value: unknown) => void }[], reference: string, value: unknown): void => {
    subscriptions.find((sub) => sub.functionPath === reference)?.push(value);
};

describe(createAgent, () => {
    it("subscribes to the thread channel and flows live status through", () => {
        const fake = createFakeClient();
        let latest: CreateAgentResult | undefined;

        render(
            () => {
                latest = createAgent({
                    api: buildApi(),
                    cancel: makeRef(CANCEL_REF) as FunctionReference<"mutation">,
                    run: makeRef(RUN_REF) as FunctionReference<"mutation">,
                    threadKey: "t1",
                });

                return <pre>{String(latest.status())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        expect(fake.subscriptions.map((sub) => sub.functionPath)).toStrictEqual([THREAD_REF]);
        expect(latest?.status()).toBeUndefined();

        pushTo(fake.subscriptions, THREAD_REF, { instanceId: "wf-1", status: "running" });

        expect(latest?.status()).toBe("running");
        expect(latest?.thread()).toStrictEqual({ instanceId: "wf-1", status: "running" });
    });

    it("fires the run mutation with the input, thread key, and merged run args", async () => {
        const fake = createFakeClient();
        let latest: CreateAgentResult | undefined;

        render(
            () => {
                latest = createAgent({
                    api: buildApi(),
                    run: makeRef(RUN_REF) as FunctionReference<"mutation">,
                    runArgs: { owner: "u_1" },
                    threadKey: "t1",
                });

                return <pre>{String(latest.status())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        await latest?.run("hello", { title: "greeting" });

        expect(fake.mutationCalls).toContainEqual({
            args: { input: "hello", owner: "u_1", threadKey: "t1", title: "greeting" },
            functionPath: RUN_REF,
        });
    });

    it("cancel is a no-op when no run is in flight", async () => {
        const fake = createFakeClient();
        let latest: CreateAgentResult | undefined;

        render(
            () => {
                latest = createAgent({
                    api: buildApi(),
                    cancel: makeRef(CANCEL_REF) as FunctionReference<"mutation">,
                    run: makeRef(RUN_REF) as FunctionReference<"mutation">,
                    threadKey: "t1",
                });

                return <pre>{String(latest.status())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        await latest?.cancel();

        expect(fake.mutationCalls).toStrictEqual([]);
    });

    it("cancel terminates the in-flight run with the instanceId and thread key", async () => {
        const fake = createFakeClient();
        let latest: CreateAgentResult | undefined;

        render(
            () => {
                latest = createAgent({
                    api: buildApi(),
                    cancel: makeRef(CANCEL_REF) as FunctionReference<"mutation">,
                    run: makeRef(RUN_REF) as FunctionReference<"mutation">,
                    threadKey: "t1",
                });

                return <pre>{String(latest.status())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        pushTo(fake.subscriptions, THREAD_REF, { instanceId: "wf-1", status: "running" });

        await latest?.cancel();

        expect(fake.mutationCalls).toContainEqual({ args: { instanceId: "wf-1", threadKey: "t1" }, functionPath: CANCEL_REF });
    });

    it("cancel is a no-op when no cancel mutation was supplied", async () => {
        const fake = createFakeClient();
        let latest: CreateAgentResult | undefined;

        render(
            () => {
                latest = createAgent({ api: buildApi(), run: makeRef(RUN_REF) as FunctionReference<"mutation">, threadKey: "t1" });

                return <pre>{String(latest.status())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        pushTo(fake.subscriptions, THREAD_REF, { instanceId: "wf-1", status: "running" });

        await latest?.cancel();

        expect(fake.mutationCalls).toStrictEqual([]);
    });
});
