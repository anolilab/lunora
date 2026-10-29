import type { FunctionReference } from "@lunora/client";
import { act, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import type { UseAgentApprovalsApi, UseAgentApprovalsResult } from "../src/use-agent-approvals";
import { useAgentApprovals } from "../src/use-agent-approvals";
import { createMockClient } from "./mock-client";

const INBOX_REF = "agents:agentPendingApprovals";

const api = {
    agents: {
        agentPendingApprovals: { __lunoraRef: INBOX_REF } as FunctionReference,
    },
} as unknown as UseAgentApprovalsApi;

interface HarnessProps {
    onReady: (result: UseAgentApprovalsResult) => void;
}

const Harness = ({ onReady }: HarnessProps): ReactElement => {
    const result = useAgentApprovals({ api });

    // Surface the committed result from an effect; invoking a prop callback during render is impure.
    useEffect(() => {
        // eslint-disable-next-line react-you-might-not-need-an-effect/no-pass-data-to-parent -- test harness: the hook must run inside a component, so the effect is the only channel to surface its result to the test.
        onReady(result);
    });

    return <span>{result.approvals?.length ?? 0}</span>;
};

describe("useAgentApprovals", () => {
    it("is undefined before the first frame, then mirrors the pushed inbox", async () => {
        expect.hasAssertions();

        const mock = createMockClient();
        let latest: UseAgentApprovalsResult | undefined;

        render(
            <LunoraProvider client={mock.asClient}>
                <Harness
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback; a stable ref adds no value in a one-shot render.
                    onReady={(result) => {
                        latest = result;
                    }}
                />
            </LunoraProvider>,
        );

        expect(latest?.approvals).toBeUndefined();

        await act(async () => {
            mock.emit(INBOX_REF, [
                {
                    agent: "support",
                    content: "Awaiting approval",
                    instanceId: "wf-1",
                    requestedAt: 1,
                    threadKey: "t-1",
                    threadUpdatedAt: 2,
                    toolCallId: "call_1",
                },
            ]);
        });

        expect(latest?.approvals?.map((item) => item.toolCallId)).toStrictEqual(["call_1"]);
        expect(latest?.error).toBeUndefined();
    });
});
