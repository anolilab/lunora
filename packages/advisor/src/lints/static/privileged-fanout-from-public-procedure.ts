import emit from "../../finding";
import { mightExhibit } from "../../procedure-protections";
import type { Lint } from "../../types";

/**
 * Flags a public procedure whose handler fans work out to a privileged,
 * cost-bearing dispatch surface without a rate-limit guard.
 *
 * `ctx.scheduler.runAfter` / `runAt`, a `ctx.queues.&lt;name>` producer send, and
 * `ctx.workflows.&lt;name>.create` all enqueue work that runs later under the
 * system identity (RLS disabled) and bills against the account. Triggered from a
 * `.public()` procedure with no rate limit, an anonymous caller can drive that
 * dispatch in a loop — a cost-amplification / denial-of-wallet vector, and a way
 * to flood a privileged async surface. The fix is to gate the public entry point
 * with a rate limit (or make it internal and trigger it from a guarded path).
 *
 * Runs only when the codegen feeder supplies procedure-protection evidence
 * (`context.procedureProtections`); a runtime caller flags nothing. One finding
 * per unguarded public fan-out procedure.
 */
const privilegedFanoutFromPublicProcedure: Lint = {
    categories: ["SECURITY"],
    description:
        "A public procedure fans work out to a privileged dispatch surface (`ctx.scheduler.runAfter`/`runAt`, a `ctx.queues.<name>` send, or `ctx.workflows.<name>.create`) with no rate-limit guard. Each dispatch runs later under the system identity and bills the account, so an anonymous caller can amplify cost and flood the async surface in a loop.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "privileged_fanout_from_public_procedure",
    remediation:
        "Gate the public entry point with a rate limit (`.use(rateLimit(...))` or a `protectPublic({ rateLimit })` bundle), or make the fan-out procedure internal and trigger it only from an authenticated, guarded path. Never expose an unbounded scheduler/queue/workflow dispatch to anonymous callers.",
    run: (context) => {
        if (context.procedureProtections === undefined) {
            return [];
        }

        // `fanOut === undefined` means the feeder couldn't read the handler body
        // (a cross-file handler) — stays fail-closed, not cleared.
        return context.procedureProtections
            .filter((procedure) => mightExhibit(procedure.fanOut) && procedure.visibility === "public" && !procedure.usesRateLimit)
            .map((procedure) =>
                emit(privilegedFanoutFromPublicProcedure, {
                    cacheKey: `privileged_fanout_from_public_procedure:${procedure.file}:${procedure.exportName}`,
                    detail: `\`${procedure.exportName}\` (${procedure.file}) is public and fans work out to a privileged dispatch surface (scheduler/queue/workflow) with no rate limit — an anonymous caller can drive that billable, system-identity dispatch in a loop. Add a rate-limit guard, or make it internal and trigger it from an authenticated path.`,
                    metadata: { exportName: procedure.exportName, file: procedure.file, kind: procedure.kind },
                }),
            );
    },
    source: "static",
    title: "Public procedure fans out to a privileged dispatch surface",
};

export default privilegedFanoutFromPublicProcedure;
