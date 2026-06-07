/**
 * `cirrus backup create | list | restore` — managed snapshot backups on top of
 * the export/import admin endpoints.
 *
 * `create` exports every table to a timestamped NDJSON file under a backup
 * directory and records it in a `manifest.json`; `list` prints the manifest;
 * `restore &lt;id|file>` imports a chosen snapshot back through the import
 * endpoint. Schedule `create` (CI cron, or a cron-triggered action) for
 * automated backups. For in-place time-travel to an arbitrary moment in the
 * last 30 days, use native PITR (`cirrus backup pitr` / the dashboard) instead
 * of replaying a snapshot; this command is the off-platform / portable tier.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Logger } from "../util/logger.js";
import type { StreamingFetchLike } from "./data-transfer.js";
import { runExportCommand, runImportCommand } from "./data-transfer.js";

/** Default directory (relative to cwd) backups and their manifest live in. */
const DEFAULT_BACKUP_DIR = ".cirrus-backups";
const MANIFEST_FILE = "manifest.json";

type BackupSubcommand = "create" | "list" | "restore";

/** One recorded snapshot. `id` is the ISO timestamp; `file` is relative to the backup dir. */
interface BackupManifestEntry {
    bytes: number;
    createdAt: string;
    file: string;
    id: string;
    rows: number;
    tables?: string;
}

interface BackupCommandOptions {
    cwd?: string;
    /** Backup directory (relative to cwd). Defaults to `.cirrus-backups`. */
    dir?: string;
    fetchImpl?: StreamingFetchLike;
    logger: Logger;
    /** Injectable clock for deterministic backup ids in tests. */
    now?: () => Date;
    prod?: boolean;
    subcommand: BackupSubcommand;
    /** Comma-separated table allowlist for `create`; omit to back up everything. */
    tables?: string;
    /** `restore` target: a backup id (from the manifest) or a direct NDJSON path. */
    target?: string;
    token?: string;
    url?: string;
}

interface BackupCommandResult {
    code: number;
    /** Set on `create` — the written backup's manifest entry. */
    entry?: BackupManifestEntry;
}

const isManifestEntry = (value: unknown): value is BackupManifestEntry =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as BackupManifestEntry).id === "string" &&
    typeof (value as BackupManifestEntry).file === "string";

const readManifest = async (directory: string): Promise<BackupManifestEntry[]> => {
    const path = join(directory, MANIFEST_FILE);

    if (!existsSync(path)) {
        return [];
    }

    try {
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"));

        return Array.isArray(parsed) ? parsed.filter(isManifestEntry) : [];
    } catch {
        return [];
    }
};

const writeManifest = async (directory: string, entries: ReadonlyArray<BackupManifestEntry>): Promise<void> => {
    await writeFile(join(directory, MANIFEST_FILE), `${JSON.stringify(entries, undefined, 2)}\n`, "utf8");
};

const runBackupCreate = async (options: BackupCommandOptions, directory: string): Promise<BackupCommandResult> => {
    await mkdir(directory, { recursive: true });

    const timestamp = (options.now ?? (() => new Date()))().toISOString();
    // Colons/periods are awkward in filenames across platforms; keep the raw id.
    const file = `cirrus-backup-${timestamp.replaceAll(/[.:]/gu, "-")}.ndjson`;

    const result = await runExportCommand({
        cwd: options.cwd,
        fetchImpl: options.fetchImpl,
        logger: options.logger,
        out: join(directory, file),
        prod: options.prod,
        tables: options.tables,
        token: options.token,
        url: options.url,
    });

    if (result.code !== 0) {
        return { code: result.code };
    }

    const entry: BackupManifestEntry = { bytes: result.bytes, createdAt: timestamp, file, id: timestamp, rows: result.rows, tables: options.tables };
    const manifest = await readManifest(directory);

    manifest.push(entry);
    await writeManifest(directory, manifest);

    options.logger.success(`backup created: ${file} (${result.rows.toString()} rows, ${result.bytes.toString()} bytes)`);

    return { code: 0, entry };
};

const runBackupList = async (options: BackupCommandOptions, directory: string): Promise<BackupCommandResult> => {
    const manifest = await readManifest(directory);

    if (manifest.length === 0) {
        options.logger.info(`no backups found in ${directory}`);

        return { code: 0 };
    }

    for (const entry of manifest) {
        options.logger.info(`${entry.id}  ${entry.rows.toString()} rows  ${entry.bytes.toString()} bytes  ${entry.file}`);
    }

    return { code: 0 };
};

const runBackupRestore = async (options: BackupCommandOptions, directory: string): Promise<BackupCommandResult> => {
    const { target } = options;

    if (target === undefined || target.length === 0) {
        options.logger.error("restore requires a backup id or file path. Usage: cirrus backup restore <id|file>");

        return { code: 1 };
    }

    // Resolve the target: a manifest id maps to its recorded file; otherwise
    // treat it as a direct path (absolute, or relative to cwd).
    const manifest = await readManifest(directory);
    const matched = manifest.find((entry) => entry.id === target);
    const file = matched ? join(directory, matched.file) : target;

    if (!existsSync(file)) {
        options.logger.error(`backup not found: ${target}`);

        return { code: 1 };
    }

    const result = await runImportCommand({
        cwd: options.cwd,
        fetchImpl: options.fetchImpl,
        file,
        logger: options.logger,
        prod: options.prod,
        token: options.token,
        url: options.url,
    });

    // Plain snapshot import — the off-platform / portable restore. For in-place
    // time-travel to an arbitrary moment in the last 30 days, use native PITR
    // (`cirrus backup pitr` / the dashboard) rather than replaying a snapshot.
    return { code: result.code };
};

const runBackupCommand = async (options: BackupCommandOptions): Promise<BackupCommandResult> => {
    const cwd = options.cwd ?? process.cwd();
    const directory = join(cwd, options.dir ?? DEFAULT_BACKUP_DIR);

    if (options.subcommand === "create") {
        return runBackupCreate(options, directory);
    }

    if (options.subcommand === "list") {
        return runBackupList(options, directory);
    }

    return runBackupRestore(options, directory);
};

export type { BackupCommandOptions, BackupCommandResult, BackupManifestEntry, BackupSubcommand };
export { runBackupCommand };
