import type { FunctionReference } from "@lunora/client";
import { get } from "svelte/store";
import { describe, expect, it } from "vitest";

import type { AgentStateApi } from "../src/agent-state";
import { agentState } from "../src/agent-state";
import { createFakeClient } from "./fake-client";

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
    it("subscribes to agents.agentState under the thread key and is undefined before the first frame", () => {
        const fake = createFakeClient();
        const handle = agentState(fake.client, { api: buildApi(), threadKey: "t1" });

        // The `state` store is lazy — the subscription opens on its first subscriber.
        const stop = handle.state.subscribe(() => {});

        expect(fake.subscribeCalls.map((call) => call.functionPath)).toStrictEqual([STATE_REF]);
        expect(fake.subscribeCalls[0]?.args).toStrictEqual({ key: "t1" });
        expect(get(handle.state)).toBeUndefined();
        expect(get(handle.error)).toBeUndefined();

        // Dropping the last subscriber tears the underlying subscription down.
        stop();

        expect(fake.unsubscribeSpy).toHaveBeenCalledTimes(1);
    });

    it("flows the live synced state through the subscription and reflects later absolute frames", () => {
        const fake = createFakeClient();
        const handle = agentState<SupportState>(fake.client, { api: buildApi(), threadKey: "t1" });

        const stop = handle.state.subscribe(() => {});

        fake.push(STATE_REF, { plan: ["research"], step: 1 });

        expect(get(handle.state)).toStrictEqual({ plan: ["research"], step: 1 });

        // A later setState pushes a fresh absolute frame — the handle reflects it wholesale.
        fake.push(STATE_REF, { plan: ["research", "draft"], step: 2 });

        expect(get(handle.state)).toStrictEqual({ plan: ["research", "draft"], step: 2 });

        stop();
    });
});
