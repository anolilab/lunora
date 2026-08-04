import type { TableDefinition } from "@lunora/server";
import { defineTable, initLunora } from "@lunora/server";
import { v } from "@lunora/values";

import type { AgentRegisteredFunction } from "./component-shared";
import { asInternal } from "./component-shared";

/** The physical (merged) table name the episodic functions read/write. */
const EPISODES_TABLE = "agent_episodes" as const;

/** Default number of recent episodes recalled per run when the source omits `recall`. */
const DEFAULT_EPISODE_RECALL = 5;

/** Hard ceiling on recalled episodes so a misconfigured `recall` can't flood the prompt. */
const MAX_EPISODE_RECALL = 20;

/** Max stored summary length — bounds per-episode prompt cost (model output is untrusted). */
const MAX_EPISODE_SUMMARY_CHARS = 500;

/** Per-owner episode retention cap — the oldest beyond this are pruned on write so storage stays bounded. */
const MAX_EPISODE_RETENTION = 200;

/** Collapse any whitespace run (incl. newlines) to a single space — hoisted, avoids recompilation. */
const WHITESPACE_RUN = /\s+/gu;

/** Clamp a `recall` count into `[1, MAX_EPISODE_RECALL]`, defaulting an absent/garbage value. */
const clampRecall = (value: number | undefined): number => {
    if (value === undefined || !Number.isFinite(value)) {
        return DEFAULT_EPISODE_RECALL;
    }

    return Math.min(MAX_EPISODE_RECALL, Math.max(1, Math.trunc(value)));
};

/**
 * The episodic-memory table, spread into the `agent` schema extension by
 * `component.ts`. Owner-scoped (keyed by `owner`, not thread), so a run in one
 * conversation recalls the timeline of the user's earlier runs across every
 * thread. `.public()` + RLS-exempt like the thread/graph tables (package code,
 * access-controlled inside the dispatched functions).
 *
 * Explicitly typed as a `Record` of `TableDefinition` values for the same
 * `--isolatedDeclarations` reason as `graphTables` (an exported const with a
 * computed key can't be inferred; see graph-component.ts).
 */
const episodeTables: Record<string, TableDefinition> = {
    /**
     * One episode per completed run — a short natural-language summary of the
     * exchange, time-ordered for recency recall. `messageKey` (the extract
     * step's instance-scoped key) is the idempotency key so a workflow replay
     * never double-records the same run.
     */
    episodes: defineTable({
        createdAt: v.number(),
        messageKey: v.string(),
        owner: v.string(),
        /** A one/two-sentence summary of the run, injected as a memory-log line. */
        summary: v.string(),
        /** The thread the episode came from (provenance; not used for recall scope). */
        threadKey: v.optional(v.string()),
    })
        // Recency recall — prefix-scan the owner, ordered by createdAt.
        .index("byOwnerCreatedAt", ["owner", "createdAt"])
        // Idempotent upsert — one row per (owner, run).
        .index("byOwnerMessageKey", ["owner", "messageKey"], { unique: true })
        // Same RLS-exempt rationale as the thread tables (see component.ts).
        .public(),
};

// Built with the base procedure builders (no generated server inside a
// package), same as the graph functions in graph-component.ts.
const { mutation, query } = initLunora.dataModel().create();

/** The two internal episodic-memory functions the durable loop dispatches to. */
interface EpisodicComponentFunctions {
    agentEpisodeRecall: AgentRegisteredFunction;
    agentEpisodeUpsert: AgentRegisteredFunction;
}

/**
 * Build the episodic-memory tier's registered functions — the owner-scoped
 * run-end write (`agentEpisodeUpsert`) and the recency-ordered read
 * (`agentEpisodeRecall`). Both are INTERNAL (loop-dispatched) and folded into
 * `agentComponent().functions` so codegen auto-registers them under `agents:*`.
 */
const episodicComponent = (): EpisodicComponentFunctions => {
    /**
     * Episodic WRITE (internal mutation). The run-end summary step dispatches
     * this once per run. Idempotent under workflow replay/retry: a re-dispatch
     * with the same `(owner, messageKey)` finds the existing row and no-ops, so
     * `createdAt` (and thus recall order) is stable. A blank summary is dropped.
     */
    const agentEpisodeUpsert = mutation
        .input({
            createdAt: v.optional(v.number()),
            messageKey: v.string(),
            owner: v.string(),
            summary: v.string(),
            threadKey: v.optional(v.string()),
        })
        .mutation(async ({ args, ctx: context }): Promise<{ recorded: boolean }> => {
            // The summary is MODEL-generated; collapse newlines (so it can't forge
            // extra `- ...` memory-log lines when injected) and cap its length (so
            // one row can't bloat every future prompt) before storing.
            const summary = args.summary.replaceAll(WHITESPACE_RUN, " ").trim().slice(0, MAX_EPISODE_SUMMARY_CHARS);

            if (summary.length === 0) {
                return { recorded: false };
            }

            const existing = await context.db
                .query(EPISODES_TABLE)
                .withIndex("byOwnerMessageKey", (q) => q.eq("owner", args.owner).eq("messageKey", args.messageKey))
                .first();

            if (existing) {
                return { recorded: false };
            }

            await context.db.insert(EPISODES_TABLE, {
                createdAt: args.createdAt ?? Date.now(),
                messageKey: args.messageKey,
                owner: args.owner,
                summary,
                ...(args.threadKey === undefined ? {} : { threadKey: args.threadKey }),
            });

            // Bound storage: delete the owner's oldest episodes beyond the retention
            // cap. Bounded read (cap + 1); at steady state each insert trims one, so
            // it self-corrects. Runs once per new episode (a replay dedups above), and
            // the delete is deterministic (oldest-first) — replay-safe.
            const overflow = await context.db
                .query(EPISODES_TABLE)
                .withIndex("byOwnerCreatedAt", (q) => q.eq("owner", args.owner))
                .order("asc")
                .take(MAX_EPISODE_RETENTION + 1);

            for (const stale of overflow.slice(0, Math.max(0, overflow.length - MAX_EPISODE_RETENTION))) {
                // eslint-disable-next-line no-await-in-loop -- sequential deletes in a serialized mutation
                await context.db.delete(stale["_id"] as never);
            }

            return { recorded: true };
        });

    /**
     * Episodic READ (internal query — queries are dispatchable via `run`, like
     * `agentState`). Returns the owner's most recent `limit` episodes rendered
     * chronologically (oldest → newest) as compact `- <summary>` lines, so the
     * model reads a short timeline. Owner-scoped; deterministic (explicit sort);
     * `{ context: "" }` when the owner has no episodes (the loop drops it).
     */
    const agentEpisodeRecall = query
        .input({
            limit: v.optional(v.number()),
            owner: v.string(),
        })
        .query(async ({ args, ctx: context }): Promise<{ context: string }> => {
            // Bounded read: pull only the most-recent `limit` rows via the index
            // (createdAt desc), NOT every owner episode — recall runs on the hot
            // path of every run, so an owner's lifetime episode count must not
            // drive per-run cost.
            const recent = await context.db
                .query(EPISODES_TABLE)
                .withIndex("byOwnerCreatedAt", (q) => q.eq("owner", args.owner))
                .order("desc")
                .take(clampRecall(args.limit));

            if (recent.length === 0) {
                return { context: "" };
            }

            // `take("desc")` yields newest-first; reverse to render oldest → newest.
            return {
                context: recent
                    .toReversed()
                    .map((row) => `- ${row["summary"] as string}`)
                    .join("\n"),
            };
        });

    return {
        agentEpisodeRecall: asInternal(agentEpisodeRecall),
        agentEpisodeUpsert: asInternal(agentEpisodeUpsert),
    };
};

export type { EpisodicComponentFunctions };
export { episodeTables, episodicComponent };
