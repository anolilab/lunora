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
                return { degraded: false, reply, truncated: false };
            }

            if (reference === ADMIN_FUNCTIONS.listTables) {
                return [{ name: "messages", rowCount: 0 }];
            }

            return { columns: [], rowCount: 0, rows: [], truncated: false };
        },
    });

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
        // fail is worse than no surface.
        await waitFor(() => {
            expect(screen.queryByTestId("sql-chat")).toBeNull();
        });
    });

    it("offers a reply's SQL for insertion, and never runs it", async () => {
        expect.hasAssertions();

        const mock = chatMock("Try this:\n```sql\nSELECT count(*) FROM messages\n```");

        render(renderPanel(mock));
        await screen.findByTestId("sql-chat");

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
        await screen.findByTestId("sql-chat");

        ask("what should I look at?");

        await screen.findByTestId("sql-chat-turn-assistant");

        expect(screen.queryByTestId("sql-chat-insert")).toBeNull();
    });

    it("re-sends the prior turns, so the exchange is a conversation", async () => {
        expect.assertions(2);

        const mock = chatMock("Sure.");

        render(renderPanel(mock));
        await screen.findByTestId("sql-chat");

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
});
