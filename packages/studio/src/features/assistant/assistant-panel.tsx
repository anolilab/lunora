import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";

import type { AssistantSession, AssistantValue, SessionTurn } from "../../components/assistant-provider";
import { useAssistantRpc } from "../../hooks/use-assistant-rpc";
import { useT } from "../../i18n/i18n-context";
import type { ChatApproval, ChatStreamEvent, ChatTurn } from "../../lib/admin";
import { fireAndForget } from "../../lib/internal";
import { AssistantHeader, AssistantStatus, AssistantSuggestions } from "./assistant-chrome";
import AssistantComposer from "./assistant-composer";
import SessionBar from "./assistant-session-bar";
import { LiveTurn, TurnRow } from "./assistant-turn";

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
 * **Every hook lives above the early return.** The subcomponents are presentational;
 * keep it that way, or the hook count changes between renders of a mounted panel.
 */
const AssistantPanel = ({ assistant }: { readonly assistant: AssistantValue }): ReactElement | null => {
    const t = useT();

    const session: AssistantSession | undefined = assistant.sessions.find((candidate) => candidate.id === assistant.activeId);
    const ops = useAssistantRpc(session?.shardKey ?? "");

    const [draft, setDraft] = useState("");

    /**
     * The answer as it arrives, and the session it belongs to.
     *
     * Held apart from `session.turns` on purpose, and that separation is the whole
     * safety property: a turn joins the transcript only when the promise resolves
     * with a whole answer, so an interrupted stream — a closed tab, a dropped
     * connection, a body that ends without its terminal frame — leaves this state
     * discarded and the transcript exactly as it was. Nothing here is ever
     * committed, copied, branched from, or re-sent as history.
     *
     * Scoped by session for the same reason `truncatedFor` is: `pending` is
     * per-hook, so without the id the tokens of a turn started in one chat would
     * paint into whichever chat the operator switched to.
     */
    const [live, setLive] = useState<{ sessionId: string; text: string } | undefined>(undefined);
    const [truncated, setTruncated] = useState(false);
    // Which session `truncated` describes. It is a fact about one answered turn,
    // and without this it followed the operator into a session that never
    // truncated anything.
    const [truncatedFor, setTruncatedFor] = useState<string | undefined>(undefined);

    // The draft seed already applied, so a re-render does not re-prefill over
    // whatever the operator has since typed.
    const appliedDraft = useRef<number | undefined>(undefined);

    const pending = ops.pending("chat");
    const reason = ops.reason("chat");

    const { setTurns, takeAsk } = assistant;
    const turns = session?.turns ?? [];
    const sessionId = session?.id;

    const branchHere = (index: number): void => {
        if (sessionId !== undefined) {
            assistant.branchFrom(sessionId, index);
        }
    };

    const truncateHere = (index: number): void => {
        if (sessionId !== undefined) {
            assistant.truncateFrom(sessionId, index);
        }
    };

    /**
     * Send one turn, appending `prompt` to `sent`.
     *
     * `sent` is a parameter rather than "whatever the session holds" because the
     * approval path re-runs a question that is already IN the transcript — see
     * {@link decide}.
     */
    const sendTurn = (prompt: string, sent: ReadonlyArray<SessionTurn>, approval?: ChatApproval): void => {
        if (prompt === "" || pending || session === undefined) {
            return;
        }

        // The question joins the transcript immediately, so the operator sees what
        // they asked while it is in flight. The turns SENT are the ones from before
        // it, which is what the server would rebuild anyway.
        const asked: SessionTurn[] = [...sent, { role: "user", text: prompt }];

        setTurns(session.id, asked);
        setLive({ sessionId: session.id, text: "" });

        fireAndForget(
            ops
                .chat(
                    prompt,
                    // Prose only. `toolCalls`/`partial` are the studio's record of what
                    // a turn did; the server budgets and fences TEXT, and handing it
                    // back its own tool log would spend that budget on what it knows.
                    sent.map((turn): ChatTurn => {
                        return { role: turn.role, text: turn.text };
                    }),
                    session.schema,
                    approval,
                    /*
                     * A round that asks for a tool streams its preamble and then
                     * stops — that prose is the turn thinking, not the turn's
                     * answer, and the engine discards it. So a `tool` event RESETS
                     * the live text rather than appending to it; otherwise the
                     * next round's answer would be pasted onto the end of a
                     * sentence the operator is never shown again.
                     */
                    (event: ChatStreamEvent) => {
                        setLive((current) =>
                            current?.sessionId === session.id
                                ? { sessionId: session.id, text: event.type === "delta" ? `${current.text}${event.text}` : "" }
                                : current,
                        );
                    },
                )
                .then((answer) => {
                    // A degraded turn adds nothing to the transcript — the reason is
                    // rendered from the ops' own per-task status instead, so a failure
                    // never looks like a reply.
                    if (answer !== undefined) {
                        setTruncated(answer.truncated);
                        setTruncatedFor(session.id);
                        // What the turn actually did travels WITH the turn, so an answer
                        // built from three reads never looks like one invented from
                        // nothing — and a later turn's silence does not erase it.
                        setTurns(session.id, [
                            ...asked,
                            {
                                partial: answer.partial,
                                ...(answer.pendingApproval === undefined ? {} : { pendingApproval: answer.pendingApproval }),
                                role: "assistant",
                                text: answer.reply,
                                toolCalls: answer.toolCalls,
                            },
                        ]);
                    }

                    return answer;
                })
                .finally(() => {
                    // Whatever happened — answered, degraded, or interrupted — the
                    // live text has served its purpose and is not part of the
                    // transcript.
                    setLive(undefined);
                }),
        );
    };

    const send = (text?: string): void => {
        const prompt = (text ?? draft).trim();

        if (prompt === "" || pending || session === undefined) {
            return;
        }

        setDraft("");
        sendTurn(prompt, session.turns);
    };

    /**
     * Answer the approval card on the last turn.
     *
     * The transcript is REWOUND to just before the answer that carried the card,
     * and the operator's own question is re-sent with the decision attached. The
     * alternative — appending a synthetic "yes, go ahead" turn — would put words in
     * the operator's mouth and leave the panel showing a question they never typed.
     * This way one question keeps one answer, which is also exactly the state the
     * server saw the first time, plus the decision.
     */
    const decide = (allow: boolean, ticket: string): void => {
        if (session === undefined || pending) {
            return;
        }

        const withoutAnswer = session.turns.slice(0, -1);
        const question = withoutAnswer.at(-1);

        if (question?.role !== "user") {
            return;
        }

        sendTurn(question.text, withoutAnswer.slice(0, -1), { allow, ticket });
    };

    /*
     * Apply a seeded draft once per seed id.
     *
     * Prefilling is a write to state owned by this component from a value owned by
     * the provider, which is what an effect is for. Keyed by id so seeding the
     * same text twice prefills twice, and guarded by a ref so a re-render never
     * overwrites what the operator has typed since.
     */
    const seededDraft = assistant.draft;

    /* eslint-disable react-you-might-not-need-an-effect/no-event-handler, react-you-might-not-need-an-effect/no-derived-state -- provider → composer seed: a surface elsewhere in the shell prefilled the composer (a value bumped by id, applied at most once). The draft is NOT derived — the operator edits it after, and a render-time read would overwrite every keystroke. There is no user event in this component to hook into. */
    useEffect(() => {
        if (seededDraft !== undefined && seededDraft.id !== appliedDraft.current) {
            appliedDraft.current = seededDraft.id;
            setDraft(seededDraft.text);
        }
    }, [seededDraft]);
    /* eslint-enable react-you-might-not-need-an-effect/no-event-handler, react-you-might-not-need-an-effect/no-derived-state */

    /*
     * Ask a seeded question once.
     *
     * The trigger lives OUTSIDE this component — the operator pressed "Debug with
     * AI" on a failed run, or "Explain this lint" on an advisor row — and reaching
     * a model is exactly the external system an effect is for. `takeAsk` clears it
     * by id, so the same question can be asked again later and a re-render cannot
     * re-ask this one.
     *
     * ABOVE the early return, with every other hook: behind it the effect ran only
     * while the panel was open, so opening the panel changed the hook count and
     * React threw "rendered more hooks than during the previous render".
     */
    const ask = assistant.pendingAsk;

    /* eslint-disable react-you-might-not-need-an-effect/no-event-handler -- external trigger: the operator clicked "Debug with AI" / "Ask the assistant" on ANOTHER component, which queued a question here. Reaching a model is the external system an effect is for, and `takeAsk` makes it fire exactly once. */
    useEffect(() => {
        /*
         * `pending` is part of the condition, not just of `send`'s early return.
         *
         * `pending` is per-hook, not per-session: one turn in flight blocks every
         * session's send. Clearing the ask first and letting `send` bail meant a
         * question asked while another was thinking vanished — the operator landed
         * on a blank session with nothing sent, no answer and no error. Holding the
         * ask until the model is free means this effect simply re-runs when
         * `pending` clears, and the question goes out then.
         */
        if (ask === undefined || ask.sessionId !== sessionId || pending) {
            return;
        }

        takeAsk(ask.id);

        // Queued rather than called straight from the effect body: `send` sets
        // state, and doing that synchronously inside an effect forces a second
        // render pass before the browser paints — the operator sees the panel open
        // empty, then the question appear. `takeAsk` above still guarantees one ask.
        queueMicrotask(() => {
            send(ask.text);
        });
        // `send` is re-created every render and is not a meaningful dependency —
        // the ask's identity is what decides whether to send.
        // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
    }, [ask, sessionId, takeAsk, pending]);
    /* eslint-enable react-you-might-not-need-an-effect/no-event-handler */

    if (ops.unavailable || session === undefined) {
        return null;
    }

    return (
        <section
            aria-label={t("Assistant")}
            className="flex h-full w-96 min-w-0 shrink-0 flex-col border-s border-border bg-card"
            data-testid="assistant-panel"
        >
            <AssistantHeader onClose={assistant.close} />

            <SessionBar assistant={assistant} />

            {turns.length === 0 && session.suggestions.length > 0 && (
                <AssistantSuggestions
                    onPick={(suggestion) => {
                        send(suggestion);
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
                        onBranch={branchHere}
                        // Only the newest turn's card is live: rewinding to an older
                        // one would answer a question the conversation has moved past.
                        onDecide={index === turns.length - 1 ? decide : undefined}
                        onInsert={assistant.hasEditor ? assistant.requestInsert : undefined}
                        onTruncate={truncateHere}
                        turn={turn}
                    />
                ))}
                {live !== undefined && live.sessionId === sessionId && live.text !== "" && <LiveTurn text={live.text} />}
            </ul>

            <AssistantStatus reason={reason} truncated={truncated && truncatedFor === sessionId} />

            <AssistantComposer
                draft={draft}
                onDraftChange={setDraft}
                onSend={() => {
                    send();
                }}
                pending={pending}
            />
        </section>
    );
};

export default AssistantPanel;
