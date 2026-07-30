import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type { AdvisorMap, BaselineComparison } from "@lunora/advisor";
import { compareToBaseline, parseAdvisorMap, scoreAdvisor } from "@lunora/advisor";
import { runCodegen } from "@lunora/codegen";

import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { Logger } from "../../util/logger";
import { isJsonFormat, loggerForFormat, printJson, validateOutputFormat } from "../../util/output-format";
import DEFAULT_MAP_PATH from "./constants";
import type { AdvisorOptions } from "./index";
import { formatEntry, formatMatrix, formatSummary } from "./report";

interface AdvisorCommandOptions {
    /** Render every procedure as a check matrix, not just the ones with findings. */
    all?: boolean;
    /** Committed map to diff against. A valueless flag arrives as `null`, an explicit one as a path; both mean "gate on it". */
    baseline?: null | string;
    cwd?: string;
    /** Inspect a single `file#exportName`. */
    entry?: string;
    /** Output format: `pretty` (default) or `json`. */
    format?: string;

    /**
     * Stamp for the artifact. Defaults to the epoch rather than "now": the map is
     * meant to be committed, and a wall-clock stamp would leave it dirty in git
     * after every run, training people to ignore the diff that is the gate's whole
     * point. Pass a real timestamp when you want one.
     */
    generatedAt?: string;
    logger: Logger;
    /** Fail when the global score is below this. Raw, so a valueless flag stays distinguishable from 0. */
    minScore?: null | number | string;
    /** Where to write the artifact. */
    out?: string;
    /** Write the artifact; defaults to true. */
    write?: boolean;
}

interface AdvisorCommandResult {
    /** `true` when `--min-score` was given and the score fell below it. */
    belowMinScore?: boolean;
    /** Set when a baseline was requested and could be read. */
    comparison?: BaselineComparison;
    /** Set when the run aborted, or a gate could not be evaluated. */
    error?: string;
    /** The scored map; absent only when the run aborted before scoring. */
    map?: AdvisorMap;
    /** Where the artifact was written, when it was. */
    written?: string;
}

/** See {@link AdvisorCommandOptions.generatedAt} — a committed artifact must not churn. */
const STABLE_STAMP = new Date(0).toISOString();

/** Resolve a possibly-relative path against the project root. */
const resolveIn = (projectRoot: string, path: string): string => (isAbsolute(path) ? path : join(projectRoot, path));

/**
 * `--min-score` must be a real percentage. Parsed from the raw flag rather than a
 * pre-coerced number because `Number(null)` and `Number("")` are both `0`, and a
 * threshold of 0 can never fail — so `--min-score` with its value omitted, or
 * `--min-score "$UNSET_VAR"` in CI, would silently disable the gate.
 */
const parseMinScore = (raw: number | string | null | undefined): { error: string } | { value: number | undefined } => {
    if (raw === undefined) {
        return { value: undefined };
    }

    if (raw === null || raw === "") {
        return { error: "--min-score needs a value between 0 and 100" };
    }

    const value = Number(raw);

    return Number.isFinite(value) && value >= 0 && value <= 100 ? { value } : { error: "--min-score must be a number between 0 and 100" };
};

/**
 * Read the committed baseline and diff against it.
 *
 * Every failure path returns an error rather than a "no regression" verdict: a
 * missing, hand-edited, or older-version baseline means the gate cannot verify
 * anything, and treating that as clean would silently disable it forever.
 */
const diffAgainstBaseline = (map: AdvisorMap, projectRoot: string, baselineOption: null | string): { comparison: BaselineComparison } | { error: string } => {
    // cerebro hands a valueless `--baseline` through as `null`, not `""`; both mean
    // "use the committed default", and neither may reach `isAbsolute`, which throws
    // on a non-string.
    const path = resolveIn(projectRoot, baselineOption === null || baselineOption === "" ? DEFAULT_MAP_PATH : baselineOption);

    if (!existsSync(path)) {
        return { error: `baseline not found at ${path} — generate one with \`lunora advisor\` and commit it` };
    }

    const baseline = parseAdvisorMap(JSON.parse(readFileSync(path, "utf8")));

    if (baseline === undefined) {
        return { error: `baseline at ${path} is malformed — regenerate it with \`lunora advisor\`` };
    }

    return { comparison: compareToBaseline(map, baseline) };
};

/** A version mismatch is "cannot verify", so it must fail the gate like any regression. */
const describeIncomparable = (reason: string): string => `baseline is not comparable (${reason}) — regenerate it; this run verified nothing`;

/** Pick the view the flags asked for. */
const render = (map: AdvisorMap, options: AdvisorCommandOptions, comparison: BaselineComparison | undefined): string => {
    if (options.entry !== undefined) {
        return formatEntry(map, options.entry);
    }

    return options.all === true ? formatMatrix(map) : formatSummary(map, comparison);
};

/**
 * Score the project's advisor findings into a health map, render it, optionally
 * write it, and apply the `--min-score` / `--baseline` gates.
 *
 * Runs codegen in `dryRun` mode purely to reach the advisor evidence: the map is
 * a read-only view, so the command never writes `_generated/`.
 */
const runAdvisorCommand = (options: AdvisorCommandOptions): AdvisorCommandResult => {
    const projectRoot = options.cwd ?? process.cwd();
    const json = isJsonFormat(options.format);
    const logger = loggerForFormat(options.format, options.logger);

    const formatError = validateOutputFormat("advisor", options.format);

    if (formatError !== undefined) {
        options.logger.error(formatError);

        return { error: formatError };
    }

    const minScore = parseMinScore(options.minScore);

    if ("error" in minScore) {
        options.logger.error(minScore.error);

        return { error: minScore.error };
    }

    const { advisorContext, advisories } = runCodegen({ dryRun: true, projectRoot });

    if (advisorContext === undefined) {
        const message = "advisor evidence unavailable — codegen ran with linting disabled";

        options.logger.error(message);

        return { error: message };
    }

    const map = scoreAdvisor(advisorContext.procedureProtections ?? [], advisories, { generatedAt: options.generatedAt ?? STABLE_STAMP });
    const result: AdvisorCommandResult = { map };

    // Diff BEFORE writing. `--baseline` and `--out` default to the same path, so
    // writing first would overwrite the committed baseline with the current map
    // and then compare it against itself — the gate could never fire, and the
    // artifact it was meant to protect would already be gone.
    if (options.baseline !== undefined) {
        const outcome = diffAgainstBaseline(map, projectRoot, options.baseline);

        if ("error" in outcome) {
            options.logger.error(outcome.error);

            return { ...result, error: outcome.error };
        }

        result.comparison = outcome.comparison;

        if (!outcome.comparison.comparable) {
            options.logger.error(describeIncomparable(outcome.comparison.reason));
        }
    }

    if (options.write !== false) {
        const target = resolveIn(projectRoot, options.out ?? DEFAULT_MAP_PATH);

        writeFileSync(target, `${JSON.stringify(map, undefined, 4)}\n`, "utf8");
        result.written = target;
    }

    result.belowMinScore = minScore.value !== undefined && map.score < minScore.value;

    if (result.belowMinScore) {
        logger.error(`advisor score ${String(map.score)} is below the required ${String(minScore.value)}`);
    }

    if (json) {
        printJson(result);

        return result;
    }

    logger.info(render(map, options, result.comparison));

    if (result.written !== undefined) {
        logger.success(`wrote ${result.written}`);
    }

    return result;
};

/** Whether the run should fail the process. */
const failed = (result: AdvisorCommandResult): boolean => {
    if (result.error !== undefined || result.belowMinScore === true) {
        return true;
    }

    // An incomparable baseline is "cannot verify", which must fail like a regression.
    return result.comparison !== undefined && (!result.comparison.comparable || result.comparison.regressed);
};

/** `lunora advisor` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<AdvisorOptions> = defineHandler<AdvisorOptions>(({ cwd, logger, options }) => {
    const result = runAdvisorCommand({
        all: options.all,
        baseline: options.baseline,
        cwd,
        entry: options.entry,
        format: options.format,
        logger,
        minScore: options.minScore,
        out: options.out,
        write: options.write,
    });

    return { code: failed(result) ? 1 : 0 };
});

export { execute, runAdvisorCommand };
export type { AdvisorCommandOptions, AdvisorCommandResult };
