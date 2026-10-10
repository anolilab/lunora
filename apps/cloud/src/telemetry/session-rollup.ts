/**
 * Session/thread roll-up over stored **generation** observations — the LLM
 * sessions view (Tier 1). A single pure fold, unit-tested like the rest of
 * `src/telemetry/*`, shared by the `sessions.list` query and the dashboard
 * `SessionsSection`: {@link foldSessions} groups a org's recent generation turns
 * by `sessionId` (`gen_ai.conversation.id`) into one row per session — turn
 * count, summed token usage, first/last seen, error count, and the distinct
 * models the session touched.
 *
 * Fail-open by construction: a span with no `sessionId` is skipped (never
 * grouped), so until the framework emits `gen_ai.conversation.id` this fold
 * simply yields no sessions.
 */

/** One generation turn, as {@link foldSessions} reads it (a subset of the `observations` row). */
export interface SessionSpan {
    /** Completion (output) token count, when recorded. */
    completionTokens?: number;
    /** Epoch-ms the turn ended. */
    endedAt: number;
    /** `error` when the turn's span errored, else `info`. */
    level: "error" | "info";
    /** The model id the turn called, when set. */
    model?: string;
    /** Prompt (input) token count, when recorded. */
    promptTokens?: number;
    /** The conversation/thread id grouping turns into a session; a turn without one is skipped. */
    sessionId?: string;
    /** Epoch-ms the turn started. */
    startedAt: number;
    /** Trace the turn belongs to (so a turn can link to its trace). */
    traceId: string;
}

/** One session, folded from its generation turns for the sessions list. */
export interface SessionSummary {
    /** Summed completion (output) tokens across the session's turns. */
    completionTokens: number;
    /** Turns in the session whose span errored. */
    errorCount: number;
    /** Epoch-ms of the session's earliest turn start. */
    firstSeen: number;
    /** Epoch-ms of the session's latest turn end. */
    lastSeen: number;
    /** Distinct model ids the session touched, in first-seen order. */
    models: string[];
    /** Summed prompt (input) tokens across the session's turns. */
    promptTokens: number;
    /** The conversation/thread id (`gen_ai.conversation.id`). */
    sessionId: string;
    /** `promptTokens + completionTokens`. */
    totalTokens: number;
    /** Number of generation turns in the session. */
    turnCount: number;
}

/**
 * Fold generation turns into per-session {@link SessionSummary} rows,
 * newest-active first (by `lastSeen` desc), capped at `limit`. Order-agnostic —
 * first/last seen track min/max and token/error totals accumulate. A span with
 * no `sessionId` is skipped, so the fold is safe to hand the raw span page.
 */
/** A new per-session summary seeded from its first span. */
const seedSummary = (span: SessionSpan, sessionId: string, promptTokens: number, completionTokens: number): SessionSummary => {
    return {
        completionTokens,
        errorCount: span.level === "error" ? 1 : 0,
        firstSeen: span.startedAt,
        lastSeen: span.endedAt,
        models: span.model == null || span.model === "" ? [] : [span.model],
        promptTokens,
        sessionId,
        totalTokens: promptTokens + completionTokens,
        turnCount: 1,
    };
};

/** Fold one more span into a session summary, returning the updated copy (no mutation of the stored value). */
const accumulateSpan = (summary: SessionSummary, span: SessionSpan, promptTokens: number, completionTokens: number): SessionSummary => {
    const isNewModel = span.model != null && span.model !== "" && !summary.models.includes(span.model);

    return {
        ...summary,
        completionTokens: summary.completionTokens + completionTokens,
        errorCount: summary.errorCount + (span.level === "error" ? 1 : 0),
        firstSeen: Math.min(summary.firstSeen, span.startedAt),
        lastSeen: Math.max(summary.lastSeen, span.endedAt),
        models: isNewModel && span.model != null ? [...summary.models, span.model] : summary.models,
        promptTokens: summary.promptTokens + promptTokens,
        totalTokens: summary.totalTokens + promptTokens + completionTokens,
        turnCount: summary.turnCount + 1,
    };
};

export const foldSessions = (spans: ReadonlyArray<SessionSpan>, limit: number): SessionSummary[] => {
    const bySession = new Map<string, SessionSummary>();

    for (const span of spans) {
        const { sessionId } = span;

        if (sessionId == null || sessionId === "") {
            continue;
        }

        const promptTokens = span.promptTokens ?? 0;
        const completionTokens = span.completionTokens ?? 0;
        const existing = bySession.get(sessionId);

        if (existing === undefined) {
            bySession.set(sessionId, seedSummary(span, sessionId, promptTokens, completionTokens));
        } else {
            bySession.set(sessionId, accumulateSpan(existing, span, promptTokens, completionTokens));
        }
    }

    return [...bySession.values()].toSorted((a, b) => b.lastSeen - a.lastSeen).slice(0, Math.max(limit, 0));
};
