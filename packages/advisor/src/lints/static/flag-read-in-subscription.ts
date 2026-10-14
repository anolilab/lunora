import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a `ctx.flags` read inside a `query(...)` handler body.
 *
 * A flag read is an input the invalidation system does not model. Live queries
 * re-run off the change feed: a write appends to `__cdc_log`, the shard flushes,
 * and every subscription whose read set overlaps the write is re-evaluated.
 * Flipping a feature flag appends nothing — the flag lives in the OpenFeature
 * provider, not in a Lunora table — so a subscription that branched on
 * `ctx.flags.boolean("new-ui", false)` keeps serving the branch it picked when it
 * last ran, for as long as the client stays connected. No error, no reconnect, no
 * signal of any kind.
 *
 * Forcing a re-snapshot on flag change was considered and rejected: it would
 * converge only the reconnect moment (a permanent cost paid on every reconnect)
 * while leaving the query stale for exactly the window that matters — a live
 * client that never disconnects. The reactive path already exists and is correct:
 * a `useFlag` subscription is served through the flags function prefix, tagged
 * with the admin wildcard, and re-evaluated on every write-flush. So the answer
 * for a flag read inside a cached query is to tell the author, exactly as this
 * repo already does for `Date.now()` in a query.
 *
 * WARN rather than INFO — the same axis the sibling
 * `nondeterministic_query_mutation` splits on. Its mutation half dropped to INFO
 * because the hazard genuinely is not there: a mutation handler runs at most once
 * per logical write, so there is nothing for it to be inconsistent with. Here the
 * hazard *is* there and its failure mode is silence — a stale flag branch looks
 * exactly like a correct one from the client, so nothing surfaces it at runtime,
 * and INFO (which most surfaces filter out) would leave the author with no signal
 * at all. This lint is also structurally low-volume in a way the mutation half
 * was not: it fires only on queries, and only on an explicit `ctx.flags` touch,
 * so it cannot flood a real codebase the way "stamp `createdAt` in a mutation"
 * did (193 of 385 non-INFO findings on one real app).
 *
 * `mutation(...)` and `action(...)` are not flagged — the feeder never records
 * them. Neither backs a live subscription, so a flag read there is a
 * point-in-time evaluation for a call that is itself point-in-time.
 *
 * This lint runs when the codegen feeder has supplied read evidence
 * (`context.flagReads` present); a runtime caller with no evidence flags nothing
 * rather than raising false alarms.
 */
const flagReadInSubscription: Lint = {
    categories: ["SCHEMA"],
    description:
        "A `query` handler reads a feature flag via `ctx.flags`. Flag changes are invisible to the change feed — flipping a flag appends nothing to `__cdc_log` — so no live subscription re-runs and the query keeps serving the branch it picked when it last ran. The staleness produces no error and no reconnect, so it surfaces nowhere at runtime.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "flag_read_in_subscription",
    remediation:
        "A flag read inside a query is evaluated once per query run and will NOT update when the flag flips — subscribers keep the old branch until something else invalidates the query. For a flag whose value must reach a live client, subscribe to it directly with `useFlag(...)`, which is served on the reactive flag path and re-evaluated on every write-flush, and branch in the component. If the query genuinely wants a point-in-time evaluation (a gate read once at call time), the read is correct as written and the finding can be dismissed.",
    run: (context) => {
        // No read evidence supplied → nothing to assert (mirrors r2sql_outside_action).
        if (context.flagReads === undefined) {
            return [];
        }

        const findings = [];

        // Per-(file, line, callee) occurrence counter: two reads of the same flag
        // surface on one source line — the very common
        // `Promise.all([ctx.flags.boolean("a", false), ctx.flags.boolean("b", false)])`
        // — would otherwise share an identical cacheKey and collapse into a single
        // dismissible finding.
        const occurrenceCount = new Map<string, number>();

        for (const read of context.flagReads) {
            const baseKey = `${read.file}:${read.line.toString()}:${read.callee}`;
            const occurrence = (occurrenceCount.get(baseKey) ?? 0) + 1;

            occurrenceCount.set(baseKey, occurrence);

            // Suffix the occurrence index only for the second and beyond so
            // single-occurrence cacheKeys stay stable across runs.
            const occurrenceSuffix = occurrence > 1 ? `:${occurrence.toString()}` : "";

            findings.push(
                emit(flagReadInSubscription, {
                    cacheKey: `flag_read_in_subscription:${baseKey}${occurrenceSuffix}`,
                    detail: `\`${read.callee}(…)\` in ${read.exportName} (${read.file}:${read.line.toString()}) reads a feature flag inside a query handler. The read is evaluated once per query run: flipping the flag appends nothing to the change feed, so no live subscription re-runs and subscribers keep the branch this query last picked. Subscribe with \`useFlag\` on the client if the value must stay live.`,
                    metadata: { callee: read.callee, exportName: read.exportName, file: read.file, line: read.line },
                }),
            );
        }

        return findings;
    },
    source: "static",
    title: "Feature-flag read inside a live query",
};

export default flagReadInSubscription;
