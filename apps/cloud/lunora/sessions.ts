import type { SessionSpan } from "../src/telemetry/session-rollup";
import { foldSessions } from "../src/telemetry/session-rollup";
import type { Id } from "./_generated/dataModel.js";
import { query, v } from "./_generated/server.js";
import { assertMember } from "./authz";
import { boundedString, LIMITS } from "./validators";

/**
 * LLM **sessions / threads** over stored **generation** observations (Tier 1) —
 * the conversation view the OTel `gen_ai.conversation.id` attribute unlocks.
 * `list` folds recent generation turns into one row per session (turn count,
 * summed tokens, first/last seen, error count, distinct models); `get` returns
 * one session's turns (each linking back to its trace). Both members-only. The
 * pure grouping lives in `src/telemetry/session-rollup`.
 *
 * Fail-open: a generation span carries a `sessionId` only once the framework
 * emits `gen_ai.conversation.id`; until then these queries return `[]` (no
 * session id → no session grouping).
 */

/** Default number of sessions {@link list} returns. */
const DEFAULT_SESSION_LIMIT = 50;

/** Hard cap on {@link list} output. */
const MAX_SESSION_LIMIT = 200;

/** Recent spans scanned before folding into sessions (bounds the read). */
const SCAN_LIMIT = 2000;

/** One stored observation row, as the session queries read it (adds the fields `get` projects). */
interface SessionObservationRow extends SessionSpan {
    _id: Id<"observations">;
    durationMs: number;
    evaluations?: { label?: string; name: string; score: number }[];
    kind?: "container" | "generation" | "worker";
    name: string;
    organizationId: Id<"organizations">;
    spanId: string;
}

/** One folded session — mirrors `SessionSummary` locally so codegen inlines it. */
interface SessionSummaryView {
    completionTokens: number;
    errorCount: number;
    firstSeen: number;
    lastSeen: number;
    models: string[];
    promptTokens: number;
    sessionId: string;
    totalTokens: number;
    turnCount: number;
}

/** One turn in a session — a generation span, projected for the turns list (links to its trace). */
interface SessionTurnView {
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

/** Keep only the generation turns that carry a session id (the ones the fold groups). */
const isSessionTurn = (row: SessionObservationRow): boolean => row.kind === "generation" && row.sessionId != null && row.sessionId !== "";

/**
 * Recent LLM sessions, newest-active first, folded from the generation span
 * store: one row per `sessionId` with turn count, summed token usage, first/last
 * seen, error count, and the distinct models the session touched. Bounded by
 * `limit` (default {@link DEFAULT_SESSION_LIMIT}), folded over the most recent
 * {@link SCAN_LIMIT} spans. Members only. Returns `[]` until the framework emits
 * `gen_ai.conversation.id` (no session id → no grouping).
 */
export const list = query
    .input({
        limit: v.optional(v.number()),
        organizationId: v.id("organizations"),
    })
    .query(async ({ ctx: context, args }): Promise<SessionSummaryView[]> => {
        await assertMember(context, args.organizationId);

        const limit = Math.min(Math.max(Math.trunc(args.limit ?? DEFAULT_SESSION_LIMIT), 1), MAX_SESSION_LIMIT);

        const { page } = await context.db.observations.findMany({
            limit: SCAN_LIMIT,
            orderBy: [{ startedAt: "desc" }],
            where: { organizationId: args.organizationId },
        });

        const turns = page.filter((row) => isSessionTurn(row));

        // `SessionSummary` and the local `SessionSummaryView` are structurally
        // identical — the view mirror is what codegen inlines into the API types.
        return foldSessions(turns, limit);
    });

/**
 * Every generation turn in one session (`by_org_session` index), oldest-first,
 * for the session drill-in. Each turn carries its trace id so the client can
 * deep-link to the trace waterfall via the shared cross-tab pattern. Members
 * only. Empty for an unknown/absent session id.
 */
export const get = query
    .input({
        organizationId: v.id("organizations"),
        sessionId: boundedString(LIMITS.name),
    })
    .query(async ({ ctx: context, args }): Promise<SessionTurnView[]> => {
        await assertMember(context, args.organizationId);

        if (args.sessionId === "") {
            return [];
        }

        const { page } = await context.db.observations.findMany({
            where: { organizationId: args.organizationId, sessionId: args.sessionId },
        });

        return page
            .filter((row) => row.kind === "generation")
            .toSorted((a, b) => a.startedAt - b.startedAt)
            .map((row) => {
                return {
                    completionTokens: row.completionTokens,
                    durationMs: row.durationMs,
                    endedAt: row.endedAt,
                    evaluations: row.evaluations,
                    level: row.level,
                    model: row.model,
                    name: row.name,
                    promptTokens: row.promptTokens,
                    spanId: row.spanId,
                    startedAt: row.startedAt,
                    traceId: row.traceId,
                };
            });
    });
