import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a `@lunora/notify` send (`ctx.notify.*` / `ctx.push.*`) inside a
 * `query(...)` or `mutation(...)` handler body.
 *
 * A notification send is external I/O — a `fetch` to a Web Push service or FCM.
 * Like `fetch`/`ctx.sql`, it is non-deterministic, so it breaks the determinism
 * the coordinator relies on when it re-runs a query on subscription re-evaluation
 * or a mutation on OCC retry — a retried mutation would fire the notification
 * again (duplicate pushes). `ctx.notify` / `ctx.push` are therefore wired onto
 * `ActionCtx` only and belong exclusively in `action(...)` handlers.
 *
 * This lint runs when the codegen feeder has supplied send evidence
 * (`context.notifyCalls` present); a runtime caller with no evidence flags
 * nothing rather than raising false alarms. The feeder records sends only inside
 * `query`/`mutation` handlers, so `action(...)` bodies never reach here.
 */
const notifySendOutsideAction: Lint = {
    categories: ["SCHEMA"],
    description:
        "A `query`/`mutation` handler sends a notification via `ctx.notify`/`ctx.push`. A send is external I/O (a `fetch` to a push service / FCM): it is non-deterministic like `fetch`, and a mutation re-run on OCC retry would re-send it (duplicate pushes). These facades are available on `ActionCtx` only and must be confined to `action` handlers.",
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
                detail: `\`${call.callee}(…)\` in ${call.exportName} (${call.file}:${call.line.toString()}) runs inside a ${call.kind} handler — a notification send is non-deterministic external I/O and a retried ${call.kind} would re-send it. Move it into an \`action\`, or enqueue/schedule the send.`,
                metadata: { callee: call.callee, exportName: call.exportName, file: call.file, kind: call.kind, line: call.line },
            }),
        );
    },
    source: "static",
    title: "Notification send used outside an action",
};

export default notifySendOutsideAction;
