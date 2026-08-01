import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { EvalResult } from "@lunora/testing";

import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { Logger } from "../../util/logger";
import { isJsonFormat, loggerForFormat, printJson, validateOutputFormat } from "../../util/output-format";
import { discoverEvalFiles, EVAL_FILE_SUFFIX } from "./discover-eval-files";
import type { EvalOptions } from "./index";
import type { EvalModule } from "./types";
import { isEvalModule } from "./types";

/** Default directory `lunora eval` discovers `*.eval.ts` files under, relative to `cwd`. */
const DEFAULT_EVAL_DIR = "evals";

/** Strip the directory and `.eval.ts` suffix off a discovered file's path for its default display name. */
const nameFromPath = (filePath: string): string => {
    const base = filePath.split("/").pop() ?? filePath;

    return base.slice(0, -EVAL_FILE_SUFFIX.length);
};

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

    /** Set when the run aborted before any eval ran: an invalid `--format`. */
    error?: string;

    evals: EvalRunOutcome[];
}

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

/** Run one discovered eval file, applying its effective threshold (per-eval export, else the global `--threshold`). */
const runOneEval = async (filePath: string, globalThreshold: number | undefined): Promise<EvalRunOutcome> => {
    let evalModule: EvalModule;

    try {
        evalModule = await loadEvalModule(filePath);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        return { error: message, name: nameFromPath(filePath), passed: false, path: filePath };
    }

    const name = evalModule.name ?? nameFromPath(filePath);
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
 */
const runEvalCommand = async (options: EvalCommandOptions): Promise<EvalCommandResult> => {
    const cwd = options.cwd ?? process.cwd();
    const logger = loggerForFormat(options.format, options.logger);

    const formatError = validateOutputFormat("eval", options.format);

    if (formatError !== undefined) {
        options.logger.error(formatError);

        return { code: 1, error: formatError, evals: [] };
    }

    const directoryOption = options.dir ?? DEFAULT_EVAL_DIR;
    const directory = join(cwd, directoryOption);

    if (!existsSync(directory)) {
        logger.info(`eval: no "${directoryOption}" directory — nothing to run`);

        const emptyResult = { code: 0, evals: [] };

        if (isJsonFormat(options.format)) {
            printJson(emptyResult);
        }

        return emptyResult;
    }

    const files = discoverEvalFiles(directory);

    if (files.length === 0) {
        logger.info(`eval: no ${EVAL_FILE_SUFFIX} files found under "${directoryOption}"`);
    }

    const outcomes: EvalRunOutcome[] = [];

    for (const file of files) {
        // Sequential, not `Promise.all`: two eval files sharing a stateful stub
        // (a scripted judge, a rate-limited real model behind `ctx.ai`) would
        // interleave under concurrency. Concurrency WITHIN one eval's own
        // dataset is still `evaluate`'s own job — untouched by this loop.
        // eslint-disable-next-line no-await-in-loop -- sequential by design, see above
        outcomes.push(await runOneEval(file, options.threshold));
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
        printJson(result);
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
