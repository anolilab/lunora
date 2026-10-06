/**
 * Moving a tenant's data between its Worker and the control plane: the export
 * that `lunora cloud eject` and every tenant backup read, and the import a
 * restore writes through.
 *
 * Both go through the tenant runtime's own admin data-movement routes
 * (`/_lunora/admin/export` and `/_lunora/admin/import`, see
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

/** The tenant's error message (runtime error bodies are `{ error: { message } }`), bounded. */
const tenantErrorMessage = async (response: Response): Promise<string> => {
    const body = (await response.json().catch(() => null)) as { error?: string | { message?: string } } | null;
    const message = typeof body?.error === "string" ? body.error : body?.error?.message;

    return (message ?? "no error message").slice(0, MAX_ERROR_LENGTH);
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
    const response = await send(EXPORT_PATH, "{}", "application/json");

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

/** What a restore wrote, summed over its import batches. */
export interface RestoreSummary {
    /** Rows the restore removed because the snapshot does not hold them. */
    deleted: number;
    /** Rows written (inserted, or overwritten with their snapshot version). */
    inserted: number;
    /** Rows read from the snapshot. */
    received: number;
}

interface ImportResponseBody {
    deleted?: Record<string, number>;
    errors?: unknown[];
    failed?: unknown[];
    inserted?: Record<string, number>;
    received?: number;
}

const sum = (counts: Record<string, number> | undefined): number => Object.values(counts ?? {}).reduce((total, count) => total + count, 0);

/**
 * Rewind the tenant to a gzipped snapshot through its admin import, one
 * {@link IMPORT_BATCH_BYTES} batch at a time.
 *
 * The first batch goes in `mode=replace` over every table: each shard (in one
 * transaction) and the `.global()` tables end up holding exactly that batch, so
 * rows created since the snapshot are deleted and rows edited since are
 * overwritten. The remaining batches append the rest of the snapshot onto that.
 * A snapshot that fits one batch is therefore an atomic rewind per shard; a
 * larger one passes through a window where only part of the snapshot is back.
 *
 * Any batch that is refused, rejects a row, or misses a shard stops the restore:
 * a rewind that skipped rows is not one. Running the restore again is safe — it
 * starts over with a replace — and the pre-restore snapshot undoes it.
 *
 * ponytail: the multi-batch window; a staged import (load every batch, then swap
 * per shard) closes it.
 */
export const restoreTenantSnapshot = async (send: TenantSend, gzipped: ReadableStream<Uint8Array<ArrayBuffer>>): Promise<RestoreSummary> => {
    const summary: RestoreSummary = { deleted: 0, inserted: 0, received: 0 };
    const encoder = new TextEncoder();
    let batch = "";
    let batchBytes = 0;
    let batches = 0;

    const flush = async (): Promise<void> => {
        // The replace batch goes out even when empty: an empty snapshot empties the tenant.
        if (batch === "" && batches > 0) {
            return;
        }

        const response = await send(batches === 0 ? `${IMPORT_PATH}?mode=replace` : IMPORT_PATH, batch, "application/x-ndjson");

        batches += 1;
        batch = "";
        batchBytes = 0;

        if (response.status !== 200 && response.status !== 207) {
            throw new TenantAdminError(`tenant import failed (HTTP ${String(response.status)}): ${await tenantErrorMessage(response)}`, response.status);
        }

        const result = await readJson<ImportResponseBody>(response);

        // A runtime from before replace mode ignores `?mode=` and appends: the
        // first batch still lands, but the rewind must not be reported as one.
        if (batches === 1 && result.deleted === undefined) {
            throw new TenantAdminError("the tenant's runtime predates replace-mode import, so it cannot be rewound — redeploy it and restore again", 0);
        }

        summary.deleted += sum(result.deleted);
        summary.inserted += sum(result.inserted);
        summary.received += result.received ?? 0;

        const rowErrors = result.errors?.length ?? 0;
        const unreachable = result.failed?.length ?? 0;

        if (rowErrors > 0 || unreachable > 0) {
            throw new TenantAdminError(
                `restore stopped at import batch ${String(batches)}: ${String(rowErrors)} row(s) rejected, ${String(unreachable)} shard(s) unreachable — run it again, or restore the pre-restore snapshot`,
                response.status,
            );
        }
    };

    // Batches go out in snapshot order, one at a time, as the snapshot streams in.
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

    return summary;
};
