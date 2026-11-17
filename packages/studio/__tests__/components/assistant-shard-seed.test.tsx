import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { AssistantProvider, useAssistant } from "../../src/components/assistant-provider";
import ErrorAlert from "../../src/components/error-alert";
import { AdvisorView } from "../../src/features/advisors/advisor-view";
import { createMockClient } from "../mock-client";

/** Shows which shard the active session's tools would read. */
const SessionProbe = (): ReactElement => {
    const assistant = useAssistant();
    const session = assistant?.sessions.find((candidate) => candidate.id === assistant.activeId);

    return <span data-testid="session-shard">{session === undefined ? "none" : (session.shardKey ?? "root")}</span>;
};

const withAssistant = (children: ReactElement): ReactElement => (
    <LunoraProvider
        client={
            createMockClient({
                query: () => {
                    return { available: true, level: "schema" };
                },
            }).asClient
        }
    >
        <AssistantProvider>
            {children}
            <SessionProbe />
        </AssistantProvider>
    </LunoraProvider>
);

describe("assistant entry points keep the selected shard", () => {
    it("seeds the advisor finding's chat with the shard the finding came from", async () => {
        expect.assertions(1);

        render(
            withAssistant(
                <AdvisorView
                    rows={[{ description: "slow", entity: "posts", issueType: "filter_without_index", key: "k", level: "error" }]}
                    shardKey="tenant-7"
                    testId="adv"
                />,
            ),
        );

        fireEvent.click(await screen.findByTestId("advisor-ask-assistant"));

        await waitFor(() => {
            expect(screen.getByTestId("session-shard").textContent).toBe("tenant-7");
        });
    });

    it("seeds the error callout's chat with the shard the failed read targeted", async () => {
        expect.assertions(1);

        render(withAssistant(<ErrorAlert error={new Error("boom")} shardKey="tenant-7" />));

        fireEvent.click(await screen.findByTestId("error-ask-assistant"));

        await waitFor(() => {
            expect(screen.getByTestId("session-shard").textContent).toBe("tenant-7");
        });
    });
});
