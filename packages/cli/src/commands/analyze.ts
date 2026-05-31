import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import type { Logger } from "../util/logger.js";
import type { SpawnDescriptor, Spawner } from "../util/spawn.js";
import { defaultSpawner } from "../util/spawn.js";

export interface AnalyzeCommandOptions {
    cwd?: string;
    /** Skip the wrangler dry-run (tests inject a pre-built outdir). */
    inspectOnly?: string;
    json?: boolean;
    logger: Logger;
    spawner?: Spawner;
}

export interface AnalyzeFileEntry {
    /** Path relative to the outdir. */
    path: string;
    sizeBytes: number;
}

export interface AnalyzeReport {
    /** Files under cirrus/_generated, when present. */
    generatedFiles: ReadonlyArray<AnalyzeFileEntry>;
    outdir: string;
    /** All files in the build output, sorted largest-first. */
    topModules: ReadonlyArray<AnalyzeFileEntry>;
    totalBytes: number;
    totalFiles: number;
}

export interface AnalyzeCommandResult {
    code: number;
    descriptor: SpawnDescriptor | undefined;
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
        return `${bytes} B`;
    }

    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KiB`;
    }

    return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
};

const buildReport = (outdir: string): AnalyzeReport => {
    const all = walk(outdir);
    const sorted = [...all].sort((a, b) => b.sizeBytes - a.sizeBytes);
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
    logger.info(`total:  ${report.totalFiles} files, ${formatBytes(report.totalBytes)}`);

    if (report.topModules.length > 0) {
        logger.info("");
        logger.info("top modules by size:");

        for (const entry of report.topModules) {
            logger.info(`  ${formatBytes(entry.sizeBytes).padStart(10, " ")}  ${entry.path}`);
        }
    }

    if (report.generatedFiles.length > 0) {
        logger.info("");
        logger.info(`_generated/ files: ${report.generatedFiles.length}`);

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
export const runAnalyzeCommand = async (options: AnalyzeCommandOptions): Promise<AnalyzeCommandResult> => {
    const cwd = options.cwd ?? process.cwd();
    const { logger } = options;

    let outdir: string;
    let descriptor: SpawnDescriptor | undefined;
    let temporary = false;

    if (options.inspectOnly) {
        outdir = options.inspectOnly;
    } else {
        outdir = mkdtempSync(join(tmpdir(), "cirrus-analyze-"));
        temporary = true;
        descriptor = {
            args: ["exec", "wrangler", "deploy", "--dry-run", "--outdir", outdir],
            command: "pnpm",
            cwd,
        };

        logger.info(`analyze: building via ${descriptor.command} ${descriptor.args.join(" ")}`);

        const spawner = options.spawner ?? defaultSpawner;
        const spawned = await spawner(descriptor);

        if (spawned.code !== 0) {
            logger.error(`analyze: wrangler dry-run failed (exit ${spawned.code})`);

            if (temporary) {
                rmSync(outdir, { force: true, recursive: true });
            }

            return { code: spawned.code, descriptor, report: undefined };
        }
    }

    try {
        if (!existsSync(outdir)) {
            logger.error(`analyze: outdir not found at ${outdir}`);

            return { code: 1, descriptor, report: undefined };
        }

        const report = buildReport(outdir);

        if (options.json) {
            // Print the raw JSON via the logger so tests + CI capture it the
            // same way as the other commands.
            logger.info(JSON.stringify(report, undefined, 2));
        } else {
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
