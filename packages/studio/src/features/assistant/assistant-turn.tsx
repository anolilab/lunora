import type { ReactElement } from "react";

import type { SessionTurn } from "../../components/assistant-provider";
import { Button } from "../../components/ui/button";
import { useT } from "../../i18n/i18n-context";
import type { AiOptInLevel } from "../../lib/admin";
import { copyToClipboard } from "../../lib/internal";
import sqlBlocks from "../../lib/sql-blocks";
import ApprovalCard from "./assistant-approval-card";
import ReplyBody from "./assistant-reply";
import ToolCalls from "./assistant-tool-calls";
import TurnFrame from "./assistant-turn-frame";

/**
 * One rendered turn, with an insert button per SQL block the reply carries.
 *
 * **A reply is markdown; a question is not.** What the OPERATOR typed is shown
 * exactly as typed — markdown-rendering their own words would be the surface
 * silently reinterpreting their input. The SQL-block extraction below still reads
 * the RAW text — the insert path must not depend on how the reply is displayed.
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
        <TurnFrame label={turn.role === "user" ? t("You") : t("Assistant")} testId={`assistant-turn-${turn.role}`}>
            {turn.role === "assistant" ? (
                <ReplyBody text={turn.text} />
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
        </TurnFrame>
    );
};

export default TurnRow;
