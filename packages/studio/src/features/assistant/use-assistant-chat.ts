import { useEffect, useRef, useState } from "react";

import type { AssistantSession, AssistantValue, SessionTurn } from "../../components/assistant-provider";
import type { AssistantRpc } from "../../hooks/use-assistant-rpc";
import type { ChatApproval, ChatStreamEvent, ChatTurn } from "../../lib/admin";
import { fireAndForget } from "../../lib/internal";

/** What the assistant panel reads and calls for the active conversation. */
interface AssistantChat {
    readonly branchHere: (index: number) => void;
    /** Answer the approval card on the last turn. */
    readonly decide: (allow: boolean, ticket: string) => void;
    readonly draft: string;
    readonly live: { readonly sessionId: string; readonly text: string } | undefined;
    readonly pending: boolean;
    readonly reason: ReturnType<AssistantRpc["reason"]>;
    /** Send `text`, or the composer's draft when omitted. */
    readonly send: (text?: string) => void;
    readonly setDraft: (value: string) => void;
    /** The session whose answer dropped older turns to fit the context budget, if any. */
    readonly truncatedFor: string | undefined;
    readonly truncateHere: (index: number) => void;
}

/**
 * The conversation logic behind the assistant panel: the composer draft, sending
 * and approving turns, the in-flight answer, and the two effects that take a
 * question queued by another surface.
 *
 * Call it above any early return in the component that uses it — every hook here
 * must run on every render of a mounted panel, or React throws on the changed hook
 * count.
 */
const useAssistantChat = ({
    assistant,
    ops,
    session,
}: {
    readonly assistant: AssistantValue;
    readonly ops: AssistantRpc;
    readonly session: AssistantSession | undefined;
}): AssistantChat => {
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
    // Which session's answer dropped older turns. It is a fact about one answered
    // turn, and without the id it followed the operator into a session that never
    // truncated anything. Set on every answer, so a later untruncated answer clears it.
    const [truncatedFor, setTruncatedFor] = useState<string | undefined>(undefined);

    // The draft seed already applied, so a re-render does not re-prefill over
    // whatever the operator has since typed.
    const appliedDraft = useRef<number | undefined>(undefined);

    const pending = ops.pending("chat");
    const reason = ops.reason("chat");

    const { setTurns, takeAsk } = assistant;
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
                        setTruncatedFor(answer.truncated ? session.id : undefined);
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
     * Prefilling is a write to state owned by this hook from a value owned by
     * the provider, which is what an effect is for. Keyed by id so seeding the
     * same text twice prefills twice, and guarded by a ref so a re-render never
     * overwrites what the operator has typed since.
     */
    const seededDraft = assistant.draft;

    useEffect(() => {
        if (seededDraft !== undefined && seededDraft.id !== appliedDraft.current) {
            appliedDraft.current = seededDraft.id;
            setDraft(seededDraft.text);
        }
    }, [seededDraft]);

    /*
     * Ask a seeded question once.
     *
     * The trigger lives OUTSIDE this component — the operator pressed "Debug with
     * AI" on a failed run, or "Explain this lint" on an advisor row — and reaching
     * a model is exactly the external system an effect is for. `takeAsk` clears it
     * by id, so the same question can be asked again later and a re-render cannot
     * re-ask this one.
     */
    const ask = assistant.pendingAsk;

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

    return { branchHere, decide, draft, live, pending, reason, send, setDraft, truncatedFor, truncateHere };
};

export default useAssistantChat;
