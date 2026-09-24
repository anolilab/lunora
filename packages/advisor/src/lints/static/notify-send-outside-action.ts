import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a `@lunora/notify` send (`ctx.notify.*` / `ctx.push.*`) inside a
 * `query(...)` or `mutation(...)` handler body.
 *
 * A notification send is external I/O — a `fetch` to a Web Push service or FCM —
 * and it cannot be taken back once it leaves. Neither hazard below is an internal
 * OCC retry: this runtime has none (a conflict throws back to the caller, and
 * idempotency dedup answers a replayed call from cache rather than re-running the
 * handler — see `nondeterministic_query_mutation`).
 *
 * A `query` handler genuinely IS re-run: every live subscription that reads it
 * re-evaluates it whenever a table it depends on changes. A send there fires once
 * per re-evaluation — duplicate pushes for one logical read.
 *
 * A `mutation` handler runs inside the shard's storage transaction, which can roll
 * back on an OCC conflict, an RLS denial, a validator, or a failed row mid-batch.
 * The push is already gone, so a user is notified about a write that never landed.
 * This is the same irreversibility that makes `ctx.scheduler.runAfter` buffer until
 * after commit and keeps `ctx.storage` read-only in a mutation. Duplicates follow
 * from the retry: the client outbox re-dispatches a transiently failed write, and a
 * replaying workflow step or queue consumer calls the mutation again — each a fresh
 * dispatch that sends.
 *
 * `ctx.notify` / `ctx.push` are therefore wired onto `ActionCtx` only and belong
 * exclusively in `action(...)` handlers.
 *
 * This lint runs when the codegen feeder has supplied send evidence
 * (`context.notifyCalls` present); a runtime caller with no evidence flags
 * nothing rather than raising false alarms. The feeder records sends only inside
 * `query`/`mutation` handlers, so `action(...)` bodies never reach here.
 */
const notifySendOutsideAction: Lint = {
    categories: ["SCHEMA"],
    description:
        "A `query`/`mutation` handler sends a notification via `ctx.notify`/`ctx.push`. A send is external I/O (a `fetch` to a push service / FCM) and cannot be undone: a `query` is re-run by every live subscription that reads it, so the send repeats per re-evaluation, and a `mutation` runs inside a transaction that can roll back, so the push goes out for a write that never landed. These facades are available on `ActionCtx` only and must be confined to `action` handlers.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "notify_send_outside_action",
    remediation:
        "Move the `ctx.notify`/`ctx.push` send into an `action(...)`, where external I/O is allowed. If a query/mutation must trigger a notification, have it enqueue the send (`enqueuePushBroadcast` from `@lunora/notify`, onto a `ctx.queues.*` producer) or schedule an action — the queue/scheduler runs the send exactly once, off the transactional path.",
    run: (context) => {
        // No send evidence supplied → nothing to assert (mirrors hyperdrive_outside_action).
        if (context.notifyCalls === undefined) {
            return [];
        }

        return context.notifyCalls.map((call) =>
            emit(notifySendOutsideAction, {
                cacheKey: `notify_send_outside_action:${call.file}:${call.line.toString()}:${call.callee}`,
                detail:
                    call.kind === "query"
                        ? `\`${call.callee}(…)\` in ${call.exportName} (${call.file}:${call.line.toString()}) runs inside a query handler — a live subscription re-runs this query whenever a table it reads changes, so the send fires again on every re-evaluation. Move it into an \`action\`, or enqueue/schedule the send.`
                        : `\`${call.callee}(…)\` in ${call.exportName} (${call.file}:${call.line.toString()}) runs inside a mutation handler — the mutation runs inside a transaction that can roll back (OCC conflict, RLS denial, validator, failed row mid-batch) but the send cannot, so the notification goes out for a write that never landed, and the caller's retry sends again. Move it into an \`action\`, or enqueue/schedule the send.`,
                metadata: { callee: call.callee, exportName: call.exportName, file: call.file, kind: call.kind, line: call.line },
            }),
        );
    },
    source: "static",
    title: "Notification send used outside an action",
};

export default notifySendOutsideAction;
