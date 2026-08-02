import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { EvalItemResult, EvalResult } from "@lunora/testing";

import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { Logger } from "../../util/logger";
import { isJsonFormat, loggerForFormat, printJson, validateOutputFormat } from "../../util/output-format";
import { discoverEvalFiles, EVAL_FILE_SUFFIX } from "./discover-eval-files";
import type { EvalOptions } from "./index";
import type { EvalModule } from "./types";
import { isEvalModule, isValidThreshold } from "./types";

/** Default directory `lunora eval` discovers `*.eval.ts` files under, relative to `cwd`. */
const DEFAULT_EVAL_DIR = "evals";

/**
 * The actionable message printed when the Node floor can't execute a
 * discovered `.ts` eval file — see {@link isUnsupportedTsExtensionError}.
 */
const NODE_FLOOR_MESSAGE =
    '"lunora eval" needs native TypeScript execution — run Node ≥23.6, or a TS loader/transform (tracked in plans/245-eval-runner-design.md §8.3)';

/** Matches Node's `ERR_UNKNOWN_FILE_EXTENSION` message shape when `.code` isn't set (see {@link isUnsupportedTsExtensionError}). */
const TS_EXTENSION_ERROR_PATTERN = /unknown file extension ".ts"/i;

/**
 * True when `error` is Node's `ERR_UNKNOWN_FILE_EXTENSION` (or its message
 * shape) thrown by a bare `import()` of a `.ts` file — i.e. there is no
 * runtime TS loader available. This repo's `engines` floor is `^22.15.0`;
 * native `.ts` `import()` is only unflagged from Node ≥23.6, so on the
 * floor EVERY discovered `*.eval.ts` fails identically. That makes it a
 * systemic, top-level failure — not a per-eval one — so callers should abort
 * the whole run on the first occurrence rather than mislabel N evals as
 * "failed".
 */
const isUnsupportedTsExtensionError = (error: unknown): boolean => {
    if (!(error instanceof Error)) {
        return false;
    }

    if ((error as NodeJS.ErrnoException).code === "ERR_UNKNOWN_FILE_EXTENSION") {
        return true;
    }

    return TS_EXTENSION_ERROR_PATTERN.test(error.message);
};

/** Strip the directory and `.eval.ts` suffix off a discovered file's path for its default display name. */
const nameFromPath = (filePath: string): string => basename(filePath, EVAL_FILE_SUFFIX);

interface EvalCommandOptions {
    cwd?: string;

    /** Directory to discover `*.eval.ts` files under (default `evals/`). */
    dir?: string;

    /** Output format: `pretty` (default) or `json`. */
    format?: string;

    logger: Logger;

    /**
     * Global score gate every eval's average must meet, `[0, 1]`; a per-eval
     * `threshold` export overrides it for that eval only. Omitted → report-only
     * (a clean run always exits 0, regardless of score).
     */
    threshold?: number;
}

/** One discovered eval's outcome — either it produced a result, or it crashed loading/running. */
interface EvalRunOutcome {
    error?: string;
    name: string;
    passed: boolean;
    path: string;
    result?: EvalResult;
    threshold?: number;
}

interface EvalCommandResult {
    code: number;

    /**
     * Set when the run aborted before completing normally: an invalid
     * `--format`, the Node-floor `.ts`-execution gap, or a `--threshold`
     * gate applied to zero discovered evals.
     */
    error?: string;

    evals: EvalRunOutcome[];
}

/**
 * The JSON-output shape for one eval's outcome, matching the documented
 * `--format json` contract (`plans/245-eval-runner-design.md` §4/§6):
 * `{ name, path, average?, threshold?, passed, error?, items? }` — flat, so
 * `jq '.evals[].average'` (or any other single-hop field lookup) works
 * directly against the printed document, unlike the nested `result.average`/
 * `result.items` the in-process {@link EvalRunOutcome} carries for callers
 * that already hold a reference to the full `EvalResult`.
 */
interface EvalJsonOutcome {
    average?: number;
    error?: string;
    items?: EvalItemResult[];
    name: string;
    passed: boolean;
    path: string;
    threshold?: number;
}

/** Flatten one {@link EvalRunOutcome} into the documented `--format json` per-eval shape. */
const toJsonOutcome = (outcome: EvalRunOutcome): EvalJsonOutcome => {
    return {
        average: outcome.result?.average,
        error: outcome.error,
        items: outcome.result?.items,
        name: outcome.name,
        passed: outcome.passed,
        path: outcome.path,
        threshold: outcome.threshold,
    };
};

/** Flatten a whole {@link EvalCommandResult} for `--format json` printing (see {@link toJsonOutcome}). */
const toJsonResult = (result: EvalCommandResult): { code: number; error?: string; evals: EvalJsonOutcome[] } => {
    return {
        code: result.code,
        error: result.error,
        evals: result.evals.map((outcome) => toJsonOutcome(outcome)),
    };
};

/** Log `message` as the run's single top-level error, build the aborted {@link EvalCommandResult}, and print it as JSON when requested. */
const abortWithTopLevelError = (logger: Logger, format: string | undefined, message: string): EvalCommandResult => {
    logger.error(message);

    const result: EvalCommandResult = { code: 1, error: message, evals: [] };

    if (isJsonFormat(format)) {
        printJson(toJsonResult(result));
    }

    return result;
};

/**
 * Discover `*.eval.ts` files under `directory`, logging the same "nothing to
 * run"/"no files found" info lines for a missing or empty directory that
 * `runEvalCommand` has always reported — an absent `evals/` is a no-op, not
 * an error (see `discoverEvalFiles`'s own doc comment).
 */
const discoverFilesLogged = (directory: string, directoryOption: string, logger: Logger): string[] => {
    if (!existsSync(directory)) {
        logger.info(`eval: no "${directoryOption}" directory — nothing to run`);

        return [];
    }

    const files = discoverEvalFiles(directory);

    if (files.length === 0) {
        logger.info(`eval: no ${EVAL_FILE_SUFFIX} files found under "${directoryOption}"`);
    }

    return files;
};

/** Load one discovered file's default export and validate it satisfies {@link EvalModule}. */
const loadEvalModule = async (filePath: string): Promise<EvalModule> => {
    // A genuinely dynamic import of an arbitrary, runtime-discovered eval file
    // — never a static-analysis (glob) candidate. Excluded from packem's
    // dynamic-import-vars rollup plugin (`packem.config.ts`'s `rollup.dynamicVars.exclude`),
    // which otherwise tries to turn every non-literal `import()` into a glob
    // and hard-fails when it can't.
    const imported: unknown = await import(pathToFileURL(filePath).href);
    const candidate = (imported as { default?: unknown }).default;

    if (!isEvalModule(candidate)) {
        throw new Error("does not default-export an eval module (expected `{ run(): Promise<EvalResult>, name?, threshold? }`)");
    }

    return candidate;
};

/**
 * Run one discovered eval file, applying its effective threshold (per-eval
 * export, else the global `--threshold`). A load failure shaped like
 * {@link isUnsupportedTsExtensionError} is NOT converted into a per-eval
 * failure — it is rethrown so the caller can abort the whole run with one
 * top-level, actionable message instead of mislabeling every eval as
 * "failed" (see {@link NODE_FLOOR_MESSAGE}).
 */
const runOneEval = async (filePath: string, globalThreshold: number | undefined): Promise<EvalRunOutcome> => {
    let evalModule: EvalModule;

    try {
        evalModule = await loadEvalModule(filePath);
    } catch (error: unknown) {
        if (isUnsupportedTsExtensionError(error)) {
            throw error;
        }

        const message = error instanceof Error ? error.message : String(error);

        return { error: message, name: nameFromPath(filePath), passed: false, path: filePath };
    }

    const name = evalModule.name ?? nameFromPath(filePath);

    // `evalModule` is typed `EvalModule` (`threshold?: number`), but it comes
    // from a dynamic `import()` of an arbitrary file — the type is a
    // compile-time promise the file can't actually keep, so a runtime check
    // is the point here, not redundant with the type.
    if (evalModule.threshold !== undefined && !isValidThreshold(evalModule.threshold)) {
        return {
            error: `invalid \`threshold\` export: must be a number in [0, 1] — received ${JSON.stringify(evalModule.threshold)}`,
            name,
            passed: false,
            path: filePath,
        };
    }

    const effectiveThreshold = evalModule.threshold ?? globalThreshold;

    try {
        const result = await evalModule.run();
        const passed = effectiveThreshold === undefined || result.average >= effectiveThreshold;

        return { name, passed, path: filePath, result, threshold: effectiveThreshold };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        return { error: message, name, passed: false, path: filePath, threshold: effectiveThreshold };
    }
};

/**
 * Run every discovered eval file sequentially, applying `threshold`. A load
 * failure shaped like {@link isUnsupportedTsExtensionError} propagates
 * unchanged (see {@link runOneEval}) so the caller can abort the whole run
 * with one top-level message.
 */
const runAllEvals = async (files: string[], threshold: number | undefined): Promise<EvalRunOutcome[]> => {
    const outcomes: EvalRunOutcome[] = [];

    for (const file of files) {
        // Sequential, not `Promise.all`: two eval files sharing a stateful stub
        // (a scripted judge, a rate-limited real model behind `ctx.ai`) would
        // interleave under concurrency. Concurrency WITHIN one eval's own
        // dataset is still `evaluate`'s own job — untouched by this loop.
        // eslint-disable-next-line no-await-in-loop -- sequential by design, see above
        outcomes.push(await runOneEval(file, threshold));
    }

    return outcomes;
};

/** Render one outcome's `STATUS` cell: its error, or a pass/fail plus case count. */
const renderStatus = (outcome: EvalRunOutcome): string => {
    if (outcome.error !== undefined) {
        return `ERROR: ${outcome.error}`;
    }

    const verdict = outcome.passed ? "pass" : "FAIL";
    const caseCount = outcome.result?.items.length ?? 0;

    return `${verdict} (${String(caseCount)} cases)`;
};

/** Render the `NAME  SCORE  THRESHOLD  STATUS` aggregate table `lunora eval` prints in `pretty` mode. */
const renderEvalTable = (outcomes: EvalRunOutcome[]): string[] => {
    if (outcomes.length === 0) {
        return [];
    }

    const nameWidth = Math.max(4, ...outcomes.map((outcome) => outcome.name.length));
    const lines = [`${"NAME".padEnd(nameWidth)}  SCORE   THRESHOLD  STATUS`];

    for (const outcome of outcomes) {
        const score = outcome.result === undefined ? "—" : outcome.result.average.toFixed(3);
        const threshold = outcome.threshold === undefined ? "—" : outcome.threshold.toFixed(3);

        lines.push(`${outcome.name.padEnd(nameWidth)}  ${score.padEnd(6)}  ${threshold.padEnd(9)}  ${renderStatus(outcome)}`);
    }

    return lines;
};

/**
 * Discover every `*.eval.ts` file under `--dir` (default `evals/`), run each
 * via its default-exported `run()` — which calls `evaluate`/`agentHarness`
 * from `@lunora/testing` exactly as a hand-written Vitest suite would, this
 * command adds no scoring logic of its own — print the aggregate table, and
 * exit non-zero when any eval crashed or fell below its effective threshold.
 * Entirely in-process: no live Worker is ever contacted (see
 * `plans/245-eval-runner-design.md` §5).
 *
 * Two additional abort paths guard against silently-wrong CI signal:
 * - The Node-floor `.ts`-execution gap ({@link isUnsupportedTsExtensionError})
 * aborts the whole run with one top-level message instead of N mislabeled
 * per-eval failures.
 * - A `--threshold` applied to zero discovered evals (missing/renamed
 * `--dir`, no `*.eval.ts` match) exits non-zero — a gate that ran against
 * nothing must not report success.
 */
const runEvalCommand = async (options: EvalCommandOptions): Promise<EvalCommandResult> => {
    const cwd = options.cwd ?? process.cwd();
    const logger = loggerForFormat(options.format, options.logger);

    const formatError = validateOutputFormat("eval", options.format);

    if (formatError !== undefined) {
        options.logger.error(formatError);

        return { code: 1, error: formatError, evals: [] };
    }

    // Cerebro parses `--threshold` with `type: Number`, so a non-numeric value
    // (`--threshold abc`) silently becomes NaN instead of erroring at the CLI
    // layer. Reject it — and anything outside the documented [0, 1] range —
    // here, before it can gate the run: an unchecked NaN makes every eval's
    // `average >= NaN` comparison false, reporting every eval as FAIL with no
    // stated cause.
    if (options.threshold !== undefined && !isValidThreshold(options.threshold)) {
        return abortWithTopLevelError(logger, options.format, `eval: --threshold must be a number in [0, 1] — received "${String(options.threshold)}"`);
    }

    const directoryOption = options.dir ?? DEFAULT_EVAL_DIR;
    const directory = join(cwd, directoryOption);
    const files = discoverFilesLogged(directory, directoryOption, logger);

    let outcomes: EvalRunOutcome[];

    try {
        outcomes = await runAllEvals(files, options.threshold);
    } catch (error: unknown) {
        if (!isUnsupportedTsExtensionError(error)) {
            throw error;
        }

        return abortWithTopLevelError(logger, options.format, NODE_FLOOR_MESSAGE);
    }

    if (options.threshold !== undefined && outcomes.length === 0) {
        const message = `eval: --threshold ${String(options.threshold)} was set but 0 eval files were discovered under "${directoryOption}" — nothing was gated`;

        return abortWithTopLevelError(logger, options.format, message);
    }

    for (const line of renderEvalTable(outcomes)) {
        logger.info(line);
    }

    const failed = outcomes.filter((outcome) => !outcome.passed);
    const code = failed.length > 0 ? 1 : 0;

    if (code === 0) {
        logger.success(`eval: ${String(outcomes.length)} eval(s) passed`);
    } else {
        logger.error(`eval: ${String(failed.length)}/${String(outcomes.length)} eval(s) failed`);
    }

    const result = { code, evals: outcomes };

    if (isJsonFormat(options.format)) {
        printJson(toJsonResult(result));
    }

    return result;
};

/** `lunora eval` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<EvalOptions> = defineHandler<EvalOptions>(async ({ cwd, logger, options }) => {
    const result = await runEvalCommand({
        cwd,
        dir: options.dir,
        format: options.format,
        logger,
        threshold: options.threshold,
    });

    return { code: result.code };
});

export { execute, runEvalCommand };
export type { EvalCommandOptions, EvalCommandResult, EvalRunOutcome };
