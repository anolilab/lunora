/**
 * The ERROR-advisory gate shared by `lunora codegen` and `lunora deploy`:
 * both fail the run on an ERROR-level schema advisory the same way, opting
 * out via the same `--no-strict-advisories` flag that defaults off CI
 * detection. The two copies had already drifted once — this file exists so a
 * third drift needs a deliberate second implementation, not a silent copy.
 *
 * Platform diagnostics are NOT this gate's concern: they stay on
 * `reportPlatformDiagnostics` (`./platform-diagnostics.ts`), which is always
 * blocking (no strict opt-out) and returns the diagnostic's own message
 * rather than a name-list summary — a different, non-optional contract this
 * gate must not fold into.
 */
import type { Finding } from "@lunora/advisor";
import { errorAdvisoryNames } from "@lunora/codegen";

interface AdvisoryGateOptions {
    /** The command's own `--strict-advisories`/`--no-strict-advisories` option; `undefined` falls back to CI detection. */
    strictAdvisories?: boolean;
}

interface AdvisoryGateResult<TAdvisory extends Pick<Finding, "level" | "name">> {
    /** Every ERROR-level advisory found, regardless of `strict` — callers report the count even when not blocking. */
    errorAdvisories: ReadonlyArray<TAdvisory>;
    /** Deduplicated, sorted names of `errorAdvisories`, ready to join into a message. */
    names: ReadonlyArray<string>;
    /** True when `errorAdvisories` is non-empty AND the gate is strict — the caller's abort signal. */
    shouldBlock: boolean;
}

/**
 * CI is the default gate: a pipeline should fail on an ERROR advisory, a
 * local run should not have its workflow interrupted by one.
 */
const resolveStrictAdvisories = (options: AdvisoryGateOptions): boolean =>
    options.strictAdvisories ?? (process.env["CI"] !== undefined && process.env["CI"] !== "");

/**
 * Filter, dedup+sort names, and decide whether `strict` mode should block the
 * run. Callers append their own remediation tail to the message they build
 * from `names`/`errorAdvisories.length` — this only owns the part that had
 * already drifted once between `lunora codegen` and `lunora deploy`.
 *
 * Generic over the advisory shape (rather than pinned to `@lunora/advisor`'s
 * full `Finding`) because `lunora codegen`'s own result type re-maps
 * `Finding` down to a plain `{ detail, level, name, remediation }` for its
 * JSON output — this only ever reads `level`/`name`, so it accepts either.
 */
const evaluateAdvisoryGate = <TAdvisory extends Pick<Finding, "level" | "name">>(
    advisories: ReadonlyArray<TAdvisory>,
    strict: boolean,
): AdvisoryGateResult<TAdvisory> => {
    const errorAdvisories = advisories.filter((advisory) => advisory.level === "ERROR");

    return { errorAdvisories, names: errorAdvisoryNames(advisories), shouldBlock: errorAdvisories.length > 0 && strict };
};

export { evaluateAdvisoryGate, resolveStrictAdvisories };
export type { AdvisoryGateOptions, AdvisoryGateResult };
