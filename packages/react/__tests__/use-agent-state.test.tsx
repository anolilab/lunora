import type { FunctionReference } from "@lunora/client";
import { act, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import type { UseAgentStateApi, UseAgentStateOptions, UseAgentStateResult } from "../src/use-agent-state";
import { useAgentState } from "../src/use-agent-state";
import { createMockClient } from "./mock-client";

const makeRef = (reference: string): FunctionReference => {
    return { __lunoraRef: reference };
};

const STATE_REF = "agents:agentState";

interface SupportState extends Record<string, unknown> {
    plan: string[];
    step: number;
}

const buildOptions = (overrides: Partial<UseAgentStateOptions> = {}): UseAgentStateOptions => {
    const api = {
        agents: {
            agentState: makeRef(STATE_REF),
        },
    } as unknown as UseAgentStateApi;

    return {
        api,
        threadKey: "t1",
        ...overrides,
    };
};

interface HarnessProps {
    onReady: (result: UseAgentStateResult<SupportState>) => void;
    options: UseAgentStateOptions;
}

const Harness = ({ onReady, options }: HarnessProps): ReactElement => {
    const result = useAgentState<SupportState>(options);

    // Expose the latest committed result to the test from an effect — invoking a
    // prop callback during render is impure (React may replay/discard renders).
    useEffect(() => {
        onReady(result);
    });

    return <span>{result.state ? String(result.state.step) : ""}</span>;
};

describe("useAgentState", () => {
    it("is undefined before the first state frame arrives", () => {
        expect.hasAssertions();

        const mock = createMockClient();
        let latest: UseAgentStateResult<SupportState> | undefined;

        render(
            <LunoraProvider client={mock.asClient}>
                <Harness
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback; a stable ref adds no value in a one-shot render.
                    onReady={(result) => {
                        latest = result;
                    }}
                    options={buildOptions()}
                />
            </LunoraProvider>,
        );

        expect(latest?.state).toBeUndefined();
        expect(latest?.error).toBeUndefined();
    });

    it("flows the live synced state through the agentState subscription", async () => {
        expect.hasAssertions();

        const mock = createMockClient();
        let latest: UseAgentStateResult<SupportState> | undefined;

        render(
            <LunoraProvider client={mock.asClient}>
                <Harness
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback; a stable ref adds no value in a one-shot render.
                    onReady={(result) => {
                        latest = result;
                    }}
                    options={buildOptions()}
                />
            </LunoraProvider>,
        );

        await act(async () => {
            mock.emit(STATE_REF, { plan: ["research"], step: 1 });
        });

        expect(latest?.state).toStrictEqual({ plan: ["research"], step: 1 });

        // A later setState pushes a fresh absolute frame — the hook reflects it.
        await act(async () => {
            mock.emit(STATE_REF, { plan: ["research", "draft"], step: 2 });
        });

        expect(latest?.state).toStrictEqual({ plan: ["research", "draft"], step: 2 });
    });
});
