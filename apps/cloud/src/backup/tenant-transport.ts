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

/** One call into a tenant Worker's admin API, with the admin bearer already attached. */
export type TenantSend = (path: string, body: string, contentType: "application/json" | "application/x-ndjson") => Promise<Response>;

/** The dispatch-namespace binding, as far as reaching one script goes. */
export interface DispatchNamespaceLike {
    get: (scriptName: string) => { fetch: (request: Request) => Promise<Response> };
}

/** The subset of an R2 bucket binding tenant backups use. */
export interface TenantBackupBucket {
    delete: (keys: string | string[]) => Promise<void>;
    get: (key: string) => Promise<null | { body: ReadableStream<Uint8Array<ArrayBuffer>>; size: number }>;
    put: (key: string, value: Uint8Array<ArrayBuffer>, options?: { httpMetadata?: { contentType?: string } }) => Promise<unknown>;
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
 * The largest compressed snapshot the control plane will hold.
 *
 * R2's binding refuses a stream of unknown length, and a gzip stream never has
 * one, so a snapshot is assembled in memory before the upload. This keeps that
 * well inside a Worker's ~128 MB alongside the tenant's decompressed rows in
 * flight. NDJSON of document rows typically compresses 5-10x, so this covers
 * several hundred megabytes of tenant data.
 *
 * ponytail: in-memory assembly; switch to an R2 multipart upload when a tenant
 * outgrows this — the export itself also materialises every shard's rows in the
 * tenant Worker, so that side has to stream first for it to matter.
 */
export const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;

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
 * A {@link TenantSend} for one deployment: through the dispatch namespace when
 * the control plane has one bound (the same path the cron fan-out takes, so the
 * call never leaves Cloudflare), else over the deployment's public URL (local dev,
 * where dispatch namespaces are not emulated).
 */
export const tenantSender = (target: { adminToken: string; scriptName: string; url: string }, dispatcher: DispatchNamespaceLike | undefined): TenantSend => {
    const init = (body: string, contentType: string): RequestInit => {
        return { body, headers: { authorization: `Bearer ${target.adminToken}`, "content-type": contentType }, method: "POST" };
    };

    if (dispatcher) {
        const script = dispatcher.get(target.scriptName);

        return (path, body, contentType) => script.fetch(new Request(`https://tenant.internal${path}`, init(body, contentType)));
    }

    const base = stripTrailingSlashes(target.url);

    return (path, body, contentType) => fetch(`${base}${path}`, init(body, contentType));
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

/** Drain a stream into one buffer, refusing past `maxBytes`. */
const collect = async (stream: ReadableStream<Uint8Array<ArrayBuffer>>, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> => {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    for (;;) {
        // eslint-disable-next-line no-await-in-loop -- a stream is read sequentially by construction
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        total += value.byteLength;

        if (total > maxBytes) {
            // eslint-disable-next-line no-await-in-loop -- one-shot cleanup before refusing
            await reader.cancel();

            throw new TenantAdminError(`snapshot exceeds the ${String(maxBytes / 1024 / 1024)} MiB the control plane can hold`, 0);
        }

        chunks.push(value);
    }

    const buffer = new Uint8Array(total);
    let offset = 0;

    for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.byteLength;
    }

    return buffer;
};

/**
 * Export the tenant's data, gzip it and write it to `key`. Returns the stored
 * (compressed) size. Nothing is written unless the whole export arrived: a
 * tenant stream that errors midway rejects the read before `put` runs.
 */
export const captureTenantSnapshot = async (options: { bucket: TenantBackupBucket; key: string; maxBytes?: number; send: TenantSend }): Promise<number> => {
    const exported = await exportTenantSnapshot(options.send);
    const compressed = await collect(exported.pipeThrough(new CompressionStream("gzip")), options.maxBytes ?? MAX_SNAPSHOT_BYTES);

    await options.bucket.put(options.key, compressed, { httpMetadata: { contentType: "application/gzip" } });

    return compressed.byteLength;
};

/** What a restore wrote, summed over its import batches. */
export interface RestoreSummary {
    /** Rows whose `_id` already existed and were left untouched (the import is append-only). */
    conflicts: number;
    /** Rows written. */
    inserted: number;
    /** Rows read from the snapshot. */
    received: number;
    /** Rows the tenant rejected (validation against the current schema, id collisions). */
    rowErrors: number;
    /** Shards an import batch could not reach — non-empty means part of the snapshot was not written. */
    unreachableShards: number;
}

interface ImportResponseBody {
    conflicts?: number;
    errors?: unknown[];
    failed?: unknown[];
    inserted?: Record<string, number>;
    received?: number;
}

/**
 * Replay a gzipped snapshot into the tenant through its admin import, one
 * {@link IMPORT_BATCH_BYTES} batch at a time.
 *
 * The import is append-only: a row whose `_id` already exists is skipped
 * (counted in `conflicts`), so re-running a restore is safe and a partially
 * applied one can simply be run again. A batch the tenant refuses outright
 * (anything but 200/207) stops the restore — earlier batches stay written.
 */
export const restoreTenantSnapshot = async (send: TenantSend, gzipped: ReadableStream<Uint8Array<ArrayBuffer>>): Promise<RestoreSummary> => {
    const summary: RestoreSummary = { conflicts: 0, inserted: 0, received: 0, rowErrors: 0, unreachableShards: 0 };
    const encoder = new TextEncoder();
    let batch = "";
    let batchBytes = 0;

    const flush = async (): Promise<void> => {
        if (batch === "") {
            return;
        }

        const response = await send(IMPORT_PATH, batch, "application/x-ndjson");

        batch = "";
        batchBytes = 0;

        if (response.status !== 200 && response.status !== 207) {
            throw new TenantAdminError(`tenant import failed (HTTP ${String(response.status)}): ${await tenantErrorMessage(response)}`, response.status);
        }

        const result = await readJson<ImportResponseBody>(response);

        summary.conflicts += result.conflicts ?? 0;
        summary.inserted += Object.values(result.inserted ?? {}).reduce((sum, count) => sum + count, 0);
        summary.received += result.received ?? 0;
        summary.rowErrors += result.errors?.length ?? 0;
        summary.unreachableShards += result.failed?.length ?? 0;
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
