/**
 * Shared "which findings are ERROR-level" read for a {@link CodegenResult}.
 *
 * Every caller that gates a run on codegen's output — `lunora codegen`,
 * `lunora deploy`, and the Vite plugin's `vite build` — needs the same
 * deduplicated, sorted name list for its ERROR-level advisories and platform
 * diagnostics. Before this file existed each of the three computed it inline
 * with `[...new Set(...)].toSorted(...)`, and they had already drifted:
 * `codegen-plugin.ts`'s copy left the names unsorted. Presentation (message
 * wording, whether the two categories are folded into one combined message,
 * strict/CI opt-outs) stays each caller's own job — this only owns the
 * filter + dedup + sort so that part can't drift again.
 */
import type { Finding } from "@lunora/advisor";

import type { PlatformDiagnostic } from "./platform-target";
import type { CodegenResult } from "./run-codegen";

const sortedUniqueNames = (names: Iterable<string>): ReadonlyArray<string> => [...new Set(names)].toSorted((a, b) => a.localeCompare(b));

/** Deduplicated, sorted names of every ERROR-level advisory in `advisories`. */
const errorAdvisoryNames = (advisories: ReadonlyArray<Pick<Finding, "level" | "name">>): ReadonlyArray<string> =>
    sortedUniqueNames(advisories.filter((advisory) => advisory.level === "ERROR").map((advisory) => advisory.name));

/** Deduplicated, sorted names of every error-level platform diagnostic in `platformDiagnostics`. */
const errorPlatformDiagnosticNames = (platformDiagnostics: ReadonlyArray<Pick<PlatformDiagnostic, "level" | "name">>): ReadonlyArray<string> =>
    sortedUniqueNames(platformDiagnostics.filter((diagnostic) => diagnostic.level === "error").map((diagnostic) => diagnostic.name));

/**
 * Convenience read combining both categories from a full {@link CodegenResult}
 * — the shape the Vite plugin's `buildBlockingMessage` needs, which (unlike
 * the CLI's `lunora codegen`/`lunora deploy`) folds ERROR-level advisories and
 * platform diagnostics into a single blocking message with no strict/CI
 * opt-out.
 */
const describeErrorLevelFindings = (
    result: Pick<CodegenResult, "advisories" | "platformDiagnostics">,
): { advisoryNames: ReadonlyArray<string>; platformDiagnosticNames: ReadonlyArray<string> } => {
    return {
        advisoryNames: errorAdvisoryNames(result.advisories),
        platformDiagnosticNames: errorPlatformDiagnosticNames(result.platformDiagnostics),
    };
};

export { describeErrorLevelFindings, errorAdvisoryNames, errorPlatformDiagnosticNames };
