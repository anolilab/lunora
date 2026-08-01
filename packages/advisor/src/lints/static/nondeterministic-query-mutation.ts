import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a non-deterministic API call inside a `query(...)` or `mutation(...)`
 * handler body.
 *
 * The two procedure kinds do NOT share the same hazard (issue #286).
 *
 * A `query` handler genuinely CAN run more than once for the same logical
 * read: a live subscription re-runs its query whenever a table it reads
 * changes, so `Date.now()`/`Math.random()`/etc. there can flicker between
 * re-evaluations — this half stays at WARN.
 *
 * A `mutation` handler does NOT replay under ordinary dispatch on this
 * (DO-backed) runtime: a client-issued idempotency key dedups a replayed call
 * to the **cached** result without re-running the handler, and an
 * optimistic-concurrency conflict throws back to the caller as an error
 * rather than triggering an internal retry of the handler. So a mutation
 * handler body runs at most once per logical write, and `Date.now()` inside
 * one is stable — the premise this lint used to apply uniformly (borrowed
 * from Convex's OCC-retries-the-handler model, which does not hold here) was
 * responsible for 193 of 385 non-INFO findings on one real codebase, all from
 * the ordinary "stamp `createdAt`" pattern. Dropped to INFO rather than
 * silenced: a mutation invoked from inside a workflow step or queue consumer
 * CAN be re-dispatched if the surrounding step/consumer itself replays (a
 * fresh `ctx.runMutation` call from the step's perspective, not a replay this
 * lint can distinguish from any other mutation call), so the finding stays as
 * a breadcrumb rather than disappearing outright. See the "Determinism: what
 * actually replays" section of the `@lunora/server` docs.
 *
 * This lint runs when the codegen feeder has supplied call evidence
 * (`context.nondeterministicCalls` present); a runtime caller with no evidence
 * flags nothing rather than raising false alarms. The feeder records calls only
 * inside `query`/`mutation` handlers, so `action(...)` bodies never reach here.
 */
const nondeterministicQueryMutation: Lint = {
    categories: ["SCHEMA"],
    description:
        "A `query`/`mutation` handler calls a non-deterministic API (`Date.now`, `Math.random`, `crypto.randomUUID`, `crypto.getRandomValues`, or `fetch`). A `query` may be re-run by a live subscription, so non-determinism there can flicker between evaluations (WARN). An ordinary `mutation` handler does not replay on this runtime — it runs at most once per logical write — so this is informational there (INFO) unless the mutation is itself invoked from a workflow step or queue consumer that can replay.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "nondeterministic_query_mutation",
    remediation:
        "For a `query`: move the non-deterministic call into an `action(...)` (which runs once and may use ambient APIs), then pass the computed value into the mutation as an argument, or accept that the value may differ across re-evaluations. For an ordinary `mutation`: no action needed — the handler runs at most once per logical write on this runtime. If the mutation is dispatched from inside a workflow step or queue consumer, treat it like an action value instead, since the surrounding step/consumer can replay.",
    run: (context) => {
        // No call evidence supplied → nothing to assert (mirrors auth_api_call_without_headers).
        if (context.nondeterministicCalls === undefined) {
            return [];
        }

        const findings = [];

        // Per-(file, line, callee) occurrence counter: two calls of the same
        // non-deterministic API on the same source line (e.g.
        // `[Math.random(), Math.random()]`) would otherwise share an identical
        // cacheKey and collapse to one dismissible finding.
        const occurrenceCount = new Map<string, number>();

        for (const call of context.nondeterministicCalls) {
            const baseKey = `${call.file}:${call.line.toString()}:${call.callee}`;
            const occurrence = (occurrenceCount.get(baseKey) ?? 0) + 1;

            occurrenceCount.set(baseKey, occurrence);

            // Suffix the occurrence index only for the second and beyond so
            // existing single-occurrence cacheKeys remain stable across runs.
            const occurrenceSuffix = occurrence > 1 ? `:${occurrence.toString()}` : "";
            const metadata = { callee: call.callee, exportName: call.exportName, file: call.file, kind: call.kind, line: call.line };

            // Mutations don't replay under ordinary dispatch on this runtime (see
            // the module doc comment) — the premise a WARN needs does not hold,
            // so this drops to INFO rather than staying at the same severity as
            // the genuinely-hazardous query case.
            if (call.kind === "mutation") {
                findings.push(
                    emit(nondeterministicQueryMutation, {
                        cacheKey: `nondeterministic_query_mutation:${baseKey}${occurrenceSuffix}`,
                        detail: `\`${call.callee}(…)\` in ${call.exportName} (${call.file}:${call.line.toString()}) runs inside a mutation handler. Ordinary mutations don't replay on this runtime (idempotency dedup returns a cached result rather than re-running the handler, and an OCC conflict throws to the caller instead of retrying internally), so this is informational — no action needed unless \`${call.exportName}\` is invoked from a workflow step or queue consumer that can itself replay.`,
                        facing: "INTERNAL",
                        level: "INFO",
                        metadata,
                    }),
                );

                continue;
            }

            findings.push(
                emit(nondeterministicQueryMutation, {
                    cacheKey: `nondeterministic_query_mutation:${baseKey}${occurrenceSuffix}`,
                    detail: `\`${call.callee}(…)\` in ${call.exportName} (${call.file}:${call.line.toString()}) runs inside a query handler — a live subscription may re-run this query, so the result can differ between evaluations. Compute it in an \`action\` and pass the value into the mutation as an argument.`,
                    metadata,
                }),
            );
        }

        return findings;
    },
    source: "static",
    title: "Non-deterministic call in query/mutation handler",
};

export default nondeterministicQueryMutation;
