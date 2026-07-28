import type { ReturnOf } from "@lunora/client";
import { usePreloadedQuery, useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { api } from "../../lunora/_generated/api.js";
import { CrossTabLink } from "./CrossTabLink";
import { formatMs, formatTime } from "./format";
import type { OrgId } from "./types";
import type { SectionProps } from "./tabs";

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
    const turns = useQuery(api.sessions.get, { organizationId, sessionId }) as SessionTurn[] | undefined;

    if (turns === undefined) {
        return <p className="muted">Loading…</p>;
    }

    if (turns.length === 0) {
        return <p className="muted">No turns for this session in the retention window.</p>;
    }

    return (
        <ol className="session-turns">
            {turns.map((turn, index) => {
                const tokens = tokenSummary(turn.promptTokens, turn.completionTokens);

                return (
                    <li className={`session-turn${turn.level === "error" ? " session-turn-err" : ""}`} key={turn.spanId}>
                        <div className="session-turn-head">
                            <span className="session-turn-index">#{String(index + 1)}</span>
                            <span className="log-fn">{turn.name}</span>
                            <span className="muted"> {formatMs(turn.durationMs)}</span>
                            <CrossTabLink target="traces" traceId={turn.traceId} variant="inline">
                                View trace
                            </CrossTabLink>
                        </div>
                        <div className="session-turn-meta">
                            <span className="trace-gen-meta">
                                {turn.model ?? "generation"}
                                {tokens ? ` · ${tokens}` : ""}
                            </span>
                            {turn.level === "error" ? <span className="log-badge log-badge-error">error</span> : null}
                            {(turn.evaluations ?? []).map((evaluation) => (
                                <span className="session-eval" key={evaluation.name}>
                                    {evaluation.name} {evaluation.score}
                                    {evaluation.label ? ` (${evaluation.label})` : ""}
                                </span>
                            ))}
                        </div>
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
 */
export const SessionsSection = ({ organizationId, preloaded }: SectionProps<ReturnOf<typeof api.sessions.list>>): ReactElement => {
    const sessions = usePreloadedQuery(preloaded);
    const [sessionId, setSessionId] = useState("");

    const selected = (sessions ?? []).find((session) => session.sessionId === sessionId);

    return (
        <div className="stack">
            <section className="card">
                <h3>Sessions</h3>
                {sessions === undefined ? <p className="muted">Loading…</p> : null}
                {sessions?.length === 0 ? (
                    <p className="muted">
                        No LLM sessions yet. Sessions group AI generation turns by conversation id — they appear once your app tags model calls with a thread
                        id.
                    </p>
                ) : null}
                {sessions && sessions.length > 0 ? (
                    <table className="table">
                        <thead>
                            <tr>
                                <th>Session</th>
                                <th>Turns</th>
                                <th>Tokens</th>
                                <th>Models</th>
                                <th>Status</th>
                                <th>Last active</th>
                            </tr>
                        </thead>
                        <tbody>
                            {sessions.map((session) => (
                                <tr
                                    aria-selected={session.sessionId === sessionId}
                                    className={`trace-clickable${session.errorCount > 0 ? " trace-error" : ""}${session.sessionId === sessionId ? " active" : ""}`}
                                    key={session.sessionId}
                                    onClick={() => {
                                        setSessionId(session.sessionId === sessionId ? "" : session.sessionId);
                                    }}
                                >
                                    <td className="trace-id">{session.sessionId.slice(0, 16)}</td>
                                    <td>{session.turnCount}</td>
                                    <td className="session-tokens">{session.totalTokens}</td>
                                    <td className="log-fn">{session.models.length > 0 ? session.models.join(", ") : "—"}</td>
                                    <td>
                                        {session.errorCount > 0 ? (
                                            <span className="log-badge log-badge-error">{session.errorCount} error</span>
                                        ) : (
                                            <span className="log-badge log-badge-info">ok</span>
                                        )}
                                    </td>
                                    <td className="muted">{formatTime(session.lastSeen)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                ) : null}
            </section>

            {sessionId ? (
                <section className="card">
                    <header className="trace-detail-head">
                        <div>
                            <span className="trace-detail-id">{sessionId.slice(0, 24)}</span>
                            {selected ? (
                                <span className="trace-detail-meta">
                                    {selected.turnCount} turns · {selected.totalTokens} tok
                                    {selected.errorCount > 0 ? <span className="trace-detail-err"> · {selected.errorCount} error</span> : null}
                                </span>
                            ) : null}
                        </div>
                        <button
                            className="trace-close"
                            onClick={() => {
                                setSessionId("");
                            }}
                            type="button"
                        >
                            Close
                        </button>
                    </header>
                    <SessionTurns organizationId={organizationId} sessionId={sessionId} />
                </section>
            ) : null}
        </div>
    );
};
