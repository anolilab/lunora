import type { FunctionReference } from "@lunora/client";
import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";

import type { CreateAgentStateApi, CreateAgentStateResult } from "../src/create-agent-state";
import { createAgentState } from "../src/create-agent-state";
import { LunoraProvider } from "../src/lunora-provider";
import { createFakeClient } from "./fake-client";

const makeRef = (reference: string): FunctionReference => {
    return { __lunoraRef: reference };
};

const STATE_REF = "agents:agentState";

interface SupportState extends Record<string, unknown> {
    plan: string[];
    step: number;
}

const buildApi = (): CreateAgentStateApi =>
    ({
        agents: {
            agentState: makeRef(STATE_REF),
        },
    }) as unknown as CreateAgentStateApi;

const pushTo = (subscriptions: { functionPath: string; push: (value: unknown) => void }[], reference: string, value: unknown): void => {
    subscriptions.find((sub) => sub.functionPath === reference)?.push(value);
};

describe(createAgentState, () => {
    it("subscribes to agents:agentState and is undefined before the first frame", () => {
        const fake = createFakeClient();
        let latest: CreateAgentStateResult<SupportState> | undefined;

        render(
            () => {
                latest = createAgentState<SupportState>({ api: buildApi(), threadKey: "t1" });

                return <pre>{JSON.stringify(latest.state())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        expect(fake.subscriptions.map((sub) => sub.functionPath)).toStrictEqual([STATE_REF]);
        expect(fake.subscriptions[0]?.args).toStrictEqual({ key: "t1" });
        expect(latest?.state()).toBeUndefined();
        expect(latest?.error()).toBeUndefined();
    });

    it("flows the live synced state through the subscription and reflects later absolute frames", () => {
        const fake = createFakeClient();
        let latest: CreateAgentStateResult<SupportState> | undefined;

        render(
            () => {
                latest = createAgentState<SupportState>({ api: buildApi(), threadKey: "t1" });

                return <pre>{JSON.stringify(latest.state())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        pushTo(fake.subscriptions, STATE_REF, { plan: ["research"], step: 1 });

        expect(latest?.state()).toStrictEqual({ plan: ["research"], step: 1 });

        // A later setState pushes a fresh absolute frame — the primitive reflects it.
        pushTo(fake.subscriptions, STATE_REF, { plan: ["research", "draft"], step: 2 });

        expect(latest?.state()).toStrictEqual({ plan: ["research", "draft"], step: 2 });
    });
});
