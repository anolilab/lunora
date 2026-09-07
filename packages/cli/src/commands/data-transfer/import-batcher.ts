/**
 * The batching half of `lunora import`: accumulate wire rows, POST them to
 * `/_lunora/admin/import` when either ceiling is reached, and fold each
 * response into the run's totals.
 *
 * Kept apart from the command because it is the one piece with real state — six
 * accumulators and two ceilings — and it needs none of the command's flags,
 * only where to POST and how big a batch may get.
 */
import { LunoraError } from "@lunora/errors";

import type { StreamingFetchLike } from "./shared";

/**
 * The status the admin import endpoint answers when at least one shard could not
 * be reached. `Response.ok` is TRUE for 207, so it must be tested explicitly —
 * an `ok` gate alone reports a partial import as a success.
 */
const PARTIAL_IMPORT_STATUS = 207;

/** One row-scoped failure as the admin import endpoint reports it. */
interface ImportRowError {
    code: string;
    line: number;
    message: string;
    table: string;
}

/**
 * One SHARD the fan-out never reached, as the admin import endpoint reports it.
 *
 * Distinct from {@link ImportRowError}: the rows a dead shard owned contribute
 * to neither `inserted` nor `errors`, so an unknown slice of the batch is simply
 * missing. The endpoint answers 207 Multi-Status when this array is non-empty.
 */
interface ImportShardFailure {
    message: string;
    shardKey: string;
    timedOut: boolean;
}

/** The admin import endpoint's response body. */
interface AdminImportResponse {
    conflicts?: number;
    errors?: ImportRowError[];
    /** Shards the fan-out never reached — non-empty means the endpoint answered 207. */
    failed?: ImportShardFailure[];
    inserted?: Record<string, number>;
    received?: number;
    warnings?: string[];
}

/** Everything a run accumulated across its batches. */
interface ImportTotals {
    conflicts: number;
    errors: ImportRowError[];
    /** Shards no batch could reach. Non-empty means rows are missing, not merely rejected. */
    failed: ImportShardFailure[];
    inserted: Record<string, number>;
    received: number;
    warnings: string[];
}

interface ImportBatcherConfig {
    /** Row ceiling per POST. */
    batchSize: number;
    fetchImpl: StreamingFetchLike;
    /** Byte ceiling per POST, so wide rows do not exceed the endpoint's body cap. */
    maxBatchBytes: number;
    requestUrl: string;
    token: string;
}

interface ImportBatcher {
    /** POST whatever is queued. A no-op when the batch is empty. */
    flush: () => Promise<void>;
    /** Queue one wire row, POSTing first if it would overflow either ceiling. */
    push: (row: string) => Promise<void>;
    totals: ImportTotals;
}

const createImportBatcher = (config: ImportBatcherConfig): ImportBatcher => {
    const totals: ImportTotals = { conflicts: 0, errors: [], failed: [], inserted: {}, received: 0, warnings: [] };
    let batch: string[] = [];
    let batchBytes = 0;

    /** Fold one admin-import response into the run's running totals. */
    const merge = (json: AdminImportResponse): void => {
        for (const [table, count] of Object.entries(json.inserted ?? {})) {
            totals.inserted[table] = (totals.inserted[table] ?? 0) + count;
        }

        totals.errors.push(...(json.errors ?? []));
        totals.failed.push(...(json.failed ?? []));
        totals.conflicts += json.conflicts ?? 0;
        totals.received += json.received ?? 0;

        // The endpoint's own diagnostics — e.g. "no `resolveTableSharding` is
        // configured, so every row was routed to the default shard". Dropping
        // these would leave the operator with a success line over a silently
        // misplaced import, which is the failure they report.
        for (const warning of json.warnings ?? []) {
            if (!totals.warnings.includes(warning)) {
                totals.warnings.push(warning);
            }
        }
    };

    const flush = async (): Promise<void> => {
        if (batch.length === 0) {
            return;
        }

        const body = batch.join("\n");

        batch = [];
        batchBytes = 0;

        const response = await config.fetchImpl(config.requestUrl, {
            body,
            headers: { authorization: `Bearer ${config.token}`, "content-type": "application/x-ndjson" },
            method: "POST",
        });

        // Surface non-2xx as a hard failure — without this the command exited 0
        // with `inserted` unchanged when the server rejected a batch (auth
        // failure, 5xx, malformed bearer), silently dropping rows.
        // `response.json()` could also throw on a non-JSON error body.
        //
        // 207 Multi-Status is checked SEPARATELY and before anything reads
        // `response.ok`, because `ok` is TRUE for 207: a partial import — some
        // shard the fan-out never reached, its rows in neither `inserted` nor
        // `errors` — otherwise reported as a clean success at the CLI, which is
        // exactly the silent-success class this endpoint's 207 exists to remove.
        if (!response.ok && response.status !== PARTIAL_IMPORT_STATUS) {
            const text = await response.text().catch(() => "<no body>");

            throw new LunoraError("INTERNAL", `import batch failed (HTTP ${String(response.status)}): ${text}`);
        }

        const json = (await response.json()) as AdminImportResponse;

        merge(json);

        // A 207 whose body carries no `failed[]` is a contract violation, not a
        // clean batch: record it rather than letting the run report success.
        if (response.status === PARTIAL_IMPORT_STATUS && (json.failed ?? []).length === 0) {
            totals.failed.push({
                message: `the endpoint answered ${String(PARTIAL_IMPORT_STATUS)} without naming the failed shards`,
                shardKey: "<unknown>",
                timedOut: false,
            });
        }
    };

    const push = async (row: string): Promise<void> => {
        const rowBytes = Buffer.byteLength(row) + 1;

        // Two ceilings, because `--batch-size` counts rows and says nothing about
        // how wide they are: 500 documents of a few KiB each is an ordinary table
        // and a 413 against the endpoint's 1 MiB body cap.
        //
        // The byte ceiling has to be checked BEFORE the row joins the batch.
        // Appending first and flushing after would send a body already one row
        // past the limit — which is the 413 this ceiling exists to prevent.
        if (batch.length > 0 && batchBytes + rowBytes > config.maxBatchBytes) {
            await flush();
        }

        batch.push(row);
        batchBytes += rowBytes;

        // The row ceiling is exact, so it flushes on arrival. A single row wider
        // than the whole byte budget still goes on its own — nothing can split
        // one document, and sending it alone is its best chance.
        if (batch.length >= config.batchSize) {
            await flush();
        }
    };

    return { flush, push, totals };
};

export type { AdminImportResponse, ImportBatcher, ImportRowError, ImportShardFailure, ImportTotals };
export { createImportBatcher, PARTIAL_IMPORT_STATUS };
