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
    /** Replace mode only: rows removed per table because the import did not carry them. */
    deleted?: Record<string, number>;
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
    /** Rows a replace removed, per table — `undefined` for an append run. */
    deleted: Record<string, number> | undefined;
    errors: ImportRowError[];
    /** Shards no batch could reach. Non-empty means rows are missing, not merely rejected. */
    failed: ImportShardFailure[];
    inserted: Record<string, number>;
    received: number;
    warnings: string[];
}

/**
 * A replace run's staged session (`packages/runtime/src/import-session.ts`):
 * every POST stages into it (`?mode=replace…&stage=<session>`), and `finish`
 * commits the whole file in one swap — or aborts, leaving the data untouched.
 */
interface ImportStagedReplace {
    /** `…/import/abort`. */
    abortUrl: string;
    /** `…/import/commit`. */
    commitUrl: string;
    session: string;
    /** `…/import?mode=replace[&tables=…]&stage=<session>`. */
    stageUrl: string;
}

interface ImportBatcherConfig {
    /** Row ceiling per POST. */
    batchSize: number;
    fetchImpl: StreamingFetchLike;
    /** Byte ceiling per POST, so wide rows do not exceed the endpoint's body cap. */
    maxBatchBytes: number;
    /** Replace mode: stage every batch into one session, then commit it. The first POST goes out even with no rows, since an empty replace empties the tables. */
    replace?: ImportStagedReplace;
    requestUrl: string;
    token: string;
}

interface ImportBatcher {
    /** Replace mode: drop the staged session, best effort — the data was never touched. */
    abort: () => Promise<void>;

    /**
     * Replace mode: commit the staged session (or abort it when a batch reported
     * a refused row or an unreachable shard). Throws when the commit cannot
     * finish. A no-op for an append run.
     */
    finish: () => Promise<void>;
    /** POST whatever is queued. A no-op when the batch is empty. */
    flush: () => Promise<void>;
    /** Queue one wire row, POSTing first if it would overflow either ceiling. */
    push: (row: string) => Promise<void>;
    /** Replace mode: refuse a worker without staged import before anything is sent. */
    start: () => Promise<void>;
    totals: ImportTotals;
}

/** Commit attempts before a replace gives up on a session whose commit began. */
const COMMIT_ATTEMPTS = 3;

/** 409 codes that mean "send the commit again" rather than "refused". */
const RETRY_CODES: ReadonlySet<string> = new Set(["IMPORT_SESSION_CHANGED", "IMPORT_SESSION_COMMITTING"]);

const createImportBatcher = (config: ImportBatcherConfig): ImportBatcher => {
    const totals: ImportTotals = {
        conflicts: 0,
        deleted: config.replace === undefined ? undefined : {},
        errors: [],
        failed: [],
        inserted: {},
        received: 0,
        warnings: [],
    };
    let batch: string[] = [];
    let batchBytes = 0;
    let requests = 0;

    /** Fold one admin-import response into the run's running totals. */
    const merge = (json: AdminImportResponse): void => {
        for (const [table, count] of Object.entries(json.inserted ?? {})) {
            totals.inserted[table] = (totals.inserted[table] ?? 0) + count;
        }

        if (totals.deleted !== undefined) {
            for (const [table, count] of Object.entries(json.deleted ?? {})) {
                totals.deleted[table] = (totals.deleted[table] ?? 0) + count;
            }
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

    const post = async (url: string, body: string, contentType: string) =>
        config.fetchImpl(url, { body, headers: { authorization: `Bearer ${config.token}`, "content-type": contentType }, method: "POST" });

    const flush = async (): Promise<void> => {
        // The first staged POST goes out even when empty: it opens the session.
        if (batch.length === 0 && (config.replace === undefined || requests > 0)) {
            return;
        }

        const body = batch.join("\n");

        batch = [];
        batchBytes = 0;
        requests += 1;

        const response = await config.fetchImpl(config.replace?.stageUrl ?? config.requestUrl, {
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

    const start = async (): Promise<void> => {
        if (config.replace === undefined) {
            return;
        }

        // A worker without staged import has no abort route — and one that predates
        // it would read each staged batch as a replace of its own.
        const response = await post(config.replace.abortUrl, JSON.stringify({ session: config.replace.session }), "application/json");

        if (!response.ok) {
            throw new LunoraError("INTERNAL", `the worker predates staged replace import (HTTP ${String(response.status)}) — redeploy it and re-run`);
        }
    };

    const abort = async (): Promise<void> => {
        if (config.replace !== undefined) {
            await post(config.replace.abortUrl, JSON.stringify({ session: config.replace.session }), "application/json").catch(() => undefined);
        }
    };

    /** One commit attempt: `true` once committed, a reason to send it again, or a thrown refusal (aborted first). */
    const attemptCommit = async (replace: ImportStagedReplace): Promise<string | true> => {
        const response = await post(replace.commitUrl, JSON.stringify({ session: replace.session }), "application/json");

        if (response.ok) {
            const json = (await response.json()) as AdminImportResponse;

            merge({ deleted: json.deleted, inserted: json.inserted, warnings: json.warnings });

            return true;
        }

        const json = (await response.json().catch(() => {
            return {};
        })) as AdminImportResponse & { error?: { code?: string; message?: string } };

        if (response.status === 409 && !RETRY_CODES.has(json.error?.code ?? "")) {
            await abort();
            totals.errors.push(...(json.errors ?? []));
            totals.failed.push(...(json.failed ?? []));

            throw new LunoraError(
                "INTERNAL",
                `the replace was refused before anything was written: ${json.error?.message ?? "its dry run found rows that would not land"}`,
            );
        }

        return `HTTP ${String(response.status)}`;
    };

    const finish = async (): Promise<void> => {
        const { replace } = config;

        if (replace === undefined) {
            return;
        }

        // A staged batch that refused a row or missed a shard: the session can never commit.
        if (totals.errors.length > 0 || totals.failed.length > 0) {
            await abort();

            return;
        }

        let lastFailure = "";

        for (let attempt = 1; attempt <= COMMIT_ATTEMPTS; attempt += 1) {
            // eslint-disable-next-line no-await-in-loop -- retries are sequential by design
            const outcome = await attemptCommit(replace);

            if (outcome === true) {
                return;
            }

            lastFailure = outcome;
        }

        throw new LunoraError(
            "INTERNAL",
            `the replace's commit did not finish after ${String(COMMIT_ATTEMPTS)} attempts (${lastFailure}); some tables may already hold the file — re-run the import`,
        );
    };

    return { abort, finish, flush, push, start, totals };
};

export type { ImportBatcher, ImportRowError, ImportShardFailure, ImportStagedReplace, ImportTotals };
export { createImportBatcher };
