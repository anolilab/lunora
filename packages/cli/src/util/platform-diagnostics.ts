/**
 * Reporting for codegen's platform-portability diagnostics.
 *
 * Every path that runs codegen has to surface these, because each one means the
 * emitted `ctx.*` surface does not match what the target can actually provide —
 * either a used feature was dropped, or the target has no capability matrix at
 * all and nothing was gated. A path that runs codegen and stays silent about
 * them ships that mismatch to production, which is the failure the whole target
 * seam exists to prevent.
 *
 * Shared rather than copied. The callers are `commands/codegen/handler.ts`,
 * `commands/deploy/handler.ts`, `commands/verify/handler.ts` and the dev
 * watcher in `util/codegen-watch.ts`; `@lunora/vite`'s codegen plugin renders
 * the same diagnostics through its own `advisoryLine`. A reporting rule copied
 * per caller is a rule that one caller ends up without — `verify` was that
 * caller: it resolves and validates the deploy target, runs codegen with it,
 * and used to drop the diagnostics on the floor.
 *
 * Two further `runCodegen` calls deliberately stay silent, and both are covered
 * elsewhere: `dev`'s pre-sidecar warm-up (the codegen watcher it starts reports
 * the same run moments later) and `advisor`, which passes no target at all and
 * reports schema advisories rather than gating a deploy.
 */
import type { PlatformDiagnostic } from "@lunora/codegen";

import type { Logger } from "./logger";

/**
 * Log every diagnostic, and hand the caller ALL of them, partitioned by level.
 *
 * Error-level diagnostics fail. Both kinds carry `level: "error"` because each
 * "drops or misdirects an emitted surface" (see `PlatformDiagnostic`), and
 * reporting that as a warning with a zero exit is how an app ends up built
 * against a surface its target cannot serve while CI stays green.
 *
 * Returning only the FIRST error was the same class of bug one level down: the
 * console got the whole list while `lunora verify --format json` — the
 * documented CI gate — put one message in its `errors` array and dropped the
 * rest, so a pipeline reading that output saw an incomplete picture of why the
 * app cannot run on its target.
 * @param diagnostics What `runCodegen` returned.
 * @param logger Where the lines go.
 * @returns every error-level and warn-level message; both empty when nothing was reported.
 */
const reportPlatformDiagnostics = (
    diagnostics: ReadonlyArray<PlatformDiagnostic>,
    logger: Logger,
): { errors: ReadonlyArray<string>; warnings: ReadonlyArray<string> } => {
    if (diagnostics.length === 0) {
        return { errors: [], warnings: [] };
    }

    const lines = diagnostics.map(
        (diagnostic) => `  [${diagnostic.level.toUpperCase()}] ${diagnostic.name} — ${diagnostic.message}\n      ↳ ${diagnostic.remediation}`,
    );
    const errors = diagnostics.filter((diagnostic) => diagnostic.level === "error").map((diagnostic) => diagnostic.message);
    const warnings = diagnostics.filter((diagnostic) => diagnostic.level !== "error").map((diagnostic) => diagnostic.message);
    const heading = `${String(diagnostics.length)} platform ${diagnostics.length === 1 ? "diagnostic" : "diagnostics"}:\n${lines.join("\n")}`;

    if (errors.length === 0) {
        logger.warn(heading);

        return { errors: [], warnings };
    }

    logger.error(heading);

    return { errors, warnings };
};

export default reportPlatformDiagnostics;
