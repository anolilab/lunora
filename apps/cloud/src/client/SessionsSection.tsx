import type { ReturnOf } from "@lunora/client";
import { usePreloadedQuery, useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { api } from "../../lunora/_generated/api.js";
import { CrossTabLink } from "./CrossTabLink";
import { formatMs, formatNumber, formatTime } from "./format";
import { COLUMN_LABEL, rowClassName, StatusBadge } from "./section-ui";
import type { SectionProps } from "./tabs";
import type { OrgId } from "./types";

/** One turn as `sessions.get` returns it. */
interface SessionTurn {
    completionTokens?: number;
    durationMs: number;
    endedAt: number;
    evaluations?: { label?: string; name: string; score: number }[];
    level: "error" | "info";
    model?: string;
    name: string;
    promptTokens?: number;
    spanId: string;
    startedAt: number;
    traceId: string;
}

/** Compact token summary (`12→34 tok`) for a turn, when either count is present. */
const tokenSummary = (promptTokens: number | undefined, completionTokens: number | undefined): string | undefined =>
    promptTokens === undefined && completionTokens === undefined ? undefined : `${String(promptTokens ?? 0)}→${String(completionTokens ?? 0)} tok`;

/** The turns of one open session: each a generation turn, deep-linking to its trace. */
const SessionTurns = ({ organizationId, sessionId }: { organizationId: OrgId; sessionId: string }): ReactElement => {
    // Annotated rather than asserted: {@link SessionTurn} still documents the shape
    // the view relies on, and the compiler checks the query actually returns it.
    const turns: SessionTurn[] | undefined = useQuery(api.sessions.get, { organizationId, sessionId });

    if (turns === undefined) {
        return <p className={`${COLUMN_LABEL} text-muted-foreground`}>[Loading…]</p>;
    }

    if (turns.length === 0) {
        return <p className="text-muted-foreground text-sm">No turns for this session in the retention window.</p>;
    }

    return (
        // An ordered list, because a conversation's turns are ordered — but it borrows
        // the shared row metrics so its rhythm matches every other list in the studio.
        <ol className="m-0 grid list-none gap-0 p-0">
            {turns.map((turn, index) => {
                const tokens = tokenSummary(turn.promptTokens, turn.completionTokens);

                return (
                    <li className={`${rowClassName} flex-wrap`} key={turn.spanId}>
                        <span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">#{String(index + 1)}</span>
                        <span className="min-w-0 truncate font-medium">{turn.name}</span>
                        <span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">{formatMs(turn.durationMs)}</span>
                        <span className="text-muted-foreground shrink-0 font-mono text-xs">
                            {turn.model ?? "generation"}
                            {tokens ? ` · ${tokens}` : ""}
                        </span>
                        {turn.level === "error" ? <StatusBadge tone="danger">error</StatusBadge> : null}
                        {(turn.evaluations ?? []).map((evaluation) => (
                            <StatusBadge key={evaluation.name}>
                                {evaluation.name} {evaluation.score}
                                {evaluation.label ? ` (${evaluation.label})` : ""}
                            </StatusBadge>
                        ))}
                        <span className="ml-auto flex items-center gap-1">
                            <CrossTabLink target="traces" traceId={turn.traceId} variant="inline">
                                View trace
                            </CrossTabLink>
                        </span>
                    </li>
                );
            })}
        </ol>
    );
};

/**
 * Sessions tab — LLM conversations/threads over the generation span store
 * (`observations` with a `gen_ai.conversation.id`). `sessions.list` folds recent
 * generation turns into one row per session (turn count, summed tokens,
 * first/last seen, error count, models); selecting one drills into its turns
 * (`sessions.get`), each deep-linking to its trace via the shared cross-tab
 * pattern. Both queries are live. Empty until the framework emits
 * `gen_ai.conversation.id` (no session id → no session grouping).
 *
 * Hierarchy: tokens are what a session costs, so the token total is the one value
 * carried at size — `text-base` in the grid, escalating to the screen's single
 * display-size number once a session is selected (same value, same mono voice,
 * bigger when focused). Session ids, models and timestamps stay tertiary mono;
 * the error count is the only tinted thing, and it tints the value, not the row.
 */
export const SessionsSection = ({ organizationId, preloaded }: SectionProps<ReturnOf<typeof api.sessions.list>>): ReactElement => {
    const sessions = usePreloadedQuery(preloaded);
    const [sessionId, setSessionId] = useState("");

    const selected = (sessions ?? []).find((session) => session.sessionId === sessionId);

    return (
        <div className="flex flex-col gap-6">
            <Card>
                <CardHeader>
                    <CardTitle>Sessions</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                    {/* Loading and empty stay inline text — the system takes skeletons off the table. */}
                    {sessions ? null : <p className={`${COLUMN_LABEL} text-muted-foreground`}>[Loading…]</p>}
                    {sessions?.length === 0 ? (
                        <p className="text-muted-foreground text-sm">
                            No LLM sessions yet. Sessions group AI generation turns by conversation id — they appear once your app tags model calls with a
                            thread id.
                        </p>
                    ) : null}
                    {sessions && sessions.length > 0 ? (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead className={COLUMN_LABEL}>Session</TableHead>
                                    <TableHead className={COLUMN_LABEL}>Turns</TableHead>
                                    <TableHead className={COLUMN_LABEL}>Tokens</TableHead>
                                    <TableHead className={COLUMN_LABEL}>Models</TableHead>
                                    <TableHead className={COLUMN_LABEL}>Status</TableHead>
                                    <TableHead className={COLUMN_LABEL}>Last active</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {sessions.map((session) => {
                                    // One handler for pointer and keyboard, so the row toggle can't
                                    // drift between the two. The row is focusable and Enter/Space
                                    // activate it — a `<tr>` can't be a `<button>`, so it carries the
                                    // keyboard contract itself.
                                    const toggle = (): void => {
                                        setSessionId(session.sessionId === sessionId ? "" : session.sessionId);
                                    };

                                    return (
                                        <TableRow
                                            aria-selected={session.sessionId === sessionId}
                                            className="cursor-pointer"
                                            data-state={session.sessionId === sessionId ? "selected" : undefined}
                                            key={session.sessionId}
                                            onClick={toggle}
                                            onKeyDown={(event) => {
                                                if (event.key === "Enter" || event.key === " ") {
                                                    event.preventDefault();
                                                    toggle();
                                                }
                                            }}
                                            tabIndex={0}
                                        >
                                            <TableCell className="font-mono text-xs">{session.sessionId.slice(0, 16)}</TableCell>
                                            <TableCell className="font-mono text-xs tabular-nums">{formatNumber(session.turnCount)}</TableCell>
                                            {/* The row's one sized value: what the session cost. */}
                                            <TableCell className="font-mono text-base tabular-nums">{formatNumber(session.totalTokens)}</TableCell>
                                            <TableCell className="text-muted-foreground font-mono text-xs">
                                                {session.models.length > 0 ? session.models.join(", ") : "—"}
                                            </TableCell>
                                            <TableCell>
                                                {session.errorCount > 0 ? (
                                                    <StatusBadge tone="danger">{session.errorCount} error</StatusBadge>
                                                ) : (
                                                    <StatusBadge tone="success">ok</StatusBadge>
                                                )}
                                            </TableCell>
                                            <TableCell className="text-muted-foreground font-mono text-xs whitespace-nowrap">
                                                {formatTime(session.lastSeen)}
                                            </TableCell>
                                        </TableRow>
                                    );
                                })}
                            </TableBody>
                        </Table>
                    ) : null}
                </CardContent>
            </Card>

            {sessionId ? (
                <Card>
                    <CardHeader>
                        <span className={`${COLUMN_LABEL} text-muted-foreground`}>Session</span>
                        <CardTitle className="font-mono text-sm font-normal">{sessionId.slice(0, 24)}</CardTitle>
                        <CardAction>
                            <Button
                                onClick={() => {
                                    setSessionId("");
                                }}
                                size="sm"
                                type="button"
                                variant="ghost"
                            >
                                Close
                            </Button>
                        </CardAction>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-6">
                        {selected ? (
                            <div className="flex flex-wrap items-start gap-10 border-b border-border pb-6">
                                {/* The screen's single display-size number: what the selected session cost. */}
                                <div className="flex flex-col gap-1">
                                    <span className={`${COLUMN_LABEL} text-muted-foreground`}>Tokens</span>
                                    <span className="font-mono text-3xl leading-none tabular-nums">{formatNumber(selected.totalTokens)}</span>
                                </div>
                                <div className="flex flex-col gap-1">
                                    <span className={`${COLUMN_LABEL} text-muted-foreground`}>Turns</span>
                                    <span className="font-mono text-sm tabular-nums">{formatNumber(selected.turnCount)}</span>
                                </div>
                                <div className="flex flex-col gap-1">
                                    <span className={`${COLUMN_LABEL} text-muted-foreground`}>Errors</span>
                                    <span className={`font-mono text-sm tabular-nums ${selected.errorCount > 0 ? "text-destructive" : ""}`}>
                                        {formatNumber(selected.errorCount)}
                                    </span>
                                </div>
                            </div>
                        ) : null}
                        <SessionTurns organizationId={organizationId} sessionId={sessionId} />
                    </CardContent>
                </Card>
            ) : null}
        </div>
    );
};
