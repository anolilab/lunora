import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a `ctx.run`/`context.run` back into a Lunora function from inside a
 * `defineQueue` push handler or a `defineWorkflow` handler, when the dispatch's
 * args reference the handler's untrusted payload (`context.params` for a
 * workflow, a `for (… of batch.messages)` body for a queue) **and** the target
 * enforces row-level security.
 *
 * A queue/workflow handler runs under the deployment's **system identity** with
 * end-user RLS disabled — that is by design, so the handler can touch any row.
 * But the payload it receives is attacker-influenced: a queue body is whatever
 * was enqueued (often straight from a public mutation's `args`), and a
 * workflow's `params` are set by the `.create({ params })` caller. Forwarding
 * that payload into a function whose own protection is a *row policy* is a
 * confused-deputy: the policy that would have rejected the caller's request is
 * skipped because the handler, not the user, is now the principal. Any field
 * the payload controls that the target's RLS keys on (owner id, tenant id, row
 * id) becomes an act-as-any-user / cross-tenant write.
 *
 * The lint is deliberately narrow to stay false-positive-free: it fires **only**
 * when the resolved target (`api.<file>.<export>`) is found in the
 * RLS-procedure evidence with `usesRls: true`. A dispatch into a function that
 * does its own arg validation and carries no row policy (the common, correct
 * case — e.g. a welcome-message mutation with no `rls`) is not flagged. Runs
 * only when the codegen feeder supplies dispatch evidence
 * (`context.privilegedDispatches`); a runtime caller flags nothing.
 */
const privilegedDispatchUnvalidatedPayload: Lint = {
    categories: ["SECURITY"],
    description:
        "A `defineQueue`/`defineWorkflow` handler forwards its untrusted payload (queue body / workflow params) straight into a `ctx.run` dispatch whose target is RLS-gated. The handler runs under the system identity with RLS disabled, so the target's row policy — the only thing guarding it — is bypassed, letting a caller act as any user / write across tenants.",
    facing: "EXTERNAL",
    level: "ERROR",
    name: "privileged_dispatch_unvalidated_payload",
    remediation:
        "Don't forward an unchecked queue body / workflow param into an RLS-gated function. Re-derive the ownership/identity keys from server-trusted state (or an argument you validate against it) before dispatching, or route the work through a function that re-checks the caller's identity rather than relying on the row policy the privileged handler skips.",
    run: (context) => {
        if (context.privilegedDispatches === undefined) {
            return [];
        }

        const rlsProcedures = context.rlsProcedures ?? [];

        // Fire only when the dispatched target enforces a row policy — that is the
        // guard the system-identity handler skips. A target that isn't found in the
        // RLS-procedure evidence, or is found without `.use(rls(...))`, is not flagged:
        // its protection (arg validation, no row policy) survives the privileged call.
        const targetUsesRls = (targetFile: string, targetExport: string): boolean =>
            rlsProcedures.some((procedure) => procedure.usesRls && procedure.file === targetFile && procedure.exportName === targetExport);

        return context.privilegedDispatches
            .filter((dispatch) => targetUsesRls(dispatch.targetFile, dispatch.targetExport))
            .map((dispatch) => {
                const handlerKind = dispatch.dispatchKind === "queue" ? "queue" : "workflow";
                const payloadSource = dispatch.dispatchKind === "queue" ? "queue message body" : "workflow params";

                return emit(privilegedDispatchUnvalidatedPayload, {
                    cacheKey: `privileged_dispatch_unvalidated_payload:${dispatch.file}:${dispatch.line.toString()}`,
                    detail: `The ${handlerKind} handler \`${dispatch.handlerExport}\` (${dispatch.file}:${dispatch.line.toString()}) forwards its untrusted ${payloadSource} straight into \`${dispatch.targetFile}.${dispatch.targetExport}\`, which is guarded by \`.use(rls(...))\`. The handler runs under the system identity with RLS disabled, so the target's row policy is bypassed — any ownership/identity field the payload controls lets a caller act as another user or write across tenants. Re-derive the identity keys from server-trusted state before dispatching, or route through a function that re-checks the caller.`,
                    metadata: {
                        dispatchKind: dispatch.dispatchKind,
                        file: dispatch.file,
                        handlerExport: dispatch.handlerExport,
                        line: dispatch.line,
                        targetExport: dispatch.targetExport,
                        targetFile: dispatch.targetFile,
                    },
                });
            });
    },
    source: "static",
    title: "Privileged handler forwards untrusted payload into an RLS-gated function",
};

export default privilegedDispatchUnvalidatedPayload;
