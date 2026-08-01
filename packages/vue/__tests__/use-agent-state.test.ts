import type { FunctionReference } from "@lunora/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { effectScope } from "vue";

import type { UseAgentStateApi, UseAgentStateResult } from "../src/use-agent-state";
import { useAgentState } from "../src/use-agent-state";
import { createFakeClient } from "./fake-client";

const makeRef = (reference: string): FunctionReference => {
    return { __lunoraRef: reference };
};

const STATE_REF = "agents:agentState";

interface SupportState extends Record<string, unknown> {
    plan: string[];
    step: number;
}

const buildApi = (): UseAgentStateApi =>
    ({
        agents: {
            agentState: makeRef(STATE_REF),
        },
    }) as unknown as UseAgentStateApi;

describe(useAgentState, () => {
    // `useAgentState` is built on `useSubscription`, which gates its
    // subscription on a browser `window` (SSR guard); the vitest env is
    // `node` (no `window`), so define one for these client-path tests. The
    // dedicated SSR test below removes it to exercise the guard, mirroring
    // `@lunora/vue`'s `use-presence.test.ts`.
    beforeEach(() => {
        Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    });

    afterEach(() => {
        Reflect.deleteProperty(globalThis, "window");
    });

    it("subscribes to agents:agentState and is undefined before the first frame", () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const scope = effectScope();
        const result = scope.run(() =>
            fake.provide((): UseAgentStateResult<SupportState> => useAgentState<SupportState>({ api: buildApi(), threadKey: "t1" })),
        )!;

        expect(fake.subscribeCalls.map((call) => call.functionPath)).toStrictEqual([STATE_REF]);
        expect(fake.subscribeCalls[0]?.args).toStrictEqual({ key: "t1" });
        expect(result.state.value).toBeUndefined();
        expect(result.error.value).toBeUndefined();

        scope.stop();
    });

    it("flows the live synced state through the subscription and reflects later absolute frames", () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const scope = effectScope();
        const result = scope.run(() =>
            fake.provide((): UseAgentStateResult<SupportState> => useAgentState<SupportState>({ api: buildApi(), threadKey: "t1" })),
        )!;

        fake.push(STATE_REF, { key: "t1" }, { plan: ["research"], step: 1 });

        expect(result.state.value).toStrictEqual({ plan: ["research"], step: 1 });

        // A later setState pushes a fresh absolute frame — the composable reflects it.
        fake.push(STATE_REF, { key: "t1" }, { plan: ["research", "draft"], step: 2 });

        expect(result.state.value).toStrictEqual({ plan: ["research", "draft"], step: 2 });

        scope.stop();
    });
});
