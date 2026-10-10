import type { ReactElement } from "react";
import { Streamdown } from "streamdown";

import type { SessionTurn } from "../../components/assistant-provider";
import { Button } from "../../components/ui/button";
import { useT } from "../../i18n/i18n-context";
import type { AiOptInLevel, ChatPendingApproval } from "../../lib/admin";
import { copyToClipboard } from "../../lib/internal";
import sqlBlocks from "../../lib/sql-blocks";

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
export const TurnRow = ({
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

/**
 * The turn in flight, rendered but not a turn: it carries no copy / branch /
 * insert affordance because there is nothing yet to act on, and it is replaced
 * wholesale by the answer the moment one lands. `Streamdown` over the raw text
 * because half a markdown document is exactly what it is built to render.
 */
export const LiveTurn = ({ text }: { readonly text: string }): ReactElement => {
    const t = useT();

    return (
        <li className="flex flex-col gap-1 border-b border-border px-3 py-2 last:border-b-0" data-testid="assistant-turn-live">
            <span className="font-mono text-[10px] tracking-wide text-muted-foreground uppercase">{t("Assistant")}</span>
            <div className="prose-sm max-w-none text-xs" data-testid="assistant-turn-body">
                <Streamdown components={REPLY_COMPONENTS}>{text}</Streamdown>
            </div>
        </li>
    );
};
