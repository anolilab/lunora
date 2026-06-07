/**
 * `cirrus backup create | list | restore | pitr` — managed snapshot backups on
 * top of the export/import admin endpoints, plus native point-in-time recovery.
 *
 * `create` exports every table to a timestamped NDJSON file under a backup
 * directory and records it in a `manifest.json`; `list` prints the manifest;
 * `restore &lt;id|file>` imports a chosen snapshot back through the import
 * endpoint. Schedule `create` (CI cron, or a cron-triggered action) for
 * automated backups — this is the off-platform / portable / >30-day tier.
 *
 * `pitr` is the complementary in-place tier: it drives the platform's own
 * Durable-Object change log to restore a shard to any moment in the last 30
 * days (`getPitrBookmark` / `pitrRestore` via the admin-gated PITR endpoint),
 * no R2 read and no snapshot replay.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import resolveAdminBaseUrl from "../util/admin-url.js";
import type { Logger } from "../util/logger.js";
import type { StreamingFetchLike } from "./data-transfer.js";
import { runExportCommand, runImportCommand } from "./data-transfer.js";
import type { FetchLike } from "./run.js";

/** Default directory (relative to cwd) backups and their manifest live in. */
const DEFAULT_BACKUP_DIR = ".cirrus-backups";
const MANIFEST_FILE = "manifest.json";

/** Worker endpoint that forwards a per-shard native-PITR admin op (see `@cirrus/runtime`). */
const PITR_ENDPOINT_PATH = "/_cirrus/admin/pitr";
const GET_PITR_BOOKMARK_OP = "__cirrus_admin__:getPitrBookmark";
const PITR_RESTORE_OP = "__cirrus_admin__:pitrRestore";

type BackupSubcommand = "create" | "list" | "pitr" | "restore";

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
    /** `pitr`: restore to the bookmark nearest this time (ISO or epoch-ms), within 30 days. */
    at?: string;
    /** `pitr restore`: an explicit bookmark to restore to (e.g. an undo bookmark). Wins over `--at`. */
    bookmark?: string;
    cwd?: string;
    /** Backup directory (relative to cwd). Defaults to `.cirrus-backups`. */
    dir?: string;
    fetchImpl?: StreamingFetchLike;
    logger: Logger;
    /** Injectable clock for deterministic backup ids in tests. */
    now?: () => Date;
    /** Injectable fetch for the `pitr` admin endpoint (plain JSON, not the streaming export fetch). */
    pitrFetch?: FetchLike;
    prod?: boolean;
    /** `pitr restore`: also restart the shard now (`ctx.abort()`) so recovery applies immediately. */
    restart?: boolean;
    /** `pitr`: perform a restore (`pitrRestore`) instead of just reading the current/for-a-time bookmark. */
    restore?: boolean;
    /** `pitr`: target shard key; omit for the default (root) shard. */
    shard?: string;
    subcommand: BackupSubcommand;
    /** Comma-separated table allowlist for `create`; omit to back up everything. */
    tables?: string;
    /** `restore` target: a backup id (from the manifest) or a direct NDJSON path. */
    target?: string;
    token?: string;
    url?: string;
    /** Required alongside `--prod` for `pitr restore` — confirms restoring production in place. */
    yes?: boolean;
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

/**
 * `cirrus backup pitr` — native Durable-Object point-in-time recovery (the
 * in-place ≤30-day tier). With no flags it reads the shard's current bookmark;
 * `--at &lt;time>` previews the bookmark nearest that moment. `--restore` arms a
 * restore (to `--bookmark`, or the one nearest `--at`) and returns an undo
 * bookmark; `--restart` applies it immediately. Hits the admin-gated
 * `/_cirrus/admin/pitr` endpoint, which forwards the op to one shard.
 */
interface PitrRequest {
    fetchImpl: FetchLike;
    requestUrl: string;
    token: string;
}

/** Validate the guards and resolve the token / URL / fetch for a `pitr` call. Logs and returns `undefined` on any failure. */
const resolvePitrRequest = (options: BackupCommandOptions): PitrRequest | undefined => {
    const token = options.token ?? process.env.CIRRUS_ADMIN_TOKEN;

    if (!token) {
        options.logger.error("admin token required — pass --token or set CIRRUS_ADMIN_TOKEN");

        return undefined;
    }

    if (options.prod && options.url === undefined) {
        options.logger.error("--prod requires an explicit --url (refusing to target the implicit localhost worker)");

        return undefined;
    }

    if (options.restore === true && options.at === undefined && options.bookmark === undefined) {
        options.logger.error("pitr --restore requires --at <time> or --bookmark <bookmark>");

        return undefined;
    }

    if (options.restore === true && options.prod === true && options.yes !== true) {
        options.logger.error("pitr --restore --prod restores production data in place. Re-run with --yes to confirm.");

        return undefined;
    }

    const baseUrl = resolveAdminBaseUrl(options.url, options.logger);

    if (baseUrl === undefined) {
        return undefined;
    }

    const fetchImpl: FetchLike = options.pitrFetch ?? (globalThis as unknown as { fetch: FetchLike }).fetch;

    if (typeof fetchImpl !== "function") {
        throw new TypeError("no fetch implementation available — pass pitrFetch or run on Node >= 18");
    }

    return { fetchImpl, requestUrl: `${baseUrl}${PITR_ENDPOINT_PATH}`, token };
};

/** Build the RPC args payload for a `pitr` call from the flags. */
const buildPitrArgs = (options: BackupCommandOptions, isRestore: boolean): Record<string, unknown> => {
    const args: Record<string, unknown> = {};

    if (options.at !== undefined) {
        args.time = options.at;
    }

    if (isRestore && options.bookmark !== undefined) {
        args.bookmark = options.bookmark;
    }

    if (isRestore && options.restart === true) {
        args.restart = true;
    }

    return args;
};

const runBackupPitr = async (options: BackupCommandOptions): Promise<BackupCommandResult> => {
    const request = resolvePitrRequest(options);

    if (request === undefined) {
        return { code: 1 };
    }

    const isRestore = options.restore === true;
    const functionPath = isRestore ? PITR_RESTORE_OP : GET_PITR_BOOKMARK_OP;
    const args = buildPitrArgs(options, isRestore);
    const action = isRestore ? "restore" : "bookmark";

    options.logger.info(`POST ${request.requestUrl} -> pitr ${action}${options.shard === undefined ? "" : ` (shard "${options.shard}")`}`);

    const response = await request.fetchImpl(request.requestUrl, {
        body: JSON.stringify({ args, functionPath, shardKey: options.shard }),
        headers: { authorization: `Bearer ${request.token}`, "content-type": "application/json" },
        method: "POST",
    });

    const text = await response.text();

    let body: unknown;

    try {
        body = JSON.parse(text);
    } catch {
        body = text;
    }

    options.logger.info(JSON.stringify(body, undefined, 2));

    return { code: response.ok ? 0 : 1 };
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

    if (options.subcommand === "pitr") {
        return runBackupPitr(options);
    }

    return runBackupRestore(options, directory);
};

export type { BackupCommandOptions, BackupCommandResult, BackupManifestEntry, BackupSubcommand };
export { runBackupCommand };
