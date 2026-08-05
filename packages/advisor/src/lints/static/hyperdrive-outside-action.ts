import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a Hyperdrive `ctx.sql` access inside a `query(...)` or `mutation(...)`
 * handler body.
 *
 * Hyperdrive (`@lunora/hyperdrive`) points at an **external** Postgres/MySQL
 * database Lunora does not own. A `ctx.sql` query is a network round-trip with a
 * mutable result — non-deterministic, exactly like `fetch` — so it breaks the
 * determinism the coordinator relies on when it re-runs a query on subscription
 * re-evaluation or a mutation on OCC retry. Worse, external writes are invisible
 * to the DO/SQLite change-feed, so a subscription will never re-fire on them.
 * `ctx.sql` is therefore wired onto `ActionCtx` **only** and belongs exclusively
 * in `action(...)` handlers; using it in a query/mutation is the same class of
 * bug as `fetch`/`Date.now`.
 *
 * This is the enforcement teeth behind the action-only rule — runtime
 * enforcement is still absent (see `MEMORY.md` "Query/mutation determinism not
 * enforced"), so the lint is the guardrail.
 *
 * This lint runs when the codegen feeder has supplied access evidence
 * (`context.hyperdriveCalls` present); a runtime caller with no evidence flags
 * nothing rather than raising false alarms. The feeder records accesses only
 * inside `query`/`mutation` handlers, so `action(...)` bodies never reach here.
 */
const hyperdriveOutsideAction: Lint = {
    categories: ["SCHEMA"],
    description:
        "A `query`/`mutation` handler accesses Hyperdrive via `ctx.sql`. Hyperdrive hits an external database Lunora does not own: queries are non-deterministic (like `fetch`) and external writes are invisible to live queries. `ctx.sql` is available on `ActionCtx` only and must be confined to `action` handlers.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "hyperdrive_outside_action",
    remediation:
        "Move the `ctx.sql` access into an `action(...)` (the only context where it is typed), where external I/O is allowed. If a query/mutation needs the data, have the action read it via `ctx.sql` and write a projection into a `defineSchema` DO/D1 table — that write is tracked by live queries, whereas the external DB is not.",
    run: (context) => {
        // No access evidence supplied → nothing to assert (mirrors nondeterministic_query_mutation).
        if (context.hyperdriveCalls === undefined) {
            return [];
        }

        return context.hyperdriveCalls.map((call) =>
            emit(hyperdriveOutsideAction, {
                cacheKey: `hyperdrive_outside_action:${call.file}:${call.line.toString()}:${call.callee}`,
                detail: `\`${call.callee}(…)\` in ${call.exportName} (${call.file}:${call.line.toString()}) runs inside a ${call.kind} handler — Hyperdrive's \`ctx.sql\` is non-deterministic and non-reactive, so it is available only in actions. Move the external SQL into an \`action\` and project the result into a Lunora table if a query/mutation needs it.`,
                metadata: { callee: call.callee, exportName: call.exportName, file: call.file, kind: call.kind, line: call.line },
            }),
        );
    },
    source: "static",
    title: "Hyperdrive `ctx.sql` used outside an action",
};

export default hyperdriveOutsideAction;
