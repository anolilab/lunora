import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
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
    /** Files under lunora/_generated, when present. */
    generatedFiles: ReadonlyArray<AnalyzeFileEntry>;
    outdir: string;
    /** All files in the build output, sorted largest-first. */
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

const buildReport = (outdir: string): AnalyzeReport => {
    const all = walk(outdir);
    const sorted = all.toSorted((a, b) => b.sizeBytes - a.sizeBytes);
    const totalBytes = all.reduce((sum, entry) => sum + entry.sizeBytes, 0);
    const generatedFiles = all.filter((entry) => entry.path.includes("_generated"));

    return {
        generatedFiles,
        outdir,
        topModules: sorted.slice(0, 10),
        totalBytes,
        totalFiles: all.length,
    };
};

const renderText = (report: AnalyzeReport, logger: Logger): void => {
    logger.info(`outdir: ${report.outdir}`);
    logger.info(`total:  ${String(report.totalFiles)} files, ${formatBytes(report.totalBytes)}`);

    if (report.topModules.length > 0) {
        logger.info("");
        logger.info("top modules by size:");

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

        const exec = execArgsFor(detectPackageManager(cwd), "wrangler", ["deploy", "--dry-run", "--outdir", outdir]);

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
