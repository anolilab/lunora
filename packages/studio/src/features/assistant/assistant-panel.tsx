import type { ReactElement } from "react";

import type { AssistantSession, AssistantValue } from "../../components/assistant-provider";
import { useAssistantRpc } from "../../hooks/use-assistant-rpc";
import { useT } from "../../i18n/i18n-context";
import AssistantComposer from "./assistant-composer";
import AssistantHeader from "./assistant-header";
import AssistantSessionBar from "./assistant-session-bar";
import AssistantSuggestions from "./assistant-suggestions";
import { AssistantStatus, LiveTurn, TurnRow } from "./assistant-turn";
import useAssistantChat from "./use-assistant-chat";

/**
 * The Studio's conversational assistant, docked beside whatever panel is open.
 *
 * **Shell-wide, not per-page.** It started inside the SQL console; lifting the
 * transcript into `AssistantProvider` is what lets an advisor lint, a failed
 * query, a log line and an issue all open the SAME assistant with their own
 * context attached, and what lets the conversation survive navigating away from
 * the page that started it.
 *
 * Renders nothing when the deployment has no `AI` binding or has the assistant
 * turned off, on the same sticky latch every other assistant affordance uses — a
 * surface that can only fail is worse than none.
 *
 * **Nothing here executes.** A reply is prose; the only path from it to the SQL
 * editor is the operator pressing Insert, which asks the page to take a statement
 * — and what lands there still has to be Run like anything they typed. A page
 * without an editor says so (`hasEditor`), and the button is then not offered at
 * all rather than offered and inert.
 *
 * **Every hook lives above the early return.** The conversation logic is in
 * {@link useAssistantChat} and the rendered pieces are presentational; keep both
 * true, or the hook count changes between renders of a mounted panel.
 */
const AssistantPanel = ({ assistant }: { readonly assistant: AssistantValue }): ReactElement | null => {
    const t = useT();

    const session: AssistantSession | undefined = assistant.sessions.find((candidate) => candidate.id === assistant.activeId);
    const ops = useAssistantRpc(session?.shardKey ?? "");
    const chat = useAssistantChat({ assistant, ops, session });

    if (ops.unavailable || session === undefined) {
        return null;
    }

    const {turns} = session;

    return (
        <section
            aria-label={t("Assistant")}
            className="flex h-full w-96 min-w-0 shrink-0 flex-col border-s border-border bg-card"
            data-testid="assistant-panel"
        >
            <AssistantHeader onClose={assistant.close} />

            <AssistantSessionBar
                activeId={assistant.activeId}
                onDelete={assistant.deleteChat}
                onNew={() => {
                    assistant.newChat({ title: t("New chat") });
                }}
                onSelect={assistant.selectChat}
                sessions={assistant.sessions}
            />

            {turns.length === 0 && session.suggestions.length > 0 && (
                <AssistantSuggestions
                    onPick={(suggestion) => {
                        chat.send(suggestion);
                    }}
                    suggestions={session.suggestions}
                />
            )}

            <ul className="min-h-0 flex-1 overflow-y-auto" data-testid="assistant-turns">
                {/*
                 * Index keys, deliberately: a transcript is strictly append-only —
                 * never reordered, filtered, or spliced — which is precisely the
                 * case where an index is a stable identity. Two turns can carry the
                 * same role and the same text, so nothing else here is unique.
                 */}
                {turns.map((turn, index) => (
                    // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- append-only list; see above
                    <TurnRow
                        index={index}
                        key={`${String(index)}:${turn.role}`}
                        level={ops.level}
                        onBranch={chat.branchHere}
                        // Only the newest turn's card is live: rewinding to an older
                        // one would answer a question the conversation has moved past.
                        onDecide={index === turns.length - 1 ? chat.decide : undefined}
                        onInsert={assistant.hasEditor ? assistant.requestInsert : undefined}
                        onTruncate={chat.truncateHere}
                        turn={turn}
                    />
                ))}
                {chat.live?.sessionId === session.id && chat.live.text !== "" && <LiveTurn text={chat.live.text} />}
            </ul>

            <AssistantStatus reason={chat.reason} truncated={chat.truncatedFor === session.id} />

            <AssistantComposer
                draft={chat.draft}
                onDraftChange={chat.setDraft}
                // Wrapped: `send` takes the prompt text, so handing it straight to the
                // composer would send the click event as the question.
                onSend={() => {
                    chat.send();
                }}
                pending={chat.pending}
            />
        </section>
    );
};

export default AssistantPanel;
