import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import QueuesPanel from "../../../src/features/queues/queues-panel";
import type { QueueMessageRow, QueueMetadata, QueuesResult, ReplayQueueMessageResult } from "../../../src/lib/admin";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const renderPanel = (mock: MockClientHooks): ReactElement => (
    <LunoraProvider client={mock.asClient}>
        <QueuesPanel />
    </LunoraProvider>
);

const oneQueue: QueueMetadata = { binding: "EMAIL_QUEUE", exportName: "sendWelcome", mode: "push", name: "emails" };

const message = (overrides: Partial<QueueMessageRow> = {}): QueueMessageRow => {
    return {
        attempts: 1,
        body: { hello: "world" },
        capturedAt: 1_700_000_000_000,
        deadLettered: false,
        exportName: "sendWelcome",
        id: "msg-1",
        messageId: "cf-1",
        outcome: "ack",
        queue: "emails",
        timestamp: 1_700_000_000_000,
        ...overrides,
    };
};

describe("queuesPanel", () => {
    it("loads the declared queues on the default tab", async () => {
        expect.assertions(1);

        const mock = createMockClient({
            query: (reference): unknown => {
                if (reference === ADMIN_FUNCTIONS.listQueues) {
                    return { queues: [oneQueue] } satisfies QueuesResult;
                }

                if (reference === ADMIN_FUNCTIONS.getQueueMessages) {
                    return { entries: [] };
                }

                throw new Error(`unexpected ${reference}`);
            },
        });

        render(renderPanel(mock));

        await screen.findByTestId("queues-row-sendWelcome");

        expect(screen.getByTestId("queues-row-sendWelcome").textContent).toContain("emails");
    });

    it("replays a message: sends the id, and refetches the log", async () => {
        expect.hasAssertions();

        let replayedId: string | undefined;
        let messagesReadCount = 0;

        const mock = createMockClient({
            query: (reference, args): unknown => {
                if (reference === ADMIN_FUNCTIONS.listQueues) {
                    return { queues: [oneQueue] } satisfies QueuesResult;
                }

                if (reference === ADMIN_FUNCTIONS.getQueueMessages) {
                    messagesReadCount += 1;

                    return { entries: [message()] };
                }

                if (reference === ADMIN_FUNCTIONS.replayQueueMessage) {
                    replayedId = (args as { id: string }).id;

                    return { sent: 1, target: "emails" } satisfies ReplayQueueMessageResult;
                }

                throw new Error(`unexpected ${reference}`);
            },
        });

        render(renderPanel(mock));

        fireEvent.click(screen.getByTestId("queues-tab-messages"));

        await screen.findByTestId("queues-message-msg-1");

        const readsBeforeReplay = messagesReadCount;

        fireEvent.click(screen.getByTestId("queues-replay-msg-1"));

        await waitFor(() => {
            expect(messagesReadCount).toBeGreaterThan(readsBeforeReplay);
        });

        expect(replayedId).toBe("msg-1");
        expect(screen.queryByTestId("queues-error")).toBeNull();
    });

    it("surfaces a rejected replay in the panel's error surface", async () => {
        expect.assertions(1);

        const mock = createMockClient({
            query: (reference): unknown => {
                if (reference === ADMIN_FUNCTIONS.listQueues) {
                    return { queues: [oneQueue] } satisfies QueuesResult;
                }

                if (reference === ADMIN_FUNCTIONS.getQueueMessages) {
                    return { entries: [message()] };
                }

                if (reference === ADMIN_FUNCTIONS.replayQueueMessage) {
                    throw new Error("QUEUE_REPLAY_FAILED");
                }

                throw new Error(`unexpected ${reference}`);
            },
        });

        render(renderPanel(mock));

        fireEvent.click(screen.getByTestId("queues-tab-messages"));

        await screen.findByTestId("queues-message-msg-1");

        fireEvent.click(screen.getByTestId("queues-replay-msg-1"));

        await screen.findByTestId("queues-error");

        expect(screen.getByTestId("queues-error").textContent).toContain("QUEUE_REPLAY_FAILED");
    });

    // Every other destructive action in the studio (storage delete, migrations,
    // export/import, PITR restore, …) is gated behind the shared `ConfirmButton`
    // component before it fires. `clearQueueMessages` is not: the "Clear log"
    // button in queues-panel.tsx wires straight to `onClear` with no confirm
    // step, so a single click irreversibly wipes the dev consumed-message log.
    // This test pins that CURRENT behaviour rather than the gated behaviour the
    // rest of the studio's destructive actions have — it is a real gap, not a
    // desired contract, and is flagged as a finding rather than "fixed" here.
    it("clears the log on a single click, with no confirmation gate (flagged: unlike every sibling destructive action)", async () => {
        expect.hasAssertions();

        let cleared = false;

        const mock = createMockClient({
            query: (reference): unknown => {
                if (reference === ADMIN_FUNCTIONS.listQueues) {
                    return { queues: [oneQueue] } satisfies QueuesResult;
                }

                if (reference === ADMIN_FUNCTIONS.getQueueMessages) {
                    return { entries: cleared ? [] : [message()] };
                }

                if (reference === ADMIN_FUNCTIONS.clearQueueMessages) {
                    cleared = true;

                    return { cleared: true };
                }

                throw new Error(`unexpected ${reference}`);
            },
        });

        render(renderPanel(mock));

        fireEvent.click(screen.getByTestId("queues-tab-messages"));

        await screen.findByTestId("queues-message-msg-1");

        // No intermediate confirm affordance exists to assert against — the
        // click below is the entire interaction.
        fireEvent.click(screen.getByTestId("queues-clear"));

        await waitFor(() => {
            expect(cleared).toBe(true);
        });

        await waitFor(() => {
            expect(screen.queryByTestId("queues-message-msg-1")).toBeNull();
        });
    });
});
