/**
 * `lunora backup create | list | restore | pitr` — managed snapshot backups on
 * top of the export/import admin endpoints, plus native point-in-time recovery.
 *
 * `create` exports every table to a timestamped NDJSON snapshot and records it
 * in a manifest; `list` prints the manifest; `restore <id|file>` imports a
 * chosen snapshot back through the import endpoint. Schedule `create` (CI cron,
 * or a cron-triggered action) for automated backups — this is the off-platform
 * / portable / >30-day tier.
 *
 * Where a snapshot lands is a destination, not a format: with no `--bucket` it
 * is a local directory, with one it is an R2 bucket reached through the admin
 * storage routes (`./destination`, `./r2-destination`). The NDJSON and the
 * manifest are identical either way.
 *
 * `pitr` is the complementary in-place tier: it drives the platform's own
 * Durable-Object change log to restore a shard to any moment in the last 30
 * days (`getPitrBookmark` / `pitrRestore` via the admin-gated PITR endpoint),
 * no R2 read and no snapshot replay.
 */
import { join } from "node:path";

import { resolveAdminBearer } from "../../util/admin-token";
import { resolveAdminBaseUrl } from "../../util/admin-url";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { Logger } from "../../util/logger";
import { resolveProductionWorkerUrl } from "../../util/resolve-target";
import type { StreamingFetchLike } from "../data-transfer";
import { runExportCommand, runImportCommand } from "../data-transfer";
import type { FetchLike } from "../run/handler";
import { readAndLogBody } from "../run/handler";
import type { BackupDestination, BackupManifestEntry } from "./destination";
import { createDirectoryDestination, digestFile } from "./destination";
import type { BackupOptions } from "./index";
import { createR2Destination } from "./r2-destination";

/** Default directory (relative to cwd) backups and their manifest live in. */
const DEFAULT_BACKUP_DIR = ".lunora-backups";

/** Worker endpoint that forwards a per-shard native-PITR admin op (see `@lunora/runtime`). */
const PITR_ENDPOINT_PATH = "/_lunora/admin/pitr";
const GET_PITR_BOOKMARK_OP = "__lunora_admin__:getPitrBookmark";
const PITR_RESTORE_OP = "__lunora_admin__:pitrRestore";

type BackupSubcommand = "create" | "list" | "pitr" | "restore";

interface BackupCommandOptions {
    /** `pitr`: restore to the bookmark nearest this time (ISO or epoch-ms), within 30 days. */
    at?: string;
    /** `pitr restore`: an explicit bookmark to restore to (e.g. an undo bookmark). Wins over `--at`. */
    bookmark?: string;

    /**
     * Store snapshots in an R2 bucket instead of a directory. The value is the
     * bucket name the worker knows (`GET /_lunora/admin/storage/buckets` lists
     * them); pass `default` for a single-bucket deployment.
     */
    bucket?: string;
    cwd?: string;
    /** Backup directory (relative to cwd). Defaults to `.lunora-backups`. */
    dir?: string;
    fetchImpl?: StreamingFetchLike;
    logger: Logger;
    /** Injectable clock for deterministic backup ids in tests. */
    now?: () => Date;
    /** Injectable fetch for the `pitr` admin endpoint (plain JSON, not the streaming export fetch). */
    pitrFetch?: FetchLike;
    /** Key prefix bucket-backed backups live under. Defaults to `backups/`. */
    prefix?: string;
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
    /** `restore`: check the snapshot's SHA-256 against the manifest before importing a byte of it. */
    verify?: boolean;
    /** Required alongside `--prod` for `pitr restore` — confirms restoring production in place. */
    yes?: boolean;
}

interface BackupCommandResult {
    code: number;
    /** Set on `create` — the written backup's manifest entry. */
    entry?: BackupManifestEntry;
}

/**
 * Export every selected table and land the snapshot at `destination`. The
 * export itself is destination-blind — it always streams NDJSON to a local
 * path — so the only thing that varies is where `stage` puts that path and
 * what `commit` then does with it. The manifest entry is recorded LAST, after
 * the bytes are known to have landed, so the index never points at a snapshot
 * that is not there.
 */
const runBackupCreate = async (options: BackupCommandOptions, destination: BackupDestination): Promise<BackupCommandResult> => {
    const timestamp = (options.now ?? (() => new Date()))().toISOString();
    // Colons/periods are awkward in filenames and object keys alike; keep the raw id.
    const name = `lunora-backup-${timestamp.replaceAll(/[.:]/gu, "-")}.ndjson`;
    const staged = await destination.stage(name);

    const result = await runExportCommand({
        cwd: options.cwd,
        fetchImpl: options.fetchImpl,
        logger: options.logger,
        out: staged,
        prod: options.prod,
        tables: options.tables,
        token: options.token,
        url: options.url,
    });

    if (result.code !== 0) {
        return { code: result.code };
    }

    const file = destination.locate(name);
    // Digest the snapshot once, here: the destination declares it on the way up
    // (the admin upload route refuses a body that does not match) and the
    // manifest records it for `restore --verify` on the way back down.
    const digest = await digestFile(staged);

    await destination.commit(file, staged, digest);

    const entry: BackupManifestEntry = {
        bytes: result.bytes,
        createdAt: timestamp,
        file,
        id: timestamp,
        rows: result.rows,
        sha256: digest.sha256,
        tables: options.tables,
    };

    await destination.record(entry);

    options.logger.success(`backup created: ${file} (${result.rows.toString()} rows, ${result.bytes.toString()} bytes)`);

    return { code: 0, entry };
};

/**
 * `--verify`: re-digest the snapshot and compare it with the checksum recorded
 * when it was written, BEFORE a single row is imported. A snapshot with no
 * recorded checksum fails closed rather than passing silently — "unverifiable"
 * and "verified" must never read the same on a restore.
 */
const verifySnapshot = async (path: string, entry: BackupManifestEntry | undefined, logger: Logger): Promise<BackupCommandResult | undefined> => {
    if (entry?.sha256 === undefined) {
        logger.error(
            entry === undefined
                ? "--verify needs a recorded checksum, and a snapshot restored by path/key has no manifest entry — restore it by its backup id instead"
                : `--verify: backup ${entry.id} carries no recorded checksum (it predates checksums, or was written by the platform's scheduled backup)`,
        );

        return { code: 1 };
    }

    const digest = await digestFile(path);

    if (digest.sha256 !== entry.sha256) {
        logger.error(`--verify: ${entry.file} does not match its recorded checksum (expected ${entry.sha256}, got ${digest.sha256}) — nothing was imported`);

        return { code: 1 };
    }

    logger.success(`verified ${entry.file} against its recorded sha256`);

    return undefined;
};

const runBackupList = async (options: BackupCommandOptions, destination: BackupDestination): Promise<BackupCommandResult> => {
    const manifest = await destination.list();

    if (manifest.length === 0) {
        options.logger.info(`no backups found in ${destination.label}`);

        return { code: 0 };
    }

    for (const entry of manifest) {
        options.logger.info(`${entry.id}  ${entry.rows.toString()} rows  ${entry.bytes.toString()} bytes  ${entry.file}`);
    }

    return { code: 0 };
};

const runBackupRestore = async (options: BackupCommandOptions, destination: BackupDestination): Promise<BackupCommandResult> => {
    const { target } = options;

    if (target === undefined || target.length === 0) {
        options.logger.error("restore requires a backup id or file path. Usage: lunora backup restore <id|file>");

        return { code: 1 };
    }

    // Resolve the target: a manifest id maps to its recorded file; otherwise
    // treat it as a direct path (absolute, or relative to cwd) / object key.
    const manifest = await destination.list();
    const matched = manifest.find((entry) => entry.id === target);
    const snapshot = await destination.materialize(matched?.file ?? target, matched !== undefined);

    if (snapshot === undefined) {
        options.logger.error(`backup not found: ${target}`);

        return { code: 1 };
    }

    try {
        if (options.verify === true) {
            const failure = await verifySnapshot(snapshot.path, matched, options.logger);

            if (failure !== undefined) {
                return failure;
            }
        }

        const result = await runImportCommand({
            cwd: options.cwd,
            fetchImpl: options.fetchImpl,
            file: snapshot.path,
            logger: options.logger,
            prod: options.prod,
            token: options.token,
            url: options.url,
            yes: options.yes,
        });

        // Plain snapshot import — the off-platform / portable restore. For in-place
        // time-travel to an arbitrary moment in the last 30 days, use native PITR
        // (`lunora backup pitr` / the studio) rather than replaying a snapshot.
        return { code: result.code };
    } finally {
        await snapshot.release();
    }
};

/**
 * `lunora backup pitr` — native Durable-Object point-in-time recovery (the
 * in-place ≤30-day tier). With no flags it reads the shard's current bookmark;
 * `--at <time>` previews the bookmark nearest that moment. `--restore` arms a
 * restore (to `--bookmark`, or the one nearest `--at`) and returns an undo
 * bookmark; `--restart` applies it immediately. Hits the admin-gated
 * `/_lunora/admin/pitr` endpoint, which forwards the op to one shard.
 */
interface PitrRequest {
    fetchImpl: FetchLike;
    requestUrl: string;
    token: string;
}

/** Validate the guards and resolve the token / URL / fetch for a `pitr` call. Logs and returns `undefined` on any failure. */
const resolvePitrRequest = (options: BackupCommandOptions): PitrRequest | undefined => {
    const token = options.token ?? process.env.LUNORA_ADMIN_TOKEN;

    if (!token) {
        options.logger.error("admin token required — pass --token or set LUNORA_ADMIN_TOKEN");

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

    const baseUrl = resolveAdminBaseUrl(options.url, options.logger, options.cwd);

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

    await readAndLogBody(response, options.logger);

    return { code: response.ok ? 0 : 1 };
};

/**
 * Pick the destination once, for every verb. `--bucket` selects R2 (reached
 * through the worker's admin storage routes, so the bucket binding is the auth
 * and no credentials are involved); anything else is a local directory.
 *
 * The two are never mixed in one invocation: a merged listing would leave an
 * operator unable to say which copy of a snapshot they are about to restore.
 * `undefined` means the target could not be resolved and the reason is logged.
 */
const resolveDestination = (options: BackupCommandOptions, cwd: string): BackupDestination | undefined => {
    if (options.bucket === undefined) {
        return createDirectoryDestination(join(cwd, options.dir ?? DEFAULT_BACKUP_DIR));
    }

    if (options.prod === true && options.url === undefined) {
        options.logger.error("--prod requires an explicit --url (refusing to target the implicit localhost worker)");

        return undefined;
    }

    const baseUrl = resolveAdminBaseUrl(options.url, options.logger, options.cwd);

    if (baseUrl === undefined) {
        return undefined;
    }

    const { token } = resolveAdminBearer({ cwd, token: options.token, url: baseUrl });

    if (!token) {
        options.logger.error("admin token required — pass --token, set LUNORA_ADMIN_TOKEN, or add it to .dev.vars (local targets only)");

        return undefined;
    }

    const fetchImpl = options.fetchImpl ?? (globalThis as unknown as { fetch: StreamingFetchLike }).fetch;

    if (typeof fetchImpl !== "function") {
        throw new TypeError("no fetch implementation available — pass fetchImpl or run on Node >= 18");
    }

    return createR2Destination({
        bucket: options.bucket === "default" ? undefined : options.bucket,
        context: { baseUrl, bucket: options.bucket === "default" ? undefined : options.bucket, fetchImpl, token },
        logger: options.logger,
        prefix: options.prefix,
    });
};

const runBackupCommand = async (options: BackupCommandOptions): Promise<BackupCommandResult> => {
    const cwd = options.cwd ?? process.cwd();

    try {
        // `pitr` is the in-place tier and reads no snapshot at all, so it is
        // answered before any destination exists.
        if (options.subcommand === "pitr") {
            return await runBackupPitr(options);
        }

        const destination = resolveDestination(options, cwd);

        if (destination === undefined) {
            return { code: 1 };
        }

        if (options.subcommand === "create") {
            return await runBackupCreate(options, destination);
        }

        if (options.subcommand === "list") {
            return await runBackupList(options, destination);
        }

        return await runBackupRestore(options, destination);
    } catch (error: unknown) {
        // Surface a corrupt-manifest (or other) failure as a clean non-zero exit
        // instead of an unhandled rejection — and never clobber an unreadable index.
        options.logger.error(error instanceof Error ? error.message : String(error));

        return { code: 1 };
    }
};

/** Narrow a raw argument to a known {@link BackupSubcommand}. */
const isBackupSubcommand = (value: unknown): value is BackupSubcommand => value === "create" || value === "list" || value === "pitr" || value === "restore";

/** `lunora backup <subcommand>` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<BackupOptions> = defineHandler<BackupOptions>(({ argument, cwd, logger, options }) => {
    const sub = argument[0];

    if (!isBackupSubcommand(sub)) {
        logger.error(`backup: unknown subcommand "${sub ?? ""}" — expected create | list | restore | pitr`);

        return { code: 1 };
    }

    return runBackupCommand({
        at: options.at,
        bookmark: options.bookmark,
        bucket: options.bucket,
        cwd,
        dir: options.dir,
        logger,
        prefix: options.prefix,
        prod: options.prod === true,
        restart: options.restart === true,
        restore: options.restore === true,
        shard: options.shard,
        subcommand: sub,
        tables: options.tables,
        target: argument[1],
        token: options.token,
        url: resolveProductionWorkerUrl({ cwd, prod: options.prod === true, url: options.url }),
        verify: options.verify === true,
        yes: options.yes === true,
    });
});

export { execute };
export type { BackupCommandOptions, BackupCommandResult, BackupSubcommand };
export { runBackupCommand };
