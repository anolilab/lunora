import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type { AdvisorMap, BaselineComparison } from "@lunora/advisor";
import { compareToBaseline, parseAdvisorMap, scoreAdvisor, STATIC_LINTS } from "@lunora/advisor";
import { runCodegen } from "@lunora/codegen";

import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { Logger } from "../../util/logger";
import { isJsonFormat, loggerForFormat, printJson, validateOutputFormat } from "../../util/output-format";
import type { AdvisorOptions } from "./index";
import { DEFAULT_MAP_PATH } from "./index";
import { formatEntry, formatMatrix, formatSummary } from "./report";

interface AdvisorCommandOptions {
    /** Render every procedure as a check matrix, not just the ones with findings. */
    all?: boolean;
    /** Committed map to diff against; `""` means "use the default path". */
    baseline?: string;
    cwd?: string;
    /** Inspect a single `file#exportName`. */
    entry?: string;
    /** Output format: `pretty` (default) or `json`. */
    format?: string;
    logger: Logger;
    /** Fail when the global score is below this. */
    minScore?: number;
    /** Suppress writing the artifact. */
    noWrite?: boolean;
    /** Where to write the artifact. */
    out?: string;
}

interface AdvisorCommandResult {
    /** Set when a baseline was requested and could be read. */
    comparison?: BaselineComparison;
    /** Set when the run aborted, or a gate could not be evaluated. */
    error?: string;
    /** The scored map; absent only when the run aborted before scoring. */
    map?: AdvisorMap;
    /** Where the artifact was written, when it was. */
    written?: string;
}

/** Resolve a possibly-relative path against the project root. */
const resolveIn = (projectRoot: string, path: string): string => (isAbsolute(path) ? path : join(projectRoot, path));

/** `--min-score` must be a real percentage; anything else is a typo that would silently disable the gate. */
const invalidMinScore = (minScore: number | undefined): boolean => minScore !== undefined && !(Number.isFinite(minScore) && minScore >= 0 && minScore <= 100);

/**
 * Read the committed baseline and diff against it.
 *
 * Every failure path returns an error rather than a "no regression" verdict: a
 * missing, hand-edited, or older-version baseline means the gate cannot verify
 * anything, and treating that as clean would silently disable it forever.
 */
const diffAgainstBaseline = (map: AdvisorMap, projectRoot: string, baselineOption: string): { comparison: BaselineComparison } | { error: string } => {
    const path = resolveIn(projectRoot, baselineOption === "" ? DEFAULT_MAP_PATH : baselineOption);

    if (!existsSync(path)) {
        return { error: `baseline not found at ${path} — generate one with \`lunora advisor\` and commit it` };
    }

    const baseline = parseAdvisorMap(JSON.parse(readFileSync(path, "utf8")));

    if (baseline === undefined) {
        return { error: `baseline at ${path} is unreadable or was written by an older version — regenerate it` };
    }

    return { comparison: compareToBaseline(map, baseline) };
};

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

    if (invalidMinScore(options.minScore)) {
        const message = "--min-score must be a number between 0 and 100";

        options.logger.error(message);

        return { error: message };
    }

    const { advisorContext, advisories } = runCodegen({ dryRun: true, projectRoot });

    if (advisorContext === undefined) {
        const message = "advisor evidence unavailable — codegen ran with linting disabled";

        options.logger.error(message);

        return { error: message };
    }

    // `STATIC_LINTS` is exactly the set codegen ran, so any `Lint.weight` is honoured.
    const map = scoreAdvisor(advisorContext, advisories, { lints: STATIC_LINTS });
    const result: AdvisorCommandResult = { map };

    if (options.noWrite !== true) {
        const target = resolveIn(projectRoot, options.out ?? DEFAULT_MAP_PATH);

        writeFileSync(target, `${JSON.stringify(map, undefined, 4)}\n`, "utf8");
        result.written = target;
    }

    if (options.baseline !== undefined) {
        const outcome = diffAgainstBaseline(map, projectRoot, options.baseline);

        if ("error" in outcome) {
            options.logger.error(outcome.error);

            return { ...result, error: outcome.error };
        }

        result.comparison = outcome.comparison;
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
const failed = (result: AdvisorCommandResult, minScore: number | undefined): boolean => {
    if (result.error !== undefined) {
        return true;
    }

    if (result.comparison !== undefined && (!result.comparison.comparable || result.comparison.regressed)) {
        return true;
    }

    return minScore !== undefined && result.map !== undefined && result.map.score < minScore;
};

/** `lunora advisor` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<AdvisorOptions> = defineHandler<AdvisorOptions>(({ cwd, logger, options }) => {
    const minScore = options.minScore === undefined ? undefined : Number(options.minScore);
    const result = runAdvisorCommand({
        all: options.all,
        baseline: options.baseline,
        cwd,
        entry: options.entry,
        format: options.format,
        logger,
        minScore,
        noWrite: options.noWrite,
        out: options.out,
    });

    return { code: failed(result, minScore) ? 1 : 0 };
});

export { execute, runAdvisorCommand };
export type { AdvisorCommandOptions, AdvisorCommandResult };
