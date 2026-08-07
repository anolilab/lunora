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

/** One row-scoped failure as the admin import endpoint reports it. */
interface ImportRowError {
    code: string;
    line: number;
    message: string;
    table: string;
}

/** The admin import endpoint's response body. */
interface AdminImportResponse {
    conflicts?: number;
    errors?: ImportRowError[];
    inserted?: Record<string, number>;
    received?: number;
    warnings?: string[];
}

/** Everything a run accumulated across its batches. */
interface ImportTotals {
    conflicts: number;
    errors: ImportRowError[];
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
    const totals: ImportTotals = { conflicts: 0, errors: [], inserted: {}, received: 0, warnings: [] };
    let batch: string[] = [];
    let batchBytes = 0;

    /** Fold one admin-import response into the run's running totals. */
    const merge = (json: AdminImportResponse): void => {
        for (const [table, count] of Object.entries(json.inserted ?? {})) {
            totals.inserted[table] = (totals.inserted[table] ?? 0) + count;
        }

        totals.errors.push(...(json.errors ?? []));
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
        if (!response.ok) {
            const text = await response.text().catch(() => "<no body>");

            throw new LunoraError("INTERNAL", `import batch failed (HTTP ${String(response.status)}): ${text}`);
        }

        merge((await response.json()) as AdminImportResponse);
    };

    const push = async (row: string): Promise<void> => {
        batch.push(row);
        batchBytes += Buffer.byteLength(row) + 1;

        // Two ceilings, because `--batch-size` counts rows and says nothing about
        // how wide they are: 500 documents of a few KiB each is an ordinary table
        // and a 413 against the endpoint's 1 MiB body cap.
        if (batch.length >= config.batchSize || batchBytes >= config.maxBatchBytes) {
            await flush();
        }
    };

    return { flush, push, totals };
};

export type { AdminImportResponse, ImportBatcher, ImportRowError, ImportTotals };
export { createImportBatcher };
