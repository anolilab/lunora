import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { SqlEditorPanel } from "../../../src/features/sql/sql-editor-panel";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const renderPanel = (mock: MockClientHooks): ReactElement => (
    <LunoraProvider client={mock.asClient}>
        <SqlEditorPanel />
    </LunoraProvider>
);

/** A mock whose `aiChat` answers `reply`, with the AI binding reported present. */
const chatMock = (reply: string, available = true): MockClientHooks =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.aiAvailable) {
                return { available };
            }

            if (reference === ADMIN_FUNCTIONS.aiChat) {
                return { degraded: false, partial: false, reply, toolCalls: [], truncated: false };
            }

            if (reference === ADMIN_FUNCTIONS.listTables) {
                return [{ name: "messages", rowCount: 0 }];
            }

            return { columns: [], rowCount: 0, rows: [], truncated: false };
        },
    });

/** Open the assistant, which is closed until the operator asks for it. */
const openChat = async (): Promise<HTMLElement> => {
    fireEvent.click(await screen.findByTestId("sql-chat-toggle"));

    return screen.findByTestId("sql-chat");
};

const ask = (question: string): void => {
    fireEvent.change(screen.getByTestId("sql-chat-input"), { target: { value: question } });
    fireEvent.click(screen.getByTestId("sql-chat-send"));
};

describe("sqlChatPanel", () => {
    afterEach(() => {
        localStorage.clear();
        sessionStorage.clear();
    });

    it("does not render at all when the app has no AI binding", async () => {
        expect.hasAssertions();

        render(renderPanel(chatMock("unused", false)));

        // The latch the other assistant affordances use: a surface that can only
        // fail is worse than no surface. The TOGGLE is what must be absent — the
        // panel itself is closed by default, so asserting on it would pass even
        // with the latch broken.
        await screen.findByTestId("lunora-sql-editor");

        await waitFor(() => {
            expect(screen.queryByTestId("sql-chat-toggle")).toBeNull();
        });
    });

    it("offers a reply's SQL for insertion, and never runs it", async () => {
        expect.hasAssertions();

        const mock = chatMock("Try this:\n```sql\nSELECT count(*) FROM messages\n```");

        render(renderPanel(mock));
        await openChat();

        ask("how many messages?");

        const insert = await screen.findByTestId("sql-chat-insert");

        // Nothing ran on the way here — the reply is prose until the operator acts.
        expect(mock.query.mock.calls.some((call) => call[0].__lunoraRef === ADMIN_FUNCTIONS.runSql)).toBe(false);

        fireEvent.click(insert);

        // It lands in the editor, still unexecuted: the operator presses Run, as
        // with anything they typed.
        await waitFor(() => {
            expect(screen.getByTestId<HTMLTextAreaElement>("sql-input").value).toBe("SELECT count(*) FROM messages");
        });

        expect(mock.query.mock.calls.some((call) => call[0].__lunoraRef === ADMIN_FUNCTIONS.runSql)).toBe(false);
    });

    it("offers nothing to insert when the reply carries no fenced SQL", async () => {
        expect.assertions(1);

        // A looser reading — "any line starting with SELECT" — would offer this
        // prose as a statement.
        render(renderPanel(chatMock("You could SELECT from messages, but I'd check the index first.")));
        await openChat();

        ask("what should I look at?");

        await screen.findByTestId("sql-chat-turn-assistant");

        expect(screen.queryByTestId("sql-chat-insert")).toBeNull();
    });

    it("re-sends the prior turns, so the exchange is a conversation", async () => {
        expect.assertions(2);

        const mock = chatMock("Sure.");

        render(renderPanel(mock));
        await openChat();

        ask("first question");
        await screen.findByTestId("sql-chat-turn-assistant");

        ask("second question");

        await waitFor(() => {
            const chats = mock.query.mock.calls.filter((call) => call[0].__lunoraRef === ADMIN_FUNCTIONS.aiChat);

            expect(chats).toHaveLength(2);

            // The second call carries the first exchange; the server caps and
            // fences it, but the client is what holds it.
            const second = chats[1]?.[1] as { transcript: { text: string }[] };

            expect(second.transcript.map((turn) => turn.text)).toStrictEqual(["first question", "Sure."]);
        });
    });

    it("sends the console's schema and shard, so the turn is grounded and reads the right shard", async () => {
        expect.hasAssertions();

        const mock = chatMock("Sure.");

        render(renderPanel(mock));
        await openChat();

        ask("what tables do I have?");

        await waitFor(() => {
            const [, args] = mock.query.mock.calls.find((call) => call[0].__lunoraRef === ADMIN_FUNCTIONS.aiChat) ?? [];

            // Both were missing: `schema: []` was hardcoded and `shardKey` never
            // left the client, so the model was told to use only listed tables and
            // given none, and every tool read went to the root shard whatever the
            // operator had open.
            expect((args as { schema: unknown[] }).schema).toContainEqual({ columns: [], table: "messages" });
            expect(args as Record<string, unknown>).toHaveProperty("shardKey");
        });
    });

    it("stays closed until the operator opens it, and closes again", async () => {
        expect.hasAssertions();

        render(renderPanel(chatMock("Sure.")));
        await screen.findByTestId("sql-chat-toggle");

        // Closed by default: an assistant occupying the console before anyone has
        // asked it anything is a cost every operator pays and few want.
        expect(screen.queryByTestId("sql-chat")).toBeNull();

        await openChat();

        expect(screen.getByTestId("sql-chat")).toBeDefined();

        fireEvent.click(screen.getByTestId("sql-chat-toggle"));

        await waitFor(() => {
            expect(screen.queryByTestId("sql-chat")).toBeNull();
        });
    });

    it("debugs a failed run from the error itself, carrying the statement and the message", async () => {
        expect.hasAssertions();

        const mock = createMockClient({
            query: (reference): unknown => {
                if (reference === ADMIN_FUNCTIONS.aiAvailable) {
                    return { available: true };
                }

                if (reference === ADMIN_FUNCTIONS.aiChat) {
                    return { degraded: false, partial: false, reply: "That column does not exist.", toolCalls: [], truncated: false };
                }

                if (reference === ADMIN_FUNCTIONS.listTables) {
                    return [{ name: "messages", rowCount: 0 }];
                }

                if (reference === ADMIN_FUNCTIONS.runSql) {
                    throw new Error("no such column: bodyy");
                }

                return { columns: [], rowCount: 0, rows: [], truncated: false };
            },
        });

        render(renderPanel(mock));
        await screen.findByTestId("sql-input");

        fireEvent.change(screen.getByTestId("sql-input"), { target: { value: "SELECT bodyy FROM messages" } });
        fireEvent.click(screen.getByTestId("sql-run"));

        // The affordance lives ON the failure. "Fix this" already existed in the
        // prompt bar at the top of the editor — the one place an operator reading
        // an error at the bottom of a full-height editor cannot see it.
        fireEvent.click(await screen.findByTestId("sql-debug-error"));

        // Asserted through the DOM: the question the operator can SEE is the one
        // that was asked, and it does not depend on how the client happens to shape
        // its arguments.
        const asked = await screen.findByTestId("sql-chat-turn-user");

        // Both halves travel, so the answer can explain rather than guess.
        expect(asked.textContent).toContain("SELECT bodyy FROM messages");
        expect(asked.textContent).toContain("no such column: bodyy");

        // …and it opened the assistant to show the answer.
        expect(screen.getByTestId("sql-chat")).toBeDefined();
    });
});
