/**
 * Moving a tenant's data between its Worker and the control plane: the export
 * that `lunora cloud eject` and every tenant backup read, and the import a
 * restore writes through.
 *
 * Both go through the tenant runtime's own admin data-movement routes
 * (`/_lunora/admin/export`, and `/_lunora/admin/import` with its staged
 * `/import/commit` and `/import/abort`, see
 * `packages/runtime/src/data-movement-admin-routes.ts`) under the deployment's
 * admin bearer. The bearer is unsealed by the caller and only ever travels in the
 * `authorization` header built here — never into a log line, an error message or
 * a stored row. Snapshot contents are treated the same way: errors carry the
 * tenant's status and error message, never a byte of the body being moved.
 */
import { stripTrailingSlashes } from "../admin/proxy";
import readNdjson from "../lib/read-ndjson";
import readJson from "../read-json";
import type { CopyOutcome, MultipartBucket } from "./multipart";
import { copyObject, uploadStream } from "./multipart";

/** One call into a tenant Worker's admin API, with the admin bearer already attached. */
export type TenantSend = (path: string, body: string, contentType: "application/json" | "application/x-ndjson") => Promise<Response>;

/** The subset of an R2 bucket binding tenant backups use. */
export interface TenantBackupBucket extends MultipartBucket {
    delete: (keys: string | string[]) => Promise<void>;
    get: (key: string) => Promise<null | { body: ReadableStream<Uint8Array<ArrayBuffer>>; size: number }>;
}

/** A tenant admin call that did not succeed. `status` is the tenant's HTTP status (0 when it was never reached). */
export class TenantAdminError extends Error {
    public readonly status: number;

    public constructor(message: string, status: number) {
        super(message);
        this.name = "TenantAdminError";
        this.status = status;
    }
}

/**
 * Bytes per import request. The tenant's import reads its body under the
 * runtime's 1 MiB `MAX_BODY_BYTES` and answers 413 past it; this leaves headroom,
 * matching `lunora import`'s own batching.
 */
export const IMPORT_BATCH_BYTES = 900_000;

const EXPORT_PATH = "/_lunora/admin/export";
const IMPORT_PATH = "/_lunora/admin/import";
const MAX_ERROR_LENGTH = 300;

/**
 * A {@link TenantSend} for one deployment over its public URL — the path every
 * target has. A driver with a shorter in-network path (`cloudflare-wfp`'s
 * dispatch namespace) offers it as its own `reach`.
 */
export const tenantSender = (target: { adminToken: string; url: string }): TenantSend => {
    const base = stripTrailingSlashes(target.url);

    return (path, body, contentType) =>
        fetch(`${base}${path}`, { body, headers: { authorization: `Bearer ${target.adminToken}`, "content-type": contentType }, method: "POST" });
};

/** A tenant-supplied text, bounded — or `fallback` when it is not a string at all. */
const boundedText = (value: unknown, fallback: string): string => (typeof value === "string" ? value : fallback).slice(0, MAX_ERROR_LENGTH);

/** How many entries a tenant-supplied list has — zero for anything that is not a list. */
const entriesOf = (value: unknown): number => (Array.isArray(value) ? value.length : 0);

/** The tenant's error message (runtime error bodies are `{ error: { message } }`), bounded. */
const tenantErrorMessage = async (response: Response): Promise<string> => {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    const error = body?.error;

    return boundedText(typeof error === "string" ? error : (error as { message?: unknown } | null | undefined)?.message, "no error message");
};

/**
 * Start a whole-deployment export and return the tenant's NDJSON body.
 *
 * `POST` with an empty body means "every table": the runtime seeds the table
 * list from the schema and fans out to every shard its registry lists. The
 * shard-local half is settled before the tenant commits a status, so a shard it
 * could not reach (502) or a `.shardBy()` table with no shard registry (400)
 * arrives here as a real error rather than a short file.
 */
export const exportTenantSnapshot = async (send: TenantSend): Promise<ReadableStream<Uint8Array<ArrayBuffer>>> => {
    // Auth by name: the runtime leaves it out unless asked. A snapshot is only ever
    // downloaded or restored by an owner/admin, so it carries the users too.
    const response = await send(EXPORT_PATH, JSON.stringify({ sections: ["auth", "kv", "storage"] }), "application/json");

    if (!response.ok || !response.body) {
        throw new TenantAdminError(`tenant export failed (HTTP ${String(response.status)}): ${await tenantErrorMessage(response)}`, response.status);
    }

    return response.body;
};

const SNAPSHOT_CONTENT_TYPE = "application/gzip";

/**
 * The largest compressed snapshot the control plane stores. Multipart lifts the
 * Worker-memory ceiling the old 64 MiB cap stood for, but the export is the
 * tenant's own code, so the stream still needs a bound on what it can make us
 * store and how long it can keep the backup sweep busy.
 *
 * ponytail: one ceiling for every plan; make it plan data next to
 * `limits.backupRetention` if a plan needs a different one.
 */
export const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024 * 1024;

/** A snapshot written: its stored (compressed) size, and the off-site copy when one is configured. */
export interface CapturedSnapshot {
    bytes: number;
    offsite?: CopyOutcome;
}

/**
 * Export the tenant's data, gzip it and stream it to `key` as a multipart
 * upload (`./multipart.ts`), so a snapshot is bounded by {@link MAX_SNAPSHOT_BYTES}
 * rather than by the Worker's memory. Nothing is written unless the whole export
 * arrived: a tenant stream that errors midway or passes the cap aborts the upload.
 *
 * Then, with `offsite`, copies the stored object to the off-site account. That
 * copy never fails the snapshot — its outcome is returned for the caller to
 * record on the row.
 */
export const captureTenantSnapshot = async (options: {
    bucket: TenantBackupBucket;
    key: string;
    offsite?: MultipartBucket;
    send: TenantSend;
}): Promise<CapturedSnapshot> => {
    const exported = await exportTenantSnapshot(options.send);
    const bytes = await uploadStream(
        options.bucket,
        options.key,
        exported.pipeThrough(new CompressionStream("gzip")),
        SNAPSHOT_CONTENT_TYPE,
        MAX_SNAPSHOT_BYTES,
    );

    return options.offsite ? { bytes, offsite: await copyObject(options.bucket, options.offsite, options.key, SNAPSHOT_CONTENT_TYPE) } : { bytes };
};

/** What a restore wrote, from the commit of its staged import. */
export interface RestoreSummary {
    /** Rows the restore removed because the snapshot does not hold them, in total. */
    deleted: number;
    /** {@link RestoreSummary.deleted} per table (`$auth`, `$kv`, `$storage` for the sections). */
    deletedByTable: Record<string, number>;
    /** Rows written (inserted, or overwritten with their snapshot version). */
    inserted: number;
    /** Rows read from the snapshot. */
    received: number;
}

interface StageResponseBody {
    errors?: unknown;
    failed?: unknown;
    received?: unknown;
    session?: string;
}

interface CommitResponseBody {
    deleted?: unknown;
    errors?: unknown[];
    failed?: unknown[];
    inserted?: unknown;
    status?: unknown;
}

/**
 * The tenant's answers come from the tenant's own code, so nothing in them is
 * stored or summed as sent: a count is a non-negative safe integer or nothing,
 * and a per-table map keeps at most {@link MAX_COUNTED_TABLES} tables with names
 * of at most {@link MAX_TABLE_NAME_LENGTH} characters. What does not fit is
 * folded into one {@link TRUNCATED_TABLES} entry.
 */
const MAX_COUNTED_TABLES = 64;
const MAX_TABLE_NAME_LENGTH = 128;
const TRUNCATED_TABLES = "(other tables)";

/** `value` as a count, or `undefined` when it is not a non-negative safe integer. */
const countOf = (value: unknown): number | undefined => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined);

const saturatingAdd = (a: number, b: number): number => Math.min(a + b, Number.MAX_SAFE_INTEGER);

/** A tenant's per-table count map, bounded (see {@link MAX_COUNTED_TABLES}); anything else is an empty map. */
export const boundedCounts = (raw: unknown): Record<string, number> => {
    const counts: Record<string, number> = {};

    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        return counts;
    }

    let kept = 0;
    let folded: number | undefined;

    for (const [table, value] of Object.entries(raw as Record<string, unknown>)) {
        const count = countOf(value);

        if (count === undefined) {
            continue;
        }

        if (kept < MAX_COUNTED_TABLES && table.length > 0 && table.length <= MAX_TABLE_NAME_LENGTH && table !== TRUNCATED_TABLES) {
            counts[table] = count;
            kept += 1;
        } else {
            folded = saturatingAdd(folded ?? 0, count);
        }
    }

    if (folded !== undefined) {
        counts[TRUNCATED_TABLES] = folded;
    }

    return counts;
};

const sum = (counts: Record<string, number>): number => {
    let total = 0;

    for (const count of Object.values(counts)) {
        total = saturatingAdd(total, count);
    }

    return total;
};

/** Commit attempts before a restore gives up on a session whose commit began: each retry finishes what the last one could not. */
const COMMIT_ATTEMPTS = 3;

const sessionPath = (action: "abort" | "commit"): string => `${IMPORT_PATH}/${action}`;

/**
 * Drop the staged session, best effort: the tenant's data was never touched, and
 * staging the tenant cannot drop expires on its own within the hour.
 */
const abortSession = async (send: TenantSend, session: string): Promise<void> => {
    await send(sessionPath("abort"), JSON.stringify({ session }), "application/json").catch(() => undefined);
};

/**
 * 409 codes that mean "send the commit again" rather than "refused": another
 * commit of the session is under way, or a batch landed after this one's dry run.
 */
const RETRY_CODES: ReadonlySet<string> = new Set(["IMPORT_SESSION_CHANGED", "IMPORT_SESSION_COMMITTING"]);

type RefusedBody = CommitResponseBody & { error?: { code?: unknown; message?: unknown } };

/** Why the tenant refused a commit before it wrote anything (its dry run, or a session it cannot commit). */
const refusalOf = (body: RefusedBody | null): string => {
    if (body?.status === "refused") {
        return `${String(entriesOf(body.errors))} row(s) would not land, ${String(entriesOf(body.failed))} shard(s) unreachable — nothing changed`;
    }

    return boundedText(body?.error?.message, "the tenant refused the commit");
};

/** A commit attempt that neither landed nor was refused: a status, or the network failure. */
const failureOf = (response: unknown): string => {
    if (response instanceof Response) {
        return `HTTP ${String(response.status)}`;
    }

    return `the tenant did not answer (${(response instanceof Error ? response.message : String(response)).slice(0, MAX_ERROR_LENGTH)})`;
};

/** One commit attempt: the totals, a refusal (aborted, then thrown), or why it has to be sent again. */
const attemptCommit = async (send: TenantSend, session: string): Promise<{ body: CommitResponseBody } | { failure: string }> => {
    const response = await send(sessionPath("commit"), JSON.stringify({ session }), "application/json").catch((error: unknown) => error);

    if (response instanceof Response && response.status === 200) {
        return { body: await readJson<CommitResponseBody>(response) };
    }

    if (response instanceof Response && response.status === 409) {
        const body = (await response.json().catch(() => null)) as RefusedBody | null;

        if (typeof body?.error?.code === "string" && RETRY_CODES.has(body.error.code)) {
            return { failure: boundedText(body?.error?.message, "the commit has to be sent again") };
        }

        await abortSession(send, session);

        throw new TenantAdminError(`restore refused before anything was written: ${refusalOf(body)}`, 409);
    }

    return { failure: failureOf(response) };
};

/**
 * Swap the staged snapshot in. A commit that failed part-way (a shard
 * unreachable, a section's store refusing) is finished by sending it again; one
 * refused before it wrote anything is aborted.
 */
const commitSession = async (send: TenantSend, session: string): Promise<CommitResponseBody> => {
    let lastFailure = "";

    for (let attempt = 1; attempt <= COMMIT_ATTEMPTS; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- retries are sequential by design
        const outcome = await attemptCommit(send, session);

        if ("body" in outcome) {
            return outcome.body;
        }

        lastFailure = outcome.failure;
    }

    throw new TenantAdminError(
        `the restore's commit did not finish after ${String(COMMIT_ATTEMPTS)} attempts (${lastFailure}); part of the tenant may already hold the snapshot — restore the snapshot again, or the pre-restore snapshot`,
        502,
    );
};

/**
 * Rewind the tenant to a gzipped snapshot through its staged replace import
 * (`packages/runtime/src/import-session.ts`):
 *
 * every {@link IMPORT_BATCH_BYTES} batch is staged into one session (`mode=replace`
 * with `stage` set to the session id), which does not touch the tenant's data
 * yet; then the commit swaps the whole snapshot in — each shard in one Durable
 * Object transaction after a dry run on all of them, then the `.global()`
 * tables, the auth tables, KV and storage objects (see docs/RESTORE.md for what
 * each guarantees).
 *
 * Any batch that is refused, rejects a row or misses a shard aborts the session,
 * so the tenant is left exactly as it was. A commit that fails part-way is sent
 * again; a commit refused by its dry run is aborted.
 */
export const restoreTenantSnapshot = async (
    send: TenantSend,
    gzipped: ReadableStream<Uint8Array<ArrayBuffer>>,
    session: string = `restore-${crypto.randomUUID()}`,
): Promise<RestoreSummary> => {
    // A runtime without staged import has no abort route. Asked first, because one
    // that predates it would read the staged batches as single-request replaces.
    const probe = await send(sessionPath("abort"), JSON.stringify({ session }), "application/json");

    if (probe.status !== 200) {
        throw new TenantAdminError(
            "the tenant's runtime predates staged import, so it cannot be rewound atomically — redeploy it and restore again",
            probe.status,
        );
    }

    const encoder = new TextEncoder();
    let received = 0;
    let batch = "";
    let batchBytes = 0;
    let batches = 0;

    const flush = async (): Promise<void> => {
        // The first batch goes out even when empty: it opens the session, and an empty snapshot empties the tenant.
        if (batch === "" && batches > 0) {
            return;
        }

        const response = await send(`${IMPORT_PATH}?mode=replace&stage=${session}`, batch, "application/x-ndjson");

        batches += 1;
        batch = "";
        batchBytes = 0;

        if (response.status !== 200 && response.status !== 207) {
            throw new TenantAdminError(`tenant import failed (HTTP ${String(response.status)}): ${await tenantErrorMessage(response)}`, response.status);
        }

        const result = await readJson<StageResponseBody>(response);
        const rowErrors = entriesOf(result.errors);
        const unreachable = entriesOf(result.failed);

        received = saturatingAdd(received, countOf(result.received) ?? 0);

        if (rowErrors > 0 || unreachable > 0) {
            throw new TenantAdminError(
                `restore stopped at import batch ${String(batches)}: ${String(rowErrors)} row(s) rejected, ${String(unreachable)} shard(s) unreachable — nothing was changed`,
                response.status,
            );
        }
    };

    try {
        // Batches are staged in snapshot order, one at a time, as the snapshot streams in.
        await readNdjson(gzipped.pipeThrough(new DecompressionStream("gzip")), async (line) => {
            const size = encoder.encode(line).byteLength + 1;

            if (size > IMPORT_BATCH_BYTES) {
                throw new TenantAdminError(`a snapshot row is larger than the ${String(IMPORT_BATCH_BYTES)}-byte import limit`, 0);
            }

            if (batchBytes + size > IMPORT_BATCH_BYTES) {
                await flush();
            }

            batch += `${line}\n`;
            batchBytes += size;
        });
        await flush();
    } catch (error) {
        await abortSession(send, session);

        throw error;
    }

    const committed = await commitSession(send, session);

    const deletedByTable = boundedCounts(committed.deleted);

    return { deleted: sum(deletedByTable), deletedByTable, inserted: sum(boundedCounts(committed.inserted)), received };
};
