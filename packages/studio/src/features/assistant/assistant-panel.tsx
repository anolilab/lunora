import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";

import type { AssistantSession, AssistantValue } from "../../components/assistant-provider";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { useAssistantRpc } from "../../hooks/use-assistant-rpc";
import { useT } from "../../i18n/i18n-context";
import type { ChatTurn, GenerateSqlDegradedReason } from "../../lib/admin";
import { fireAndForget } from "../../lib/internal";
import sqlBlocks from "../../lib/sql-blocks";

/**
 * Operator-facing copy per failure reason. `ai-disabled` and `no-ai-binding`
 * never reach here — both latch the panel hidden.
 *
 * Takes `t` and calls it with literals rather than returning a string to
 * translate, so every id stays statically known — the same reason
 * `dashboards-panel`'s `kindLabel` is written this way.
 */
const reasonMessage = (reason: GenerateSqlDegradedReason, t: ReturnType<typeof useT>): string =>
    reason === "empty-response" ? t("The model returned nothing usable.") : t("The model could not be reached.");

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
const TurnRow = ({ onInsert, turn }: { readonly onInsert: ((sql: string) => void) | undefined; readonly turn: ChatTurn }): ReactElement => {
    const t = useT();
    const blocks = turn.role === "assistant" && onInsert !== undefined ? sqlBlocks(turn.text) : [];

    return (
        <li className="flex flex-col gap-1 border-b border-border px-3 py-2 last:border-b-0" data-testid={`assistant-turn-${turn.role}`}>
            <span className="font-mono text-[10px] tracking-wide text-muted-foreground uppercase">{turn.role === "user" ? t("You") : t("Assistant")}</span>
            {turn.role === "assistant" ? (
                <div className="prose-sm max-w-none text-xs" data-testid="assistant-turn-body">
                    <Streamdown>{turn.text}</Streamdown>
                </div>
            ) : (
                <p className="text-xs whitespace-pre-wrap" data-testid="assistant-turn-body">
                    {turn.text}
                </p>
            )}
            {blocks.map((sql, index) => (
                <Button
                    className="self-start"
                    data-testid="assistant-insert"

                    // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- the blocks of one immutable reply, in order; a reply never gains or loses one
                    key={`${String(index)}:${sql.slice(0, 32)}`}
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
    const [truncated, setTruncated] = useState(false);
    const [outcome, setOutcome] = useState<undefined | { partial: boolean; read: number }>(undefined);

    // The draft seed already applied, so a re-render does not re-prefill over
    // whatever the operator has since typed.
    const appliedDraft = useRef<number | undefined>(undefined);

    const pending = ops.pending("chat");
    const reason = ops.reason("chat");

    const { setTurns, takeAsk } = assistant;
    const turns = session?.turns ?? [];
    const sessionId = session?.id;

    const send = (text?: string): void => {
        const prompt = (text ?? draft).trim();

        if (prompt === "" || pending || session === undefined) {
            return;
        }

        // The question joins the transcript immediately, so the operator sees what
        // they asked while it is in flight. The turns SENT are the ones from before
        // it, which is what the server would rebuild anyway.
        const sent = session.turns;
        const asked: ChatTurn[] = [...sent, { role: "user", text: prompt }];

        setTurns(session.id, asked);
        setDraft("");

        fireAndForget(
            ops.chat(prompt, sent, session.schema).then((answer) => {
                // A degraded turn adds nothing to the transcript — the reason is
                // rendered from the ops' own per-task status instead, so a failure
                // never looks like a reply.
                if (answer !== undefined) {
                    setTruncated(answer.truncated);
                    // What the turn actually read, surfaced rather than dropped: an
                    // answer built from three table reads must not look identical to
                    // one invented from nothing.
                    setOutcome({ partial: answer.partial, read: answer.toolCalls.filter((call) => call.refused === undefined).length });
                    setTurns(session.id, [...asked, { role: "assistant", text: answer.reply }]);
                }

                return answer;
            }),
        );
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

    if (ops.unavailable || !assistant.open || session === undefined) {
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

            <ul className="min-h-0 flex-1 overflow-y-auto" data-testid="assistant-turns">
                {/*
                 * Index keys, deliberately: a transcript is strictly append-only —
                 * never reordered, filtered, or spliced — which is precisely the
                 * case where an index is a stable identity. Two turns can carry the
                 * same role and the same text, so nothing else here is unique.
                 */}
                {turns.map((turn, index) => (
                    // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- append-only list; see above
                    <TurnRow key={`${String(index)}:${turn.role}`} onInsert={assistant.hasEditor ? assistant.requestInsert : undefined} turn={turn} />
                ))}
            </ul>

            {outcome !== undefined && (outcome.read > 0 || outcome.partial) && (
                <p className="px-3 py-1 text-[11px] text-muted-foreground" data-testid="assistant-outcome">
                    {outcome.read > 0 && t("Answered after reading your data.")}
                    {outcome.partial && t("Stopped early — this answer is incomplete.")}
                </p>
            )}

            {truncated && (
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
