import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { detectPackageManager, execArgsFor } from "../../util/detect-package-manager";
import { EXIT_CODE } from "../../util/exit-code";
import type { Logger } from "../../util/logger";
import type { OutputFormat } from "../../util/output-format";
import type { SpawnDescriptor, Spawner } from "../../util/spawn";
import { defaultSpawner } from "../../util/spawn";
import type { AnalyzeOptions } from "./index";

interface AnalyzeCommandOptions {
    cwd?: string;
    /** Output format: `pretty` (default) or `json`. */
    format?: OutputFormat;
    /** Skip the wrangler dry-run (tests inject a pre-built outdir). */
    inspectOnly?: string;
    logger: Logger;
    spawner?: Spawner;
}

interface AnalyzeFileEntry {
    /** Path relative to the outdir. */
    path: string;
    sizeBytes: number;
}

interface AnalyzeReport {
    /**
     * `metafile`: `topModules` and `generatedFiles` are source modules, sized from
     * wrangler's esbuild metafile. `output-files`: the entry was pre-bundled, so
     * `topModules` is the largest build output files instead.
     */
    breakdown: "metafile" | "output-files";
    /** Source modules under a `_generated/` directory; empty without a metafile. */
    generatedFiles: ReadonlyArray<AnalyzeFileEntry>;
    outdir: string;
    /** Largest-first, at most ten; see `breakdown` for what each entry is. */
    topModules: ReadonlyArray<AnalyzeFileEntry>;
    totalBytes: number;
    totalFiles: number;
}

interface AnalyzeCommandResult {
    code: number;
    descriptor: SpawnDescriptor | undefined;
    /** Why the run failed, for the `--format json` envelope. */
    error?: string;
    report: AnalyzeReport | undefined;
}

const walk = (root: string): ReadonlyArray<AnalyzeFileEntry> => {
    const entries: AnalyzeFileEntry[] = [];

    const recurse = (directory: string): void => {
        for (const name of readdirSync(directory)) {
            const full = join(directory, name);
            const info = statSync(full);

            if (info.isDirectory()) {
                recurse(full);
            } else if (info.isFile()) {
                entries.push({ path: relative(root, full), sizeBytes: info.size });
            }
        }
    };

    recurse(root);

    return entries;
};

const formatBytes = (bytes: number): string => {
    if (bytes < 1024) {
        return `${String(bytes)} B`;
    }

    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KiB`;
    }

    return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
};

const METAFILE_NAME = "bundle-meta.json";
const TOP_COUNT = 10;
const GENERATED_SEGMENT = /(?:^|[\\/])_generated[\\/]/u;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** wrangler writes this beside the bundle in `--outdir` to explain the folder; it is not uploaded. */
const WRANGLER_README = "README.md";

/** Maps are a debugging aid and metafile and README are wrangler's own bookkeeping; none is bundle size. */
const isBundleOutput = (entry: AnalyzeFileEntry): boolean => !entry.path.endsWith(".map") && entry.path !== METAFILE_NAME && entry.path !== WRANGLER_README;

const largestFirst = (entries: ReadonlyArray<AnalyzeFileEntry>): AnalyzeFileEntry[] => entries.toSorted((a, b) => b.sizeBytes - a.sizeBytes);

/** Sums `bytesInOutput` per input path across every output in an esbuild metafile. */
const sumInputBytes = (outputs: Record<string, unknown>): Map<string, number> => {
    const sizes = new Map<string, number>();

    for (const output of Object.values(outputs)) {
        const inputs = isRecord(output) ? output["inputs"] : undefined;

        if (!isRecord(inputs)) {
            continue;
        }

        for (const [inputPath, input] of Object.entries(inputs)) {
            const bytes = isRecord(input) ? input["bytesInOutput"] : undefined;

            if (typeof bytes === "number") {
                sizes.set(inputPath, (sizes.get(inputPath) ?? 0) + bytes);
            }
        }
    }

    return sizes;
};

/** Per-input sizes from `<outdir>/bundle-meta.json`, or `undefined` when there is none to trust. */
const readInputSizes = (outdir: string): Map<string, number> | undefined => {
    const metafilePath = join(outdir, METAFILE_NAME);

    if (!existsSync(metafilePath)) {
        return undefined;
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(readFileSync(metafilePath, "utf8"));
    } catch {
        return undefined;
    }

    const outputs = isRecord(parsed) ? parsed["outputs"] : undefined;

    const sizes = isRecord(outputs) ? sumInputBytes(outputs) : undefined;

    // A metafile that sizes no module would print an empty breakdown and skip the fallback.
    return sizes !== undefined && sizes.size > 0 ? sizes : undefined;
};

const reportFromMetafile = (outdir: string, outputs: ReadonlyArray<AnalyzeFileEntry>, inputSizes: Map<string, number>): AnalyzeReport => {
    const modules = largestFirst(
        [...inputSizes].map(([path, sizeBytes]) => {
            return { path, sizeBytes };
        }),
    );

    return {
        breakdown: "metafile",
        generatedFiles: modules.filter((entry) => GENERATED_SEGMENT.test(entry.path)),
        outdir,
        topModules: modules.slice(0, TOP_COUNT),
        totalBytes: outputs.reduce((sum, entry) => sum + entry.sizeBytes, 0),
        totalFiles: outputs.length,
    };
};

const reportFromOutputFiles = (outdir: string, outputs: ReadonlyArray<AnalyzeFileEntry>): AnalyzeReport => {
    return {
        breakdown: "output-files",
        generatedFiles: [],
        outdir,
        topModules: largestFirst(outputs).slice(0, TOP_COUNT),
        totalBytes: outputs.reduce((sum, entry) => sum + entry.sizeBytes, 0),
        totalFiles: outputs.length,
    };
};

const buildReport = (outdir: string): AnalyzeReport => {
    const outputs = walk(outdir).filter((entry) => isBundleOutput(entry));
    const inputSizes = readInputSizes(outdir);

    return inputSizes ? reportFromMetafile(outdir, outputs, inputSizes) : reportFromOutputFiles(outdir, outputs);
};

const renderText = (report: AnalyzeReport, logger: Logger): void => {
    logger.info(`outdir: ${report.outdir}`);
    logger.info(`total:  ${String(report.totalFiles)} files, ${formatBytes(report.totalBytes)}`);

    if (report.topModules.length > 0) {
        logger.info("");
        logger.info(report.breakdown === "metafile" ? "top modules by bytes in bundle:" : "largest output files:");

        for (const entry of report.topModules) {
            logger.info(`  ${formatBytes(entry.sizeBytes).padStart(10, " ")}  ${entry.path}`);
        }
    }

    if (report.generatedFiles.length > 0) {
        logger.info("");
        logger.info(`_generated/ files: ${String(report.generatedFiles.length)}`);

        for (const entry of report.generatedFiles) {
            logger.info(`  ${formatBytes(entry.sizeBytes).padStart(10, " ")}  ${entry.path}`);
        }
    }
};

/**
 * Build the worker via `wrangler deploy --dry-run --outdir <tmp>` and report
 * total size, top modules, and the `_generated/` footprint.
 *
 * Tests inject `inspectOnly: <path>` to skip the wrangler invocation and
 * walk a pre-built directory directly.
 */
const runAnalyzeCommand = async (options: AnalyzeCommandOptions): Promise<AnalyzeCommandResult> => {
    const cwd = options.cwd ?? process.cwd();
    const json = options.format === "json";
    const { logger } = options;

    let outdir: string;
    let descriptor: SpawnDescriptor | undefined;
    let temporary = false;

    if (options.inspectOnly) {
        outdir = options.inspectOnly;
    } else {
        outdir = mkdtempSync(join(tmpdir(), "lunora-analyze-"));
        temporary = true;

        // Bare `--metafile` makes wrangler write `<outdir>/bundle-meta.json`, the only per-module size source.
        const exec = execArgsFor(detectPackageManager(cwd), "wrangler", ["deploy", "--dry-run", "--outdir", outdir, "--metafile"]);

        descriptor = {
            args: exec.args,
            command: exec.command,
            cwd,
            // wrangler prints its bundle report on stdout, which in json mode
            // belongs to the result document alone.
            stdoutToStderr: json,
        };

        logger.info(`analyze: building via ${descriptor.command} ${descriptor.args.join(" ")}`);

        const spawner = options.spawner ?? defaultSpawner;
        const spawned = await spawner(descriptor);

        if (spawned.code !== 0) {
            const message = `analyze: wrangler dry-run failed (exit ${String(spawned.code)})`;

            logger.error(message);

            // `temporary` is always true on this branch (we created the outdir above).
            rmSync(outdir, { force: true, recursive: true });

            return { code: spawned.code, descriptor, error: message, report: undefined };
        }
    }

    try {
        if (!existsSync(outdir)) {
            const message = `analyze: outdir not found at ${outdir}`;

            logger.error(message);

            return { code: EXIT_CODE.NOT_FOUND, descriptor, error: message, report: undefined };
        }

        const report = buildReport(outdir);

        if (report.breakdown === "output-files") {
            logger.warn("analyze: no readable esbuild metafile with module sizes (a pre-bundled entry writes none), so per-module sizes are unavailable");
        }

        if (!json) {
            renderText(report, logger);
        }

        return { code: 0, descriptor, report };
    } finally {
        if (temporary && existsSync(outdir)) {
            try {
                rmSync(outdir, { force: true, recursive: true });
            } catch {
                /* best-effort cleanup */
            }
        }
    }
};

/** `lunora analyze` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<AnalyzeOptions> = defineHandler<AnalyzeOptions, AnalyzeReport>(async ({ cwd, format, logger }) => {
    const result = await runAnalyzeCommand({ cwd, format, logger });

    return { code: result.code, data: result.report, error: result.error };
});

export { execute };
export type { AnalyzeCommandOptions, AnalyzeCommandResult, AnalyzeFileEntry, AnalyzeReport };
export { runAnalyzeCommand };
