/**
 * The "which linter and formatter do you use?" step of `lunora init`.
 *
 * Codegen output lands in the repo and is linted like source, so without this a
 * project's first lint run reports thousands of errors in files nobody wrote —
 * and the developer spends an afternoon rediscovering the same five paths every
 * other Lunora project has already excluded.
 *
 * It asks rather than assumes because the answer is not derivable: a template
 * ships no lint tooling, so at `init` there is usually nothing to detect. What
 * IS detectable is pre-selected, so the prompt confirms rather than guesses —
 * and `lunora add` later re-runs the same writers from detection alone, with no
 * prompt at all.
 *
 * The prompt and the writer are injected ({@link LintToolOfferDeps}) so the flow
 * is unit-testable without a TTY, matching `offer-extras`.
 */
import type { LintIgnoreOutcome, LintTool } from "@lunora/config";

import type { Logger } from "../../util/logger";

/** One choice in the multi-select. */
interface LintToolOption {
    description: string;
    label: string;
    value: LintTool;
}

const LINT_TOOL_OPTIONS: ReadonlyArray<LintToolOption> = [
    { description: "Adds an ignores entry to eslint.config.js", label: "ESLint", value: "eslint" },
    { description: "Writes .prettierignore", label: "Prettier", value: "prettier" },
    { description: "Adds negated patterns to biome.json", label: "Biome", value: "biome" },
    { description: "Writes ignorePatterns to .oxlintrc.json", label: "oxlint (oxc)", value: "oxlint" },
];

interface LintToolOfferDeps {
    /** Write the ignores for the chosen tools — `applyLintIgnores` in production. */
    apply: (tools: ReadonlyArray<LintTool>) => LintIgnoreOutcome[];
    /** Tools already detectable in the scaffolded project — pre-selected in the prompt. */
    detected: ReadonlyArray<LintTool>;
    /** False in CI / `--yes` / off a TTY: skip the prompt and configure whatever was detected. */
    interactive: boolean;
    logger: Logger;
    multiSelect: (message: string, choices: ReadonlyArray<LintToolOption>, settings?: { defaults?: ReadonlyArray<LintTool> }) => Promise<LintTool[]>;
}

const PROMPT = "Which linter/formatter do you use? We'll tell it to skip Lunora's generated files.";

/**
 * Ask, then configure. Returns the outcomes so a caller can assert without
 * re-reading the filesystem.
 *
 * A non-interactive run configures what was detected instead of prompting —
 * scaffolding must never block automation on a question, and detection is a
 * strictly better answer than doing nothing.
 */
const offerLintTools = async (deps: LintToolOfferDeps): Promise<LintIgnoreOutcome[]> => {
    const chosen = deps.interactive ? await deps.multiSelect(PROMPT, LINT_TOOL_OPTIONS, { defaults: deps.detected }) : [...deps.detected];

    if (chosen.length === 0) {
        return [];
    }

    const outcomes = deps.apply(chosen);

    for (const outcome of outcomes) {
        if (outcome.status === "created" || outcome.status === "updated") {
            deps.logger.success(`${outcome.status} ${outcome.path}`);
        }

        // Only reachable when the template shipped an ESLint config of its own —
        // it is arbitrary JavaScript, so it is reported rather than rewritten.
        if (outcome.status === "manual" && outcome.snippet !== undefined) {
            deps.logger.warn(`Add this to the array exported by ${outcome.path} so ESLint skips Lunora's generated files:\n${outcome.snippet}`);
        }
    }

    return outcomes;
};

export { LINT_TOOL_OPTIONS, PROMPT as LINT_TOOL_PROMPT, offerLintTools };
export type { LintToolOfferDeps, LintToolOption };
