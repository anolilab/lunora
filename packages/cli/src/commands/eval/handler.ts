import { existsSync } from "node:fs";
import { basename, join } from "node:path";

import type { EvalItemResult, EvalResult } from "@lunora/testing";
import type { Jiti } from "jiti";

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
 * The runtime TypeScript loader discovered eval files are executed through,
 * created at most once per process — see {@link evalLoader}.
 */
let loader: Promise<Jiti> | undefined;

/**
 * The runtime TypeScript loader for eval files, created lazily so no other
 * subcommand pays for it (`lunora eval`'s handler is itself lazy-loaded via
 * the command's `loader`, and this `import()` only runs once inside it).
 *
 * A bare `import()` cannot load a real eval file. Node's native
 * type-stripping strips types but changes no *resolution*, and every Lunora
 * project compiles under `moduleResolution: "bundler"` and therefore writes
 * extension-less relative imports (`./sql-readonly`, never `./sql-readonly.js`)
 * — which Node's ESM resolver rejects. So the first relative import inside a
 * discovered eval file, or anything it pulls in, dies with
 * `ERR_MODULE_NOT_FOUND`. The gap is resolution, not syntax, which is why a
 * transform-only tool (`esbuild`) cannot close it alone.
 *
 * `jiti` resolves and transforms, is pure JavaScript with no per-platform
 * native binary to make every consumer download (unlike `esbuild`/`tsx`), and
 * works across the whole supported Node range rather than only where native
 * type-stripping is unflagged.
 */
const evalLoader = async (): Promise<Jiti> => {
    // `interopDefault: false` is jiti's own default, pinned here because
    // `loadEvalModule` reads `.default` off the namespace: interop would
    // unwrap a default-only module and make that lookup `undefined`.
    loader ??= import("jiti").then(({ createJiti }) => createJiti(import.meta.url, { interopDefault: false }));

    return loader;
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
     * `--format`, or a `--threshold` gate applied to zero discovered evals.
     */
    error?: string;

    evals: EvalRunOutcome[];
}

/**
 * The JSON-output shape for one eval's outcome, matching the documented
 * `--format json` contract:
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
    const jiti = await evalLoader();
    const imported = await jiti.import<{ default?: unknown }>(filePath);
    const candidate = imported.default;

    if (!isEvalModule(candidate)) {
        throw new Error("does not default-export an eval module (expected `{ run(): Promise<EvalResult>, name?, threshold? }`)");
    }

    return candidate;
};

/**
 * Run one discovered eval file, applying its effective threshold (per-eval
 * export, else the global `--threshold`). A file that fails to load — a syntax
 * error, a missing import, a throw at module scope — is that eval's own
 * failure, reported in its row rather than aborting the rest of the run.
 */
const runOneEval = async (filePath: string, globalThreshold: number | undefined): Promise<EvalRunOutcome> => {
    let evalModule: EvalModule;

    try {
        evalModule = await loadEvalModule(filePath);
    } catch (error: unknown) {
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

/** Run every discovered eval file sequentially, applying `threshold`. */
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
 * Entirely in-process: no live Worker is ever contacted.
 *
 * One extra abort path guards against silently-wrong CI signal: a
 * `--threshold` applied to zero discovered evals (missing/renamed `--dir`, no
 * `*.eval.ts` match) exits non-zero — a gate that ran against nothing must not
 * report success.
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

    const outcomes = await runAllEvals(files, options.threshold);

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
