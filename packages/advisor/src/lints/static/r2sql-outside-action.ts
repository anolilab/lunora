import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags an R2 SQL `ctx.r2sql` access inside a `query(...)` or `mutation(...)`
 * handler body.
 *
 * R2 SQL (`@lunora/bindings/r2sql`) queries Apache Iceberg tables over an **external**
 * REST endpoint Lunora does not own — there is no Workers binding, every query
 * is an HTTPS round-trip. A `ctx.r2sql` query is therefore non-deterministic
 * (exactly like `fetch`), which breaks the determinism the coordinator relies on
 * when it re-runs a query on subscription re-evaluation or a mutation on OCC
 * retry. And R2 SQL reads are invisible to the DO/SQLite change-feed, so a
 * subscription will never re-fire on them. `ctx.r2sql` is therefore wired onto
 * `ActionCtx` **only** and belongs exclusively in `action(...)` handlers; using
 * it in a query/mutation is the same class of bug as `fetch`/`Date.now`.
 *
 * This mirrors `hyperdrive_outside_action` — the action-only enforcement teeth
 * for external, non-reactive I/O. Runtime enforcement is still absent (see
 * `MEMORY.md` "Query/mutation determinism not enforced"), so the lint is the
 * guardrail.
 *
 * This lint runs when the codegen feeder has supplied access evidence
 * (`context.r2sqlCalls` present); a runtime caller with no evidence flags nothing
 * rather than raising false alarms. The feeder records accesses only inside
 * `query`/`mutation` handlers, so `action(...)` bodies never reach here.
 */
const r2sqlOutsideAction: Lint = {
    categories: ["SCHEMA"],
    description:
        "A `query`/`mutation` handler accesses R2 SQL via `ctx.r2sql`. R2 SQL queries external Apache Iceberg tables over REST (no Workers binding): queries are non-deterministic (like `fetch`) and the reads are invisible to live queries. `ctx.r2sql` is available on `ActionCtx` only and must be confined to `action` handlers.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "r2sql_outside_action",
    remediation:
        "Move the `ctx.r2sql` access into an `action(...)` (the only context where it is typed), where external I/O is allowed. If a query/mutation needs the data, have the action read it via `ctx.r2sql` and write a projection into a `defineSchema` DO/D1 table — that write is tracked by live queries, whereas R2 SQL is not.",
    run: (context) => {
        // No access evidence supplied → nothing to assert (mirrors hyperdrive_outside_action).
        if (context.r2sqlCalls === undefined) {
            return [];
        }

        return context.r2sqlCalls.map((call) =>
            emit(r2sqlOutsideAction, {
                cacheKey: `r2sql_outside_action:${call.file}:${call.line.toString()}:${call.callee}`,
                detail: `\`${call.callee}(…)\` in ${call.exportName} (${call.file}:${call.line.toString()}) runs inside a ${call.kind} handler — R2 SQL's \`ctx.r2sql\` is non-deterministic and non-reactive, so it is available only in actions. Move the external query into an \`action\` and project the result into a Lunora table if a query/mutation needs it.`,
                metadata: { callee: call.callee, exportName: call.exportName, file: call.file, kind: call.kind, line: call.line },
            }),
        );
    },
    source: "static",
    title: "R2 SQL `ctx.r2sql` used outside an action",
};

export default r2sqlOutsideAction;
