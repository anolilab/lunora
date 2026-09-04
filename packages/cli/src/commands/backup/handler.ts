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
 * `retention` and `prune` are the platform's own retention: what a prune would
 * remove, and the removal itself. `prune` is the only verb here that deletes a
 * backup — the scheduled backup reports what is past the window and leaves it.
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

import { isInteractive, promptYesNo } from "@lunora/config";
import type { BackupManifestEntry, BackupRetentionPreview, PrunedBackups } from "@lunora/runtime";
import { backupObjectKeyOfManifest } from "@lunora/runtime";

import { resolveAdminBearer, targetsRemoteWorker } from "../../util/admin-token";
import { resolveAdminBaseUrl } from "../../util/admin-url";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { Logger } from "../../util/logger";
import { resolveProductionWorkerUrl } from "../../util/resolve-target";
import type { StreamingFetchLike } from "../data-transfer";
import { runExportCommand, runImportCommand } from "../data-transfer";
import type { FetchLike } from "../run/handler";
import { readAndLogBody } from "../run/handler";
import type { BackupDestination } from "./destination";
import { createDirectoryDestination, digestFile } from "./destination";
import type { BackupOptions } from "./index";
import { createR2Destination } from "./r2-destination";

/** Default directory (relative to cwd) backups and their manifest live in. */
const DEFAULT_BACKUP_DIR = ".lunora-backups";

/** Read-only worker endpoint reporting what the platform's retention would delete next (see `@lunora/runtime`). */
const RETENTION_ENDPOINT_PATH = "/_lunora/admin/backup/retention";

/** The only endpoint that deletes a backup (see `@lunora/runtime`). */
const PRUNE_ENDPOINT_PATH = "/_lunora/admin/backup/prune";

/** Worker endpoint that forwards a per-shard native-PITR admin op (see `@lunora/runtime`). */
const PITR_ENDPOINT_PATH = "/_lunora/admin/pitr";
const GET_PITR_BOOKMARK_OP = "__lunora_admin__:getPitrBookmark";
const PITR_RESTORE_OP = "__lunora_admin__:pitrRestore";

type BackupSubcommand = "create" | "list" | "pitr" | "prune" | "restore" | "retention";

interface BackupCommandOptions {
    /** Injectable fetch for the JSON admin endpoints — `pitr`, `retention`, `prune` (not the streaming export fetch). */
    adminFetch?: FetchLike;
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
    /** Injectable confirmer for `prune` (tests, non-TTY callers). Returns `true` on confirmation. */
    confirm?: (prompt: string) => Promise<boolean>;
    cwd?: string;
    /** Backup directory (relative to cwd). Defaults to `.lunora-backups`. */
    dir?: string;
    fetchImpl?: StreamingFetchLike;
    logger: Logger;
    /** Injectable clock for deterministic backup ids in tests. */
    now?: () => Date;
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
    /** Confirm a destructive step without prompting: `pitr restore --prod`, or `prune`. */
    yes?: boolean;
}

interface BackupCommandResult {
    code: number;
    /** Set on `prune` — the sidecar keys the worker reported it deleted. */
    deleted?: string[];
    /** Set on `create` — the written backup's manifest entry. */
    entry?: BackupManifestEntry;
    /** Set on `retention` — what the worker reported it would delete next. */
    preview?: BackupRetentionPreview;
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
    const id = (options.now ?? (() => new Date()))().toISOString();
    const staged = await destination.stage(id);

    // However this ends, staging goes with it. A remote destination stages into
    // a temp directory, and every failure between here and `commit` — a 500
    // mid-export, an unreadable file, a refused upload — used to leave a copy of
    // production rows in it.
    try {
        const result = await runExportCommand({
            cwd: options.cwd,
            fetchImpl: options.fetchImpl,
            logger: options.logger,
            out: staged.path,
            prod: options.prod,
            tables: options.tables,
            token: options.token,
            url: options.url,
        });

        if (result.code !== 0) {
            return { code: result.code };
        }

        const file = destination.locate(id);
        // Digest the snapshot once, here: the destination declares it on the way
        // up (the admin upload route refuses a body that does not match) and the
        // manifest records it for `restore --verify` on the way back down.
        // `digest.bytes` is the file's own length — the export's byte counter
        // counts what came off the wire, which is the same thing only as long as
        // the response ends in a newline.
        const digest = await digestFile(staged.path);

        await destination.commit(file, staged.path, digest);

        const entry: BackupManifestEntry = {
            bytes: digest.bytes,
            createdAt: id,
            file,
            id,
            rows: result.rows,
            sha256: digest.sha256,
            tables: options.tables,
        };

        await destination.record(entry);

        options.logger.success(`backup created: ${file} (${result.rows.toString()} rows, ${digest.bytes.toString()} bytes)`);

        return { code: 0, entry };
    } finally {
        // Cleanup failing cannot make a backup that landed report failure —
        // `logger.success` has already printed, and a script reading the exit
        // code would retry a snapshot that is sitting in the bucket.
        await staged.release().catch((error: unknown) => {
            options.logger.warn(`backup: could not clean up staging (${error instanceof Error ? error.message : String(error)})`);
        });
    }
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
                : `--verify: backup ${entry.id} carries no recorded checksum — it was taken by a release before checksums existed`,
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
    const snapshot = await destination.materialize(matched, target);

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
        await snapshot.release().catch((error: unknown) => {
            options.logger.warn(`backup: could not clean up the downloaded snapshot (${error instanceof Error ? error.message : String(error)})`);
        });
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
    if (options.prod && options.url === undefined) {
        options.logger.error("--prod requires an explicit --url (refusing to target the implicit localhost worker)");

        return undefined;
    }

    if (options.restore === true && options.at === undefined && options.bookmark === undefined) {
        options.logger.error("pitr --restore requires --at <time> or --bookmark <bookmark>");

        return undefined;
    }

    const baseUrl = resolveAdminBaseUrl(options.url, options.logger, options.cwd);

    if (baseUrl === undefined) {
        return undefined;
    }

    // Gated on the RESOLVED destination, not on `--prod`: a `--restore` at a
    // deployed `--url` is an in-place restore of live data whether or not the
    // operator remembered to also declare the flag.
    if (options.restore === true && targetsRemoteWorker({ prod: options.prod, url: baseUrl }) && options.yes !== true) {
        options.logger.error(`pitr --restore restores data in place at ${baseUrl}, which is not local. Re-run with --yes to confirm.`);

        return undefined;
    }

    // Through the shared resolver, like this file's other two admin paths, and
    // after `baseUrl` because the `.dev.vars` fallback is loopback-gated. `pitr`
    // was the one leg still reading `--token`/the environment only.
    const { token } = resolveAdminBearer({ cwd: options.cwd ?? process.cwd(), token: options.token, url: baseUrl });

    if (!token) {
        options.logger.error("admin token required — pass --token, set LUNORA_ADMIN_TOKEN, or add it to .dev.vars (local targets only)");

        return undefined;
    }

    const fetchImpl: FetchLike = options.adminFetch ?? (globalThis as unknown as { fetch: FetchLike }).fetch;

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
        // `--prefix` selects a key prefix INSIDE an R2 bucket; a local directory
        // has no such thing. Refused rather than ignored, exactly as `retention`
        // and `prune` refuse a destination flag that does not apply to them:
        // `backup list --prefix archive/` silently listed the local directory and
        // reported "no backups found" for an archive that was there all along.
        if (options.prefix !== undefined) {
            options.logger.error("--prefix applies only to an R2 destination — pass --bucket alongside it, or use --dir to point at a local directory.");

            return undefined;
        }

        return createDirectoryDestination(join(cwd, options.dir ?? DEFAULT_BACKUP_DIR));
    }

    if (options.dir !== undefined) {
        options.logger.error("--dir applies only to a local destination and does not apply alongside --bucket — drop one.");

        return undefined;
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
        // `default` is how the worker names its unnamed bucket; the storage
        // routes want the parameter absent for it.
        context: { baseUrl, bucket: options.bucket === "default" ? undefined : options.bucket, fetchImpl, token },
        logger: options.logger,
        prefix: options.prefix,
    });
};

/**
 * Resolve the admin bearer + base URL for the two worker-answered backup verbs
 * (`retention`, `prune`). Logs and returns `undefined` on any failure.
 */
const resolveBackupAdminRequest = (options: BackupCommandOptions): { baseUrl: string; fetchImpl: FetchLike; token: string } | undefined => {
    // `--bucket` / `--prefix` / `--dir` choose a destination for the snapshot
    // verbs; these two ask the worker about its own configured store, so a
    // destination flag would be silently ignored. On the command with no undo,
    // that is worth refusing over: `prune --bucket archive-2024` reads as
    // "prune that bucket" and would prune whatever the worker is wired to.
    const ignored = [
        options.bucket === undefined ? undefined : "--bucket",
        options.prefix === undefined ? undefined : "--prefix",
        options.dir === undefined ? undefined : "--dir",
    ].filter((flag) => flag !== undefined);

    if (ignored.length > 0) {
        options.logger.error(
            `${ignored.join(" / ")} ${ignored.length === 1 ? "does" : "do"} not apply here — retention and prune act on the store the worker itself is configured with (\`backupStore\`), not a destination you name.`,
        );

        return undefined;
    }

    if (options.prod === true && options.url === undefined) {
        options.logger.error("--prod requires an explicit --url (refusing to target the implicit localhost worker)");

        return undefined;
    }

    const baseUrl = resolveAdminBaseUrl(options.url, options.logger, options.cwd);

    if (baseUrl === undefined) {
        return undefined;
    }

    // The same resolution `backup list --bucket` uses, so one command does not
    // have two token stories: against a local dev worker `list` reads
    // `.dev.vars` and these would have failed without a flag.
    const { token } = resolveAdminBearer({ cwd: options.cwd ?? process.cwd(), token: options.token, url: baseUrl });

    if (!token) {
        options.logger.error("admin token required — pass --token, set LUNORA_ADMIN_TOKEN, or add it to .dev.vars (local targets only)");

        return undefined;
    }

    const fetchImpl: FetchLike = options.adminFetch ?? (globalThis as unknown as { fetch: FetchLike }).fetch;

    if (typeof fetchImpl !== "function") {
        throw new TypeError("no fetch implementation available — pass pitrFetch or run on Node >= 18");
    }

    return { baseUrl, fetchImpl, token };
};

/** Print a retention selection the way the cron reports it and the prune records it. */
const reportSelection = (options: BackupCommandOptions, preview: BackupRetentionPreview): void => {
    options.logger.info(
        `backup retention would keep the newest ${preview.keep.toString()} of ${preview.eligible.toString()} under ${preview.prefix} and delete ${preview.wouldDelete.length.toString()}`,
    );

    for (const key of preview.wouldDelete) {
        options.logger.info(`  ${backupObjectKeyOfManifest(key)}`);
    }
};

/**
 * `lunora backup retention` — what the platform's own retention would delete on
 * its next run, and nothing else.
 *
 * A read. Retention itself stays on the cron; there is no `--apply` here and no
 * code path in this command deletes an object. The worker answers because it is
 * the only party that knows its own `backupCron` and `backupRetain`, and
 * because eligibility turns on a marker the CLI cannot see from a listing.
 */
const runBackupRetention = async (options: BackupCommandOptions): Promise<BackupCommandResult> => {
    const request = resolveBackupAdminRequest(options);

    if (request === undefined) {
        return { code: 1 };
    }

    const response = await request.fetchImpl(`${request.baseUrl}${RETENTION_ENDPOINT_PATH}`, {
        headers: { authorization: `Bearer ${request.token}` },
        method: "GET",
    });

    if (!response.ok) {
        await readAndLogBody(response, options.logger);

        return { code: 1 };
    }

    const preview = (await response.json()) as BackupRetentionPreview;

    if (preview.cron === undefined) {
        options.logger.info("no scheduled backup is configured (`backupCron`), so retention would delete nothing");

        return { code: 0, preview };
    }

    if (preview.keep <= 0) {
        options.logger.info(`retention is off for cron "${preview.cron}" (\`backupRetain\` unset) — every snapshot under ${preview.prefix} is kept`);

        return { code: 0, preview };
    }

    // Phrased like the line the cron writes and the prune records, so a
    // prediction, a confirmation and an aftermath read as one story.
    reportSelection(options, preview);

    if (preview.eligible === 0) {
        // The likeliest surprise on a real bucket: snapshots exist, but none
        // carry this cron's marker, so retention owns none of them.
        options.logger.info(`no snapshot under ${preview.prefix} was written by this cron, so retention has nothing of its own to remove`);
    }

    return { code: 0, preview };
};

/**
 * Say what a prune actually did — which is not always what it predicted, and
 * every way it can differ matters to whoever is reading.
 */
const reportPruneResult = (options: BackupCommandOptions, result: PrunedBackups): void => {
    options.logger.success(`deleted ${result.deleted.length.toString()} backup(s)`);

    for (const key of result.deleted) {
        options.logger.info(`  ${backupObjectKeyOfManifest(key)}`);
    }

    if (result.failed.length > 0) {
        options.logger.warn(
            `${result.failed.length.toString()} could not be removed — the snapshot may be gone with its manifest left behind; run again to retry`,
        );
    }

    if (result.ignored > 0) {
        options.logger.info(`${result.ignored.toString()} were already gone by the time the delete ran`);
    }

    if (result.remaining > 0) {
        options.logger.info(`${result.remaining.toString()} more are past the window — run \`lunora backup prune\` again`);
    }
};

/**
 * `lunora backup prune` — delete every snapshot past the retention window.
 *
 * The only command that deletes a backup. Nothing else does: the scheduled
 * backup reports what is past the window and leaves it, so the destructive step
 * is one an operator takes deliberately.
 *
 * It prints what will go before asking, and asks by default. Without a TTY it
 * refuses rather than proceeding — a prune that deletes silently because it
 * happened to run in a pipeline is the failure this whole workstream exists to
 * prevent — so a script says `--yes` and means it.
 */
const runBackupPrune = async (options: BackupCommandOptions): Promise<BackupCommandResult> => {
    const request = resolveBackupAdminRequest(options);

    if (request === undefined) {
        return { code: 1 };
    }

    // Show it first, from the same endpoint `lunora backup retention` reads, so
    // the prediction an operator confirms is the one they were shown.
    const previewResponse = await request.fetchImpl(`${request.baseUrl}${RETENTION_ENDPOINT_PATH}`, {
        headers: { authorization: `Bearer ${request.token}` },
        method: "GET",
    });

    if (!previewResponse.ok) {
        await readAndLogBody(previewResponse, options.logger);

        return { code: 1 };
    }

    const preview = (await previewResponse.json()) as BackupRetentionPreview;

    if (preview.keep <= 0 || preview.cron === undefined) {
        options.logger.error(
            "backup prune needs a retention window: set `backupRetain` (and `backupCron`) on the worker. Without one there is nothing past the window to remove.",
        );

        return { code: 1, preview };
    }

    if (preview.wouldDelete.length === 0) {
        options.logger.info(
            `nothing to prune — ${preview.eligible.toString()} snapshot(s) under ${preview.prefix} and retention keeps the newest ${preview.keep.toString()}`,
        );

        return { code: 0, preview };
    }

    reportSelection(options, preview);

    if (options.yes !== true) {
        const confirmer = options.confirm ?? (isInteractive() ? promptYesNo : undefined);

        if (confirmer === undefined) {
            options.logger.error("refusing to delete backups without confirmation — re-run with --yes (there is no undo for an object-store delete)");

            return { code: 1, preview };
        }

        const confirmed = await confirmer(`delete ${preview.wouldDelete.length.toString()} backup(s)? This cannot be undone. [y/N] `);

        if (!confirmed) {
            options.logger.info("nothing was deleted");

            return { code: 0, preview };
        }
    }

    // Send back exactly what was shown and agreed to. The worker deletes the
    // intersection of that with what is still eligible, so a snapshot that
    // became eligible while the prompt was open — a cron fire is enough — is
    // not swept up in a confirmation that never covered it.
    const response = await request.fetchImpl(`${request.baseUrl}${PRUNE_ENDPOINT_PATH}`, {
        body: JSON.stringify({ confirm: preview.wouldDelete }),
        headers: { authorization: `Bearer ${request.token}`, "content-type": "application/json" },
        method: "POST",
    });

    if (!response.ok) {
        await readAndLogBody(response, options.logger);

        return { code: 1, preview };
    }

    // Report what actually went, which is not always what was predicted.
    const result = (await response.json()) as PrunedBackups;

    reportPruneResult(options, result);

    return { code: result.failed.length > 0 ? 1 : 0, deleted: result.deleted, preview };
};

const runBackupCommand = async (options: BackupCommandOptions): Promise<BackupCommandResult> => {
    const cwd = options.cwd ?? process.cwd();

    try {
        // `pitr` is the in-place tier and reads no snapshot at all, and
        // `retention` asks the worker about its own config — neither reads a
        // destination, so both are answered before one exists.
        if (options.subcommand === "pitr") {
            return await runBackupPitr(options);
        }

        if (options.subcommand === "retention") {
            return await runBackupRetention(options);
        }

        if (options.subcommand === "prune") {
            return await runBackupPrune(options);
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
const isBackupSubcommand = (value: unknown): value is BackupSubcommand =>
    value === "create" || value === "list" || value === "pitr" || value === "prune" || value === "restore" || value === "retention";

/** `lunora backup <subcommand>` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<BackupOptions> = defineHandler<BackupOptions>(({ argument, cwd, logger, options }) => {
    const sub = argument[0];

    if (!isBackupSubcommand(sub)) {
        logger.error(`backup: unknown subcommand "${sub ?? ""}" — expected create | list | restore | retention | prune | pitr`);

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
