import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { AssistantProvider, useAssistant } from "../../../src/components/assistant-provider";
import AssistantPanel from "../../../src/features/assistant/assistant-panel";
import { SqlEditorPanel } from "../../../src/features/sql/sql-editor-panel";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

/**
 * The shell, in miniature: the provider above, the console as a page, and the
 * panel docked beside it — which is exactly how `StudioLayoutShell` composes
 * them. Rendering the console alone would no longer show an assistant at all,
 * because it does not own one any more.
 */
const Shell = ({ console_ = true }: { readonly console_?: boolean }): ReactElement => {
    const assistant = useAssistant();

    return (
        <>
            {/* `console_` off stands in for navigating to another page: the routed
                panel unmounts, the provider and the docked assistant do not. */}
            {console_ && <SqlEditorPanel />}
            {assistant === undefined ? null : <AssistantPanel assistant={assistant} />}
        </>
    );
};

const renderPanel = (mock: MockClientHooks): ReactElement => (
    <LunoraProvider client={mock.asClient}>
        <AssistantProvider>
            <Shell />
        </AssistantProvider>
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

    return screen.findByTestId("assistant-panel");
};

const ask = (question: string): void => {
    fireEvent.change(screen.getByTestId("assistant-input"), { target: { value: question } });
    fireEvent.click(screen.getByTestId("assistant-send"));
};

describe("assistantPanel", () => {
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

        const insert = await screen.findByTestId("assistant-insert");

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

        await screen.findByTestId("assistant-turn-assistant");

        expect(screen.queryByTestId("assistant-insert")).toBeNull();
    });

    it("re-sends the prior turns, so the exchange is a conversation", async () => {
        expect.assertions(2);

        const mock = chatMock("Sure.");

        render(renderPanel(mock));
        await openChat();

        ask("first question");
        await screen.findByTestId("assistant-turn-assistant");

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
        expect(screen.queryByTestId("assistant-panel")).toBeNull();

        await openChat();

        expect(screen.getByTestId("assistant-panel")).toBeDefined();

        fireEvent.click(screen.getByTestId("sql-chat-toggle"));

        await waitFor(() => {
            expect(screen.queryByTestId("assistant-panel")).toBeNull();
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
        const asked = await screen.findByTestId("assistant-turn-user");

        // Both halves travel, so the answer can explain rather than guess.
        expect(asked.textContent).toContain("SELECT bodyy FROM messages");
        expect(asked.textContent).toContain("no such column: bodyy");

        // …and it opened the assistant to show the answer.
        expect(screen.getByTestId("assistant-panel")).toBeDefined();
    });

    it("keeps the transcript when the page that started it goes away", async () => {
        expect.hasAssertions();

        // The whole reason the assistant was lifted out of the SQL console. Before
        // it, the transcript lived in the console's own state, so navigating away
        // threw the conversation out — and every other page had no assistant at all.
        const mock = chatMock("Two tables.");
        const view = render(renderPanel(mock));

        await openChat();
        ask("what tables do I have?");
        await screen.findByTestId("assistant-turn-assistant");

        // Unmount the console, keeping the provider and the docked panel — which is
        // exactly what a route change does in the shell.
        view.rerender(
            <LunoraProvider client={mock.asClient}>
                <AssistantProvider>
                    <Shell console_={false} />
                </AssistantProvider>
            </LunoraProvider>,
        );

        // The console really is gone, so the assertion below cannot pass just
        // because nothing unmounted.
        expect(screen.queryByTestId("lunora-sql-editor")).toBeNull();
        expect(screen.getByTestId("assistant-turns").textContent).toContain("Two tables.");
    });

    it("explains the draft rather than rewriting it", async () => {
        expect.hasAssertions();

        const mock = chatMock("It counts the rows in messages.");

        render(renderPanel(mock));
        await screen.findByTestId("sql-input");

        fireEvent.change(screen.getByTestId("sql-input"), { target: { value: "SELECT count(*) FROM messages" } });
        fireEvent.click(await screen.findByTestId("sql-explain-query"));

        // Asserted through the DOM: the question the operator can SEE is the one
        // that was asked. The draft is untouched — reading a query must not edit it.
        const asked = await screen.findByTestId("assistant-turn-user");

        expect(asked.textContent).toContain("SELECT count(*) FROM messages");
        expect(screen.getByTestId<HTMLTextAreaElement>("sql-input").value).toBe("SELECT count(*) FROM messages");
    });

    it("holds a seeded question until the model is free instead of dropping it", async () => {
        expect.hasAssertions();

        // `pending` is per-hook, not per-session: one turn in flight blocks every
        // session's send. Clearing the ask before `send` could run meant a question
        // asked while another was thinking vanished — blank session, nothing sent,
        // no error.
        let release: (() => void) | undefined;
        const mock = createMockClient({
            query: async (reference): Promise<unknown> => {
                if (reference === ADMIN_FUNCTIONS.aiAvailable) {
                    return { available: true };
                }

                if (reference === ADMIN_FUNCTIONS.aiChat) {
                    await new Promise<void>((resolve) => {
                        release = resolve;
                    });

                    return { degraded: false, partial: false, reply: "Answered.", toolCalls: [], truncated: false };
                }

                if (reference === ADMIN_FUNCTIONS.listTables) {
                    return [{ name: "messages", rowCount: 0 }];
                }

                return { columns: [], rowCount: 0, rows: [], truncated: false };
            },
        });

        render(renderPanel(mock));
        await openChat();

        ask("first question");
        await screen.findByTestId("assistant-turn-user");

        // A second surface seeds a question while the first turn is still in flight.
        fireEvent.click(screen.getByTestId("sql-explain-query"));

        release?.();

        // Both turns reach the server — the seeded one is held, not swallowed.
        await waitFor(() => {
            expect(mock.query.mock.calls.filter((call) => call[0].__lunoraRef === ADMIN_FUNCTIONS.aiChat)).toHaveLength(2);
        });
    });

    it("offers no entry point at all when the deployment cannot run the assistant", async () => {
        expect.hasAssertions();

        // Every shell-wide entry point must gate on the DEPLOYMENT's answer, not on
        // "is a provider mounted". Gating on the latter painted the button in every
        // ErrorAlert, every advisor row and the command palette on an app with no
        // `AI` binding — and clicking one fired a real RPC before the panel vanished.
        const mock = chatMock("unused", false);

        render(renderPanel(mock));
        await screen.findByTestId("lunora-sql-editor");

        await waitFor(() => {
            expect(screen.queryByTestId("sql-chat-toggle")).toBeNull();
        });

        expect(screen.queryByTestId("sql-explain-query")).toBeNull();
        expect(mock.query.mock.calls.some((call) => call[0].__lunoraRef === ADMIN_FUNCTIONS.aiChat)).toBe(false);
    });

    it("renders a reply as markdown but shows the operator's own words verbatim", async () => {
        expect.hasAssertions();

        render(renderPanel(chatMock("Two things:\n\n- **messages** is the big one\n- `users` is small")));
        await openChat();

        ask("**not bold** — this is what I typed");

        const reply = await screen.findByTestId("assistant-turn-assistant");

        // The model writes lists and emphasis; preformatted text made every answer
        // with structure hard to read.
        // Asserted on what the operator SEES rather than on the tags the renderer
        // happens to emit: the bullets became real list items, and the emphasis and
        // code markers are gone from the text instead of being shown literally.
        expect(within(reply).getAllByRole("listitem")).toHaveLength(2);
        expect(reply.textContent).toContain("messages is the big one");
        expect(reply.textContent).not.toContain("**");
        expect(reply.textContent).not.toContain("`");

        // The question is shown exactly as typed — markdown-rendering the operator's
        // own words would be the surface reinterpreting their input.
        const asked = screen.getByTestId("assistant-turn-user");

        expect(asked.textContent).toContain("**not bold**");
    });

    it("does not let a reply smuggle raw HTML into the console", async () => {
        expect.hasAssertions();

        // What is rendered here is MODEL output. The renderer is hardened, and this
        // is the assertion that says so rather than trusting the dependency's README.
        render(renderPanel(chatMock('Here you go: <img src="x" onerror="alert(1)"> and <script>alert(2)</script>')));
        await openChat();

        ask("show me something");

        const reply = await screen.findByTestId("assistant-turn-assistant");

        // No image element reached the DOM, so neither did its `onerror`.
        expect(within(reply).queryByRole("img")).toBeNull();

        /*
         * `<script>` carries no ARIA role, so proving its ABSENCE is the one thing
         * Testing Library's queries cannot express — and absence is the entire
         * assertion. Reaching for the node is the point here, not a shortcut.
         */
        // eslint-disable-next-line testing-library/no-node-access -- see above: asserting a roleless element is absent
        expect(reply.querySelector("script")).toBeNull();
    });
});
