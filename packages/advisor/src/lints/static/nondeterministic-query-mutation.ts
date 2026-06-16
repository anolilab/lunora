import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a non-deterministic API call inside a `query(...)` or `mutation(...)`
 * handler body.
 *
 * Lunora queries and mutations must be **deterministic**: the coordinator may
 * re-run a mutation on optimistic-concurrency (OCC) retry and a query on
 * subscription re-evaluation, so a handler that reads wall-clock time, draws
 * randomness, or hits the network can produce different results on each run —
 * breaking read-your-writes, cache invalidation, and replayable history.
 * `Date.now`, `Math.random`, `crypto.randomUUID`, `crypto.getRandomValues`, and
 * `fetch` are therefore disallowed in query/mutation handlers and belong in an
 * `action(...)`, which runs exactly once and may use ambient/non-deterministic
 * APIs freely (pass the result into a mutation as an argument).
 *
 * This lint runs when the codegen feeder has supplied call evidence
 * (`context.nondeterministicCalls` present); a runtime caller with no evidence
 * flags nothing rather than raising false alarms. The feeder records calls only
 * inside `query`/`mutation` handlers, so `action(...)` bodies never reach here.
 */
const nondeterministicQueryMutation: Lint = {
    categories: ["SCHEMA"],
    description:
        "A `query`/`mutation` handler calls a non-deterministic API (`Date.now`, `Math.random`, `crypto.randomUUID`, `crypto.getRandomValues`, or `fetch`). These handlers may be re-run on OCC retry / subscription re-evaluation, so they must be deterministic — time, randomness, and network belong in an `action`.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "nondeterministic_query_mutation",
    remediation:
        "Move the non-deterministic call into an `action(...)` (which runs once and may use ambient APIs), then pass the computed value into the mutation as an argument — e.g. compute `Date.now()` in the action and call `ctx.runMutation(api.…, { now })`. Take generated ids/timestamps as args instead of producing them in the handler.",
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

            findings.push(
                emit(nondeterministicQueryMutation, {
                    cacheKey: `nondeterministic_query_mutation:${baseKey}${occurrenceSuffix}`,
                    detail: `\`${call.callee}(…)\` in ${call.exportName} (${call.file}:${call.line.toString()}) runs inside a ${call.kind} handler — query/mutation handlers must be deterministic. Compute it in an \`action\` and pass the value into the mutation as an argument.`,
                    metadata: { callee: call.callee, exportName: call.exportName, file: call.file, kind: call.kind, line: call.line },
                }),
            );
        }

        return findings;
    },
    source: "static",
    title: "Non-deterministic call in query/mutation handler",
};

export default nondeterministicQueryMutation;
