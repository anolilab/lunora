/**
 * Report what the lint-ignore writers did, in one place.
 *
 * `init` and `add` both call the writers and both have to say what changed. Two
 * copies of the same loop is how one of them ends up with a worse message than
 * the other and nobody notices — which had already started: one named the tool
 * and the effect, the other said nothing at all.
 */
import type { LintIgnoreOutcome } from "@lunora/config";

import type { Logger } from "./logger";

/**
 * Log each outcome. Silent for `unchanged` — the writers are idempotent and run
 * on every `lunora add`, so "nothing to do" is the common case and does not
 * deserve a line.
 * @param outcomes What the writers reported, in the order they ran.
 * @param logger Where to write.
 */
const reportLintIgnoreOutcomes = (outcomes: ReadonlyArray<LintIgnoreOutcome>, logger: Logger): void => {
    for (const outcome of outcomes) {
        if (outcome.status === "created" || outcome.status === "updated") {
            logger.success(`${outcome.status} ${outcome.path} — ${outcome.tool} now skips Lunora's generated files`);
        }

        // Two cases reach `manual`, and neither is safe to do automatically: an
        // ESLint flat config is arbitrary JavaScript, and a config inherited from
        // a monorepo root belongs to the whole workspace rather than this package.
        // Print exactly what to add instead of leaving it to surface as a few
        // thousand lint errors.
        if (outcome.status === "manual" && outcome.snippet !== undefined) {
            logger.warn(`${outcome.path} needs an entry so ${outcome.tool} skips Lunora's generated files — add:\n${outcome.snippet}`);
        }
    }
};

// eslint-disable-next-line import/prefer-default-export -- named export: the repo's convention is named-only, and a sibling export will land here as the reporting surface grows
export { reportLintIgnoreOutcomes };
