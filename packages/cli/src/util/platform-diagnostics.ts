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
 * Shared rather than copied because five paths report through it — `codegen`,
 * `deploy`, `verify` and the dev watcher here, plus the Vite plugin's own
 * inlined equivalent in `@lunora/vite` — and a reporting rule that lives in five
 * places is a rule that ends up applied in four. `verify` was the one it ended
 * up not applied in: it resolves and validates the deploy target, runs codegen
 * with it, and used to drop the diagnostics on the floor.
 *
 * Two further `runCodegen` calls deliberately stay silent, and both are covered
 * elsewhere: `dev`'s pre-sidecar warm-up (the codegen watcher it starts reports
 * the same run moments later) and `advisor`, which passes no target at all and
 * reports schema advisories rather than gating a deploy.
 */
import type { PlatformDiagnostic } from "@lunora/codegen";

import type { Logger } from "./logger";

/**
 * Log every diagnostic, and report whether any of them should fail the command.
 *
 * Error-level diagnostics fail. Both kinds carry `level: "error"` because each
 * "drops or misdirects an emitted surface" (see `PlatformDiagnostic`), and
 * reporting that as a warning with a zero exit is how an app ends up built
 * against a surface its target cannot serve while CI stays green.
 * @param diagnostics What `runCodegen` returned.
 * @param logger Where the lines go.
 * @returns the first error-level message, or `undefined` when nothing failed.
 */
const reportPlatformDiagnostics = (diagnostics: ReadonlyArray<PlatformDiagnostic>, logger: Logger): string | undefined => {
    if (diagnostics.length === 0) {
        return undefined;
    }

    const lines = diagnostics.map(
        (diagnostic) => `  [${diagnostic.level.toUpperCase()}] ${diagnostic.name} — ${diagnostic.message}\n      ↳ ${diagnostic.remediation}`,
    );
    const errors = diagnostics.filter((diagnostic) => diagnostic.level === "error");
    const heading = `${String(diagnostics.length)} platform ${diagnostics.length === 1 ? "diagnostic" : "diagnostics"}:\n${lines.join("\n")}`;

    if (errors.length === 0) {
        logger.warn(heading);

        return undefined;
    }

    logger.error(heading);

    return errors[0]?.message ?? "platform diagnostics reported an error";
};

export default reportPlatformDiagnostics;
