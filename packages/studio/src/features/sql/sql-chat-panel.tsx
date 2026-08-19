import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { useT } from "../../i18n/i18n-context";
import type { ChatTurn, GenerateSqlDegradedReason, SchemaFact } from "../../lib/admin";
import { fireAndForget } from "../../lib/internal";
import type { SqlAssistant } from "./hooks/use-sql-assistant";
import type { SqlSchema } from "./sql-autocomplete";

/**
 * Operator-facing copy per failure reason. `no-ai-binding` never reaches here —
 * the panel is hidden entirely in that case.
 *
 * Takes `t` and calls it with literals rather than returning a string to
 * translate, so every id stays statically known — the same reason
 * `dashboards-panel`'s `kindLabel` is written this way.
 */
const reasonMessage = (reason: GenerateSqlDegradedReason, t: ReturnType<typeof useT>): string =>
    reason === "empty-response" ? t("The model returned nothing usable.") : t("The model could not be reached.");

/** Opening fence of the only block shape offered for insertion. */
const SQL_FENCE = "```sql";

/** Closing fence. */
const FENCE = "```";

/**
 * Pull the fenced SQL out of a reply.
 *
 * A scan rather than a regex: the obvious pattern (`/```sql\s*([\S\s]*?)```/`)
 * is polynomial-backtracking on a model reply, which is exactly the input not to
 * hand an ambiguous matcher.
 *
 * Deliberately narrow in what it accepts, too. Only a fenced ```sql block counts;
 * a looser reading — "any line starting with SELECT" — would offer prose as a
 * statement, and this button is the one path from a model reply into the editor.
 * An unterminated block yields nothing, because half a statement is not one.
 */
const sqlBlocks = (reply: string): string[] => {
    const blocks: string[] = [];

    for (const part of reply.split(SQL_FENCE).slice(1)) {
        const end = part.indexOf(FENCE);
        const sql = end === -1 ? "" : part.slice(0, end).trim();

        if (sql !== "") {
            blocks.push(sql);
        }
    }

    return blocks;
};

/**
 * The editor's schema, as the engine's grounding block wants it.
 *
 * A table whose columns have not been probed yet still contributes its NAME — the
 * system prompt tells the model to invent nothing, so knowing a table exists is
 * worth more than omitting it until its columns arrive.
 */
const groundingFacts = (schema: SqlSchema): SchemaFact[] =>
    schema.tables.map((table) => {
        return { columns: [...(schema.columns[table] ?? [])], table };
    });

/** One rendered turn, with an insert button per SQL block the reply carries. */
const TurnRow = ({ onInsert, turn }: { readonly onInsert: (sql: string) => void; readonly turn: ChatTurn }): ReactElement => {
    const t = useT();
    const blocks = turn.role === "assistant" ? sqlBlocks(turn.text) : [];

    return (
        <li className="flex flex-col gap-1 border-b border-border px-3 py-2 last:border-b-0" data-testid={`sql-chat-turn-${turn.role}`}>
            <span className="font-mono text-[10px] tracking-wide text-muted-foreground uppercase">{turn.role === "user" ? t("You") : t("Assistant")}</span>
            <p className="text-xs whitespace-pre-wrap">{turn.text}</p>
            {blocks.map((sql, index) => (
                <Button
                    className="self-start"
                    data-testid="sql-chat-insert"

                    key={`${String(index)}:${sql.slice(0, 32)}`}
                    onClick={() => {
                        onInsert(sql);
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

/**
 * Conversational assistant beside the SQL editor (plan 364 W3).
 *
 * Renders nothing when the app has no `AI` binding, on the same latch the other
 * assistant affordances use — a surface that can only fail is worse than none.
 *
 * **The transcript lives in React state, not storage.** A console chat is a
 * scratchpad: closing the tab ends it. Persisting would mean a retention policy
 * and another store of raw statements outliving the browser, which is the finding
 * that made SQL history opt-in.
 *
 * **Nothing here executes.** A reply is prose; the only path from it to the
 * editor is the operator pressing Insert, and what lands there still has to be
 * Run like anything they typed.
 */
const SqlChatPanel = ({
    assistant,
    onInsert,
    open,
    schema,
}: {
    readonly assistant: SqlAssistant;
    readonly onInsert: (sql: string) => void;
    /** Toggled from the results toolbar; closed, the panel renders nothing at all. */
    readonly open: boolean;
    /** Grounding for the turn — the same schema the editor autocompletes from. */
    readonly schema: SqlSchema;
}): ReactElement | null => {
    const t = useT();
    const [turns, setTurns] = useState<ChatTurn[]>([]);
    const [draft, setDraft] = useState("");
    const [truncated, setTruncated] = useState(false);
    const [outcome, setOutcome] = useState<undefined | { partial: boolean; read: number }>(undefined);

    // Hooks run first: both of these are early returns, and React needs the state
    // above them on every render.
    if (assistant.unavailable || !open) {
        return null;
    }

    const pending = assistant.pending("chat");
    const reason = assistant.reason("chat");

    const send = (): void => {
        const prompt = draft.trim();

        if (prompt === "" || pending) {
            return;
        }

        // The question joins the transcript immediately, so the operator sees what
        // they asked while it is in flight. The turns SENT are the ones from before
        // it, which is what the server would rebuild anyway.
        const sent = turns;

        setTurns([...turns, { role: "user", text: prompt }]);
        setDraft("");

        fireAndForget(
            assistant.chat(prompt, sent, groundingFacts(schema)).then((answer) => {
                // A degraded turn adds nothing to the transcript — the reason is
                // rendered from the assistant's own per-task status instead, so a
                // failure never looks like a reply.
                if (answer !== undefined) {
                    setTruncated(answer.truncated);
                    // What the turn actually read, surfaced rather than dropped: an
                    // answer built from three table reads must not look identical to
                    // one invented from nothing.
                    setOutcome({ partial: answer.partial, read: answer.toolCalls.filter((call) => call.refused === undefined).length });
                    setTurns((current) => [...current, { role: "assistant", text: answer.reply }]);
                }

                return answer;
            }),
        );
    };

    const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
        if (event.key === "Enter") {
            event.preventDefault();
            send();
        }
    };

    return (
        <section aria-label={t("SQL chat")} className="flex h-full w-96 min-w-0 shrink-0 flex-col border-s border-border bg-card" data-testid="sql-chat">
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
                <span className="font-mono text-[10px] tracking-wide text-muted-foreground uppercase">{t("Assistant")}</span>
                <span className="text-[11px] text-muted-foreground">{t("Answers are suggestions — nothing runs until you insert and run it.")}</span>
            </div>
            <ul className="min-h-0 flex-1 overflow-y-auto" data-testid="sql-chat-turns">
                {turns.map((turn, index) => (
                    <TurnRow key={`${String(index)}:${turn.role}`} onInsert={onInsert} turn={turn} />
                ))}
            </ul>

            {outcome !== undefined && (outcome.read > 0 || outcome.partial) && (
                <p className="px-3 py-1 text-[11px] text-muted-foreground" data-testid="sql-chat-outcome">
                    {outcome.read > 0 && t("Answered after reading your data.")}
                    {outcome.partial && t("Stopped early — this answer is incomplete.")}
                </p>
            )}

            {truncated && (
                <p className="px-3 py-1 text-[11px] text-muted-foreground" data-testid="sql-chat-truncated">
                    {t("Older turns were dropped to fit the context budget.")}
                </p>
            )}

            {reason !== undefined && (
                <p className="px-3 py-1 text-[11px] text-destructive" data-testid="sql-chat-error">
                    {reasonMessage(reason, t)}
                </p>
            )}

            <div className="flex items-center gap-2 border-t border-border px-3 py-2">
                <Input
                    aria-label={t("Ask about your data")}
                    data-testid="sql-chat-input"
                    disabled={pending}
                    onChange={(event) => {
                        setDraft(event.target.value);
                    }}
                    onKeyDown={onKeyDown}
                    placeholder={t("Ask about your data")}
                    value={draft}
                />
                <Button data-testid="sql-chat-send" disabled={pending || draft.trim() === ""} onClick={send} size="xs" type="button">
                    {pending ? t("Thinking…") : t("Send")}
                </Button>
            </div>
        </section>
    );
};

export default SqlChatPanel;
