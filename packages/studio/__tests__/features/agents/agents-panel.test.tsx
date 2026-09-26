import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import AgentsPanel from "../../../src/features/agents/agents-panel";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import { createMockClient } from "../../mock-client";

const messagesOf = (count: number): Record<string, unknown>[] =>
    Array.from({ length: count }, (_, seq) => {
        return { content: `m${String(seq)}`, role: "assistant", seq, threadKey: "t1" };
    });

/** A mock that honours `orderBy.direction` and `limit` on `agent_messages`, like the server does. */
const clientWith = (messages: Record<string, unknown>[]) =>
    createMockClient({
        query: (reference, args): unknown => {
            if (reference === ADMIN_FUNCTIONS.listTables) {
                return [{ name: "agent_threads" }, { name: "agent_messages" }];
            }

            const { limit = 50, orderBy, table } = args as { limit?: number; orderBy?: { direction: string }; table: string };

            if (table === "agent_threads") {
                return { columns: [], rows: [{ key: "t1", status: "running", updatedAt: 1 }], total: 1 };
            }

            if (table === "agent_messages") {
                return { columns: [], rows: (orderBy?.direction === "desc" ? messages.toReversed() : messages).slice(0, limit) };
            }

            return { columns: [], rows: [] };
        },
    });

const shownSeqs = (): number[] => screen.queryAllByTestId(/^agents-message-\d+$/u).map((element) => Number(element.dataset["testid"]?.split("-").at(-1)));

describe("agentsPanel — timeline of a long thread", () => {
    it("shows the newest messages in order, with a notice that older ones were cut", async () => {
        expect.hasAssertions();

        render(
            <LunoraProvider client={clientWith(messagesOf(300)).asClient}>
                <AgentsPanel />
            </LunoraProvider>,
        );

        fireEvent.click(await screen.findByTestId("agents-thread-open-t1"));
        await waitFor(() => {
            expect(shownSeqs()).toHaveLength(250);
        });

        const seqs = shownSeqs();

        expect([seqs[0], seqs.at(-1)]).toStrictEqual([50, 299]);
        expect(screen.getByTestId("agents-messages-truncated").textContent).toContain("250");
    });

    it("shows no notice when the whole thread fits", async () => {
        expect.hasAssertions();

        render(
            <LunoraProvider client={clientWith(messagesOf(3)).asClient}>
                <AgentsPanel />
            </LunoraProvider>,
        );

        fireEvent.click(await screen.findByTestId("agents-thread-open-t1"));
        await waitFor(() => {
            expect(shownSeqs()).toStrictEqual([0, 1, 2]);
        });

        expect(screen.queryByTestId("agents-messages-truncated")).toBeNull();
    });
});
