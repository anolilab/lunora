/**
 * `cirrus backup create | list | restore` — managed snapshot backups on top of
 * the export/import admin endpoints.
 *
 * `create` exports every table to a timestamped NDJSON file under a backup
 * directory and records it in a `manifest.json`; `list` prints the manifest;
 * `restore &lt;id|file>` imports a chosen snapshot back through the import
 * endpoint. Schedule `create` (CI cron, or a cron-triggered action) for
 * automated backups; pair with Cloudflare D1 Time Travel for sub-snapshot
 * recovery, or `restore --to &lt;time>` once replay-PITR lands.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import resolveAdminBaseUrl from "../util/admin-url.js";
import type { Logger } from "../util/logger.js";
import type { StreamingFetchLike } from "./data-transfer.js";
import { runExportCommand, runImportCommand } from "./data-transfer.js";

/** Default directory (relative to cwd) backups and their manifest live in. */
const DEFAULT_BACKUP_DIR = ".cirrus-backups";
const MANIFEST_FILE = "manifest.json";
const SYNC_ENDPOINT_PATH = "/_cirrus/admin/sync";
const APPLY_ENDPOINT_PATH = "/_cirrus/admin/apply";
/** Safety bound on the replay drain loop — far above any realistic changelog depth. */
const MAX_REPLAY_PAGES = 10_000;

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

    /**
     * `restore` only: ISO timestamp for point-in-time recovery. After importing
     * the base snapshot, replay the CDC changelog up to this moment (`ts &lt;= T`).
     */
    to?: string;
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

/** One CDC change as it crosses the wire from `/sync` (we only read `ts` here). */
interface WireChange {
    [key: string]: unknown;
    ts?: number;
}

interface SyncPage {
    global?: { changes?: ReadonlyArray<WireChange>; cursor?: number };
    shards?: ReadonlyArray<{ changes?: ReadonlyArray<WireChange>; cursor?: number; error?: { message?: string }; shardKey?: string }>;
}

interface ReplayBatch {
    changes: ReadonlyArray<WireChange>;
    shardKey: string;
}

interface CollectedPage {
    advanced: boolean;
    batches: ReplayBatch[];
    /** Next per-shard cursor map (a fresh object — the input is not mutated). */
    cursors: Record<string, number>;
    globalChanges: ReadonlyArray<WireChange>;
    globalCursor: number;
    /** True if this page collected at least one in-window (ts at or before `toMs`) change. */
    inWindow: boolean;
    /** True if this page dropped at least one change for being past `toMs`. */
    pastWindow: boolean;
}

/**
 * Project one `/sync` page into the changes to replay (ts at or before `toMs`),
 * returning the advanced per-shard cursor map, the next global cursor, and
 * whether any cursor moved (the loop's drained signal). Pure — cursors copied.
 */
const collectReplayPage = (data: SyncPage, cursors: Readonly<Record<string, number>>, globalCursor: number, toMs: number): CollectedPage => {
    const batches: ReplayBatch[] = [];
    const nextCursors: Record<string, number> = { ...cursors };
    let advanced = false;
    let inWindow = false;
    let pastWindow = false;

    const partitionByWindow = (changes: ReadonlyArray<WireChange>): WireChange[] => {
        const fresh: WireChange[] = [];

        for (const entry of changes) {
            if ((entry.ts ?? 0) <= toMs) {
                fresh.push(entry);
            } else {
                pastWindow = true;
            }
        }

        return fresh;
    };

    for (const shard of data.shards ?? []) {
        if (shard.shardKey === undefined) {
            continue;
        }

        const fresh = partitionByWindow(shard.changes ?? []);

        if (fresh.length > 0) {
            batches.push({ changes: fresh, shardKey: shard.shardKey });
            inWindow = true;
        }

        if (typeof shard.cursor === "number" && shard.cursor > (nextCursors[shard.shardKey] ?? 0)) {
            nextCursors[shard.shardKey] = shard.cursor;
            advanced = true;
        }
    }

    const globalChanges = partitionByWindow(data.global?.changes ?? []);

    if (globalChanges.length > 0) {
        inWindow = true;
    }

    let nextGlobalCursor = globalCursor;

    if (typeof data.global?.cursor === "number" && data.global.cursor > globalCursor) {
        nextGlobalCursor = data.global.cursor;
        advanced = true;
    }

    return { advanced, batches, cursors: nextCursors, globalChanges, globalCursor: nextGlobalCursor, inWindow, pastWindow };
};

/** POST one replay page to `/apply` and return how many changes it applied. */
const postReplayPage = async (fetchImpl: StreamingFetchLike, baseUrl: string, headers: Record<string, string>, page: CollectedPage): Promise<number> => {
    if (page.batches.length === 0 && page.globalChanges.length === 0) {
        return 0;
    }

    const response = await fetchImpl(`${baseUrl}${APPLY_ENDPOINT_PATH}`, {
        body: JSON.stringify({ batches: page.batches, globalChanges: page.globalChanges }),
        headers,
        method: "POST",
    });

    if (!response.ok) {
        throw new Error(`apply failed (${String(response.status)}): ${await response.text()}`);
    }

    const result = (await response.json()) as { applied?: number; failed?: number };

    if ((result.failed ?? 0) > 0) {
        throw new Error(`apply reported ${String(result.failed)} failed shard(s) — aborting point-in-time restore to avoid a partial replay`);
    }

    return result.applied ?? 0;
};

const replayCdcTo = async (options: BackupCommandOptions, baseUrl: string, token: string, toMs: number): Promise<number> => {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    let cursors: Record<string, number> = {};
    let globalCursor = 0;
    let applied = 0;

    for (let page = 0; page < MAX_REPLAY_PAGES; page += 1) {
        // eslint-disable-next-line no-await-in-loop -- the feed is paged: each request resumes from the cursors the previous page returned.
        const syncResponse = await fetchImpl(`${baseUrl}${SYNC_ENDPOINT_PATH}`, { body: JSON.stringify({ cursors, globalCursor }), headers, method: "POST" });

        if (!syncResponse.ok) {
            // eslint-disable-next-line no-await-in-loop -- error path: read the body for the message before throwing.
            throw new Error(`sync failed (${String(syncResponse.status)}): ${await syncResponse.text()}`);
        }

        // eslint-disable-next-line no-await-in-loop -- sequential paging (see above).
        const data = (await syncResponse.json()) as SyncPage;
        // A per-shard error means that shard's history is missing from this page;
        // replaying anyway would silently skip it, so abort the restore instead.
        const failedShard = (data.shards ?? []).find((shard) => shard.error !== undefined);

        if (failedShard !== undefined) {
            throw new Error(
                `sync reported a failed shard "${failedShard.shardKey ?? "?"}": ${failedShard.error?.message ?? "unknown"} — aborting point-in-time restore to avoid a partial replay`,
            );
        }

        const collected = collectReplayPage(data, cursors, globalCursor, toMs);

        cursors = collected.cursors;
        globalCursor = collected.globalCursor;
        // eslint-disable-next-line no-await-in-loop -- apply this page before fetching the next (bounded memory, ordered replay).
        applied += await postReplayPage(fetchImpl, baseUrl, headers, collected);

        if (!collected.advanced) {
            break;
        }

        // Once the feed passes `--to`, every later page filters to an empty
        // in-window batch yet cursors keep advancing — without this guard the
        // loop would keep doing real /sync round-trips up to MAX_REPLAY_PAGES
        // for zero applied work. Stop as soon as a page collects nothing in
        // window but did drop changes for being past the cutoff.
        if (!collected.inWindow && collected.pastWindow) {
            break;
        }
    }

    return applied;
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

    if (result.code !== 0 || options.to === undefined) {
        return { code: result.code };
    }

    // Point-in-time recovery: roll forward from the snapshot to `--to`.
    const toMs = Date.parse(options.to);

    if (Number.isNaN(toMs)) {
        options.logger.error(`invalid --to time: ${options.to} (expected an ISO timestamp)`);

        return { code: 1 };
    }

    const token = options.token ?? process.env["CIRRUS_ADMIN_TOKEN"];

    if (token === undefined || token.length === 0) {
        options.logger.error("admin token required for --to replay — pass --token or set CIRRUS_ADMIN_TOKEN");

        return { code: 1 };
    }

    const baseUrl = resolveAdminBaseUrl(options.url, options.logger);

    if (baseUrl === undefined) {
        return { code: 1 };
    }

    try {
        const applied = await replayCdcTo(options, baseUrl, token, toMs);

        options.logger.success(`replayed ${String(applied)} change(s) up to ${options.to}`);

        return { code: 0 };
    } catch (error: unknown) {
        // A failed/partial replay must not leave the operator thinking the
        // point-in-time restore succeeded — surface it as a non-zero exit.
        options.logger.error(error instanceof Error ? error.message : String(error));

        return { code: 1 };
    }
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
