import type { FunctionReference } from "@lunora/client";
import { describe, expect, it } from "vitest";

import type { AgentStateApi, AgentStateResult } from "../src/agent-state";
import { agentState } from "../src/agent-state";
import { createFakeClient, createFakeDestroyRef } from "./fake-client";

const makeRef = (reference: string): FunctionReference => {
    return { __lunoraRef: reference };
};

const STATE_REF = "agents:agentState";

interface SupportState extends Record<string, unknown> {
    plan: string[];
    step: number;
}

const buildApi = (): AgentStateApi =>
    ({
        agents: {
            agentState: makeRef(STATE_REF),
        },
    }) as unknown as AgentStateApi;

describe(agentState, () => {
    it("subscribes to agents:agentState and is undefined before the first frame", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const result: AgentStateResult<SupportState> = agentState<SupportState>({
            api: buildApi(),
            client: fake.asClient,
            destroyRef: destroy.asDestroyRef,
            threadKey: "t1",
        });

        expect(fake.subscriptions.map((sub) => sub.functionPath)).toStrictEqual([STATE_REF]);
        expect(fake.subscriptions[0]?.args).toStrictEqual({ key: "t1" });
        expect(result.state()).toBeUndefined();
        expect(result.error()).toBeUndefined();

        destroy.destroy();
    });

    it("flows the live synced state through the subscription and reflects later absolute frames", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const result: AgentStateResult<SupportState> = agentState<SupportState>({
            api: buildApi(),
            client: fake.asClient,
            destroyRef: destroy.asDestroyRef,
            threadKey: "t1",
        });

        fake.push(STATE_REF, { key: "t1" }, { plan: ["research"], step: 1 });

        expect(result.state()).toStrictEqual({ plan: ["research"], step: 1 });

        // A later setState pushes a fresh absolute frame — the primitive reflects it.
        fake.push(STATE_REF, { key: "t1" }, { plan: ["research", "draft"], step: 2 });

        expect(result.state()).toStrictEqual({ plan: ["research", "draft"], step: 2 });

        destroy.destroy();
    });
});
