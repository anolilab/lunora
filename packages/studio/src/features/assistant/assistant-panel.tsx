import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";

import type { AssistantSession, AssistantValue, SessionTurn } from "../../components/assistant-provider";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { useAssistantRpc } from "../../hooks/use-assistant-rpc";
import { useT } from "../../i18n/i18n-context";
import type { AiOptInLevel, ChatApproval, ChatPendingApproval, ChatStreamEvent, ChatTurn, GenerateSqlDegradedReason } from "../../lib/admin";
import { copyToClipboard, fireAndForget } from "../../lib/internal";
import sqlBlocks from "../../lib/sql-blocks";

/**
 * Operator-facing copy per failure reason. `ai-disabled` and `no-ai-binding`
 * never reach here — both latch the panel hidden.
 *
 * Takes `t` and calls it with literals rather than returning a string to
 * translate, so every id stays statically known — the same reason
 * `dashboards-panel`'s `kindLabel` is written this way.
 */

/**
 * Element overrides for a rendered reply.
 *
 * Images are DROPPED, not merely sanitized. `rehype-harden` blocks a
 * `javascript:` link but allows every image protocol and prefix, and an image URL
 * in model output is a beacon: it fires on render, it reports that the operator
 * read the reply, and its query string carries whatever the model put there —
 * which, since a turn can read rows, is whatever it just saw. The assistant has
 * no reason to show a remote image, so there is nothing to weigh against that.
 */
const REPLY_COMPONENTS = { img: (): null => null };

const reasonMessage = (reason: GenerateSqlDegradedReason, t: ReturnType<typeof useT>): string =>
    reason === "empty-response" ? t("The model returned nothing usable.") : t("The model could not be reached.");

/**
 * The operator's gate on a read the turn stopped at.
 *
 * The engine returns the statement instead of running it, so this is where a row
 * value is first disclosed to a model — and the whole point is that the operator
 * sees the exact statement first. It is shown verbatim, unrendered: this is the
 * one piece of model output the operator is being asked to judge, so it must not
 * pass through a markdown renderer that could style it into something else.
 *
 * Both answers start a follow-up turn. Deny is not a local dismissal — the model
 * is told it was declined, so it answers from what it already has rather than
 * silently waiting for a result that will never arrive.
 */
const ApprovalCard = ({
    approval,
    onDecide,
}: {
    readonly approval: ChatPendingApproval;
    readonly onDecide: (allow: boolean, ticket: string) => void;
}): ReactElement => {
    const t = useT();

    return (
        <div className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/40 p-2" data-testid="assistant-approval">
            <span className="text-[11px] text-muted-foreground">
                {t("The assistant wants to read rows before answering. Nothing runs until you allow it.")}
            </span>
            <pre className="overflow-x-auto rounded bg-background p-1.5 font-mono text-[11px]" data-testid="assistant-approval-sql">
                {approval.sql}
            </pre>
            <div className="flex gap-2">
                <Button
                    data-testid="assistant-approval-allow"
                    onClick={() => {
                        onDecide(true, approval.ticket);
                    }}
                    size="xs"
                    type="button"
                >
                    {t("Allow")}
                </Button>
                <Button
                    data-testid="assistant-approval-deny"
                    onClick={() => {
                        onDecide(false, approval.ticket);
                    }}
                    size="xs"
                    type="button"
                    variant="secondary"
                >
                    {t("Deny")}
                </Button>
            </div>
        </div>
    );
};

/**
 * What one turn actually did, listed rather than summarised.
 *
 * The panel used to print a single line — "Answered after reading your data" —
 * for the whole session, which said an answer touched the database but not what
 * it read or whether anything was refused. A turn that ran three statements and
 * one that ran none looked identical, and a refusal looked like nothing at all.
 */
const ToolCalls = ({ level, turn }: { readonly level: AiOptInLevel | undefined; readonly turn: SessionTurn }): ReactElement | null => {
    const t = useT();
    const calls = turn.toolCalls ?? [];

    if (calls.length === 0 && turn.partial !== true) {
        return null;
    }

    return (
        <ul className="flex flex-col gap-0.5 border-s border-border ps-2 text-[11px] text-muted-foreground" data-testid="assistant-tool-calls">
            {calls.map((call, at) => (
                <li
                    // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- the calls of one immutable turn, in order
                    key={`${String(at)}:${call.name ?? "?"}`}
                >
                    <span className="font-mono">{call.name ?? t("(no such tool)")}</span>
                    {call.sql === undefined ? null : <span className="ms-1 font-mono opacity-80">{call.sql}</span>}
                    {call.refused === undefined ? null : <span className="ms-1 text-destructive">{t("refused")}</span>}
                    {/* A level refusal is the ONE refusal the operator can act on, and
                        until now its reason reached only the model — the panel printed
                        the bare word "refused", so a tool the deployment had simply not
                        opted into looked identical to a malformed request. `needs` is
                        structured for exactly this: say which tier it wanted, where the
                        deployment sits, and which var moves it. */}
                    {call.needs === undefined ? null : (
                        <span className="block text-muted-foreground" data-testid="assistant-tool-needs">
                            {t("Needs the {needs} data-sharing level; this deployment is set to {level}. Change LUNORA_AI_OPT_IN in wrangler.jsonc.", {
                                level: level ?? t("a lower level"),
                                needs: call.needs,
                            })}
                        </span>
                    )}
                </li>
            ))}
            {turn.partial === true && <li data-testid="assistant-turn-partial">{t("Stopped early — this answer is incomplete.")}</li>}
        </ul>
    );
};

/**
 * One rendered turn, with an insert button per SQL block the reply carries.
 *
 * **A reply is markdown; a question is not.** The model writes lists, tables and
 * fenced code, and rendering that as preformatted text made every answer with
 * structure hard to read. What the OPERATOR typed is shown exactly as typed —
 * markdown-rendering their own words would be the surface silently reinterpreting
 * their input.
 *
 * `Streamdown` over a hand-rolled renderer, and over plain `react-markdown`,
 * because what it renders is model output: it ships `rehype-harden` and
 * `rehype-sanitize`, so a reply cannot smuggle raw HTML, a `javascript:` link or
 * a remote image into the console. The SQL-block extraction below still reads the
 * RAW text — the insert path must not depend on how the reply is displayed.
 */
const TurnRow = ({
    index,
    level,
    onBranch,
    onDecide,
    onInsert,
    onTruncate,
    turn,
}: {
    readonly index: number;
    /** The deployment's data-sharing level, so a level refusal can name where it sits. */
    readonly level: AiOptInLevel | undefined;
    readonly onBranch: (index: number) => void;
    /** Present only on the LAST turn — an approval card further up the transcript is history, not a live decision. */
    readonly onDecide: ((allow: boolean, ticket: string) => void) | undefined;
    readonly onInsert: ((sql: string) => void) | undefined;
    readonly onTruncate: (index: number) => void;
    readonly turn: SessionTurn;
}): ReactElement => {
    const t = useT();
    const blocks = turn.role === "assistant" && onInsert !== undefined ? sqlBlocks(turn.text) : [];

    return (
        <li className="flex flex-col gap-1 border-b border-border px-3 py-2 last:border-b-0" data-testid={`assistant-turn-${turn.role}`}>
            <span className="font-mono text-[10px] tracking-wide text-muted-foreground uppercase">{turn.role === "user" ? t("You") : t("Assistant")}</span>
            {turn.role === "assistant" ? (
                <div className="prose-sm max-w-none text-xs" data-testid="assistant-turn-body">
                    <Streamdown components={REPLY_COMPONENTS}>{turn.text}</Streamdown>
                </div>
            ) : (
                <p className="text-xs whitespace-pre-wrap" data-testid="assistant-turn-body">
                    {turn.text}
                </p>
            )}
            {blocks.map((sql, at) => (
                <Button
                    className="self-start"
                    data-testid="assistant-insert"

                    // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- the blocks of one immutable reply, in order; a reply never gains or loses one
                    key={`${String(at)}:${sql.slice(0, 32)}`}
                    onClick={() => {
                        onInsert?.(sql);
                    }}
                    size="xs"
                    type="button"
                    variant="secondary"
                >
                    {t("Insert into editor")}
                </Button>
            ))}
            {turn.pendingApproval !== undefined && onDecide !== undefined && <ApprovalCard approval={turn.pendingApproval} onDecide={onDecide} />}
            {turn.role === "assistant" && <ToolCalls level={level} turn={turn} />}
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <button
                    className="underline outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    data-testid="assistant-copy"
                    onClick={() => {
                        copyToClipboard(turn.text);
                    }}
                    type="button"
                >
                    {t("Copy")}
                </button>
                {/* Branching keeps the conversation up to HERE and forks the rest:
                    the way out of "that answer took us somewhere wrong" without
                    losing the part that was going somewhere right. */}
                <button
                    className="underline outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    data-testid="assistant-branch"
                    onClick={() => {
                        onBranch(index);
                    }}
                    type="button"
                >
                    {t("Branch from here")}
                </button>
                <button
                    className="underline outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    data-testid="assistant-truncate"
                    onClick={() => {
                        onTruncate(index);
                    }}
                    type="button"
                >
                    {t("Delete from here")}
                </button>
            </div>
        </li>
    );
};

/** The session switcher: pick a conversation, start one, drop one. */
const SessionBar = ({ assistant }: { readonly assistant: AssistantValue }): ReactElement => {
    const t = useT();
    const { activeId, deleteChat, newChat, selectChat, sessions } = assistant;

    return (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 py-1" data-testid="assistant-sessions">
            {sessions.map((session) => (
                <span className="flex shrink-0 items-center" key={session.id}>
                    <Button
                        data-testid="assistant-session"
                        onClick={() => {
                            selectChat(session.id);
                        }}
                        size="xs"
                        type="button"
                        variant={session.id === activeId ? "secondary" : "ghost"}
                    >
                        {session.name}
                    </Button>
                    {sessions.length > 1 && (
                        <Button
                            aria-label={t("Close chat")}
                            data-testid="assistant-session-close"
                            onClick={() => {
                                deleteChat(session.id);
                            }}
                            size="xs"
                            type="button"
                            variant="ghost"
                        >
                            ×
                        </Button>
                    )}
                </span>
            ))}
            <Button
                aria-label={t("New chat")}
                className="shrink-0"
                data-testid="assistant-session-new"
                onClick={() => {
                    newChat({ title: t("New chat") });
                }}
                size="xs"
                type="button"
                variant="ghost"
            >
                +
            </Button>
        </div>
    );
};

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

    // Wrapped: passing `send` straight to onClick would hand it the click EVENT as
    // the prompt text.
    const onSendClick = (): void => {
        send();
    };

    const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
        if (event.key === "Enter") {
            event.preventDefault();
            send();
        }
    };

    return (
        <section
            aria-label={t("Assistant")}
            className="flex h-full w-96 min-w-0 shrink-0 flex-col border-s border-border bg-card"
            data-testid="assistant-panel"
        >
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
                <span className="font-mono text-[10px] tracking-wide text-muted-foreground uppercase">{t("Assistant")}</span>
                <span className="text-[11px] text-muted-foreground">{t("Answers are suggestions — nothing runs until you insert and run it.")}</span>
                <Button
                    aria-label={t("Close assistant")}
                    className="ms-auto"
                    data-testid="assistant-close"
                    onClick={assistant.close}
                    size="xs"
                    type="button"
                    variant="ghost"
                >
                    ×
                </Button>
            </div>

            <SessionBar assistant={assistant} />

            {turns.length === 0 && session.suggestions.length > 0 && (
                <div className="flex flex-col gap-1 px-3 py-2" data-testid="assistant-suggestions">
                    <span className="text-[11px] text-muted-foreground">{t("Try asking")}</span>
                    {session.suggestions.map((suggestion) => (
                        <button
                            className="self-start rounded-md border border-border px-2 py-1 text-start text-xs outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
                            data-testid="assistant-suggestion"
                            key={suggestion}
                            onClick={() => {
                                send(suggestion);
                            }}
                            type="button"
                        >
                            {suggestion}
                        </button>
                    ))}
                </div>
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
                {/*
                 * The turn in flight, rendered but not a turn: it carries no copy /
                 * branch / insert affordance because there is nothing yet to act on,
                 * and it is replaced wholesale by the answer the moment one lands.
                 * `Streamdown` over the raw text because half a markdown document is
                 * exactly what it is built to render.
                 */}
                {live !== undefined && live.sessionId === sessionId && live.text !== "" && (
                    <li className="flex flex-col gap-1 border-b border-border px-3 py-2 last:border-b-0" data-testid="assistant-turn-live">
                        <span className="font-mono text-[10px] tracking-wide text-muted-foreground uppercase">{t("Assistant")}</span>
                        <div className="prose-sm max-w-none text-xs" data-testid="assistant-turn-body">
                            <Streamdown components={REPLY_COMPONENTS}>{live.text}</Streamdown>
                        </div>
                    </li>
                )}
            </ul>

            {truncated && truncatedFor === sessionId && (
                <p className="px-3 py-1 text-[11px] text-muted-foreground" data-testid="assistant-truncated">
                    {t("Older turns were dropped to fit the context budget.")}
                </p>
            )}

            {reason !== undefined && (
                <p className="px-3 py-1 text-[11px] text-destructive" data-testid="assistant-error">
                    {reasonMessage(reason, t)}
                </p>
            )}

            <div className="flex items-center gap-2 border-t border-border px-3 py-2">
                <Input
                    aria-label={t("Ask about your data")}
                    data-testid="assistant-input"
                    disabled={pending}
                    onChange={(event) => {
                        setDraft(event.target.value);
                    }}
                    onKeyDown={onKeyDown}
                    placeholder={t("Ask about your data")}
                    value={draft}
                />
                <Button data-testid="assistant-send" disabled={pending || draft.trim() === ""} onClick={onSendClick} size="xs" type="button">
                    {pending ? t("Thinking…") : t("Send")}
                </Button>
            </div>
        </section>
    );
};

export default AssistantPanel;
