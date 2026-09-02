/**
 * `lunora export` — stream the worker's NDJSON dump to stdout or a file.
 *
 * Authentication mirrors `vis migrate`: an admin bearer via `--token` or
 * `LUNORA_ADMIN_TOKEN`. `--prod` (with an explicit `--url`) is the guardrail
 * against accidentally targeting localhost in production scripts.
 */
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, unlink } from "node:fs/promises";

import { resolveAdminBearer } from "../../util/admin-token";
import { resolveAdminBaseUrl } from "../../util/admin-url";
import type { Logger } from "../../util/logger";
import type { StreamingFetchLike } from "./shared";
import { EXPORT_ENDPOINT_PATH } from "./shared";

interface ExportCommandOptions {
    cwd?: string;
    fetchImpl?: StreamingFetchLike;
    logger: Logger;
    /** Output file path; `undefined`/`-` streams to stdout. */
    out?: string;
    /** Guardrail: refuse to target localhost when set. */
    prod?: boolean;
    /** Comma-separated table list; omit to export every table. */
    tables?: string;
    /** Admin bearer token (or `LUNORA_ADMIN_TOKEN`). */
    token?: string;
    /** Worker URL (default `http://localhost:8787`). */
    url?: string;
}

interface ExportCommandResult {
    bytes: number;
    code: number;
    /** Number of NDJSON lines streamed (0 on error). */
    rows: number;
}

const resolveTables = (raw: string | undefined): string[] | undefined => {
    if (raw === undefined) {
        return undefined;
    }

    const tables = raw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

    return tables.length > 0 ? tables : undefined;
};

/**
 * Honour backpressure: if the sink can't keep up (slow filesystem, piped
 * stdout consumer), `sink.write` returns false — wait for `drain` before
 * resuming. Otherwise Node buffers writes in the heap and a 10M-row export
 * materialises in memory, defeating the streaming goal.
 *
 * The wait also has to lose to `error`. A sink that fails while we are parked on
 * `drain` — a full disk, `EPIPE` from a closed pipe — emits `error` and never
 * emits `drain`, so waiting on `drain` alone hangs the export forever. Rejecting
 * here is what lets the caller run `discardPartialExport` instead.
 */
const writeWithBackpressure = async (sink: NodeJS.WritableStream, line: string): Promise<void> => {
    if (!sink.write(line)) {
        await new Promise<void>((resolve, reject) => {
            // Seeded before `onDrain` closes over it so the two can unregister
            // each other — whichever event arrives, the other listener goes with
            // it rather than accumulating across every backpressured write.
            let onError = (_error: Error): void => {};

            const onDrain = (): void => {
                sink.removeListener("error", onError);
                resolve();
            };

            onError = (error: Error): void => {
                sink.removeListener("drain", onDrain);
                reject(error);
            };

            sink.once("drain", onDrain);
            sink.once("error", onError);
        });
    }
};

/**
 * Drain the worker's NDJSON response into the sink, counting bytes and rows.
 * Pipes straight through so a 10M-row export never materialises in memory.
 */
const streamNdjsonToSink = async (body: ReadableStream<Uint8Array>, sink: NodeJS.WritableStream): Promise<{ bytes: number; rows: number }> => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let rows = 0;
    let leftover = "";
    let done = false;

    try {
        while (!done) {
            // eslint-disable-next-line no-await-in-loop -- stream chunks must be read sequentially
            const read = await reader.read();

            done = read.done;

            if (read.value === undefined) {
                continue;
            }

            bytes += read.value.length;
            leftover += decoder.decode(read.value, { stream: true });

            let newlineIndex = leftover.indexOf("\n");

            while (newlineIndex !== -1) {
                rows += 1;
                const line = `${leftover.slice(0, newlineIndex)}\n`;

                // eslint-disable-next-line no-await-in-loop -- backpressure is intentionally sequential
                await writeWithBackpressure(sink, line);
                leftover = leftover.slice(newlineIndex + 1);
                newlineIndex = leftover.indexOf("\n");
            }
        }

        if (leftover.length > 0) {
            rows += 1;
            await writeWithBackpressure(sink, `${leftover}\n`);
        }

        return { bytes, rows };
    } finally {
        // Release the body lock even on a thrown write/decode error so the
        // response stream isn't left locked.
        reader.releaseLock();
    }
};

/**
 * Close the write stream and remove the staged file after a mid-stream export
 * failure. No-op for the stdout sink (`stagePath === undefined`).
 */
const discardPartialExport = async (sink: NodeJS.WritableStream, stagePath: string | undefined): Promise<void> => {
    if (stagePath === undefined) {
        return;
    }

    (sink as ReturnType<typeof createWriteStream>).destroy();

    try {
        await unlink(stagePath);
    } catch {
        /* ignore — the staged file may not exist */
    }
};

/**
 * Flush and close the file sink, turning any write failure into a thrown error
 * over a discarded partial file. A failure captured mid-write must not be
 * reported as a clean export.
 */
const closeFileSink = async (sink: NodeJS.WritableStream, stagePath: string, getError: () => Error | undefined): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
        (sink as ReturnType<typeof createWriteStream>).end((error?: Error) => {
            const failure = error ?? getError();

            if (failure === undefined) {
                resolve();
            } else {
                reject(failure);
            }
        });
    });

    const failure = getError();

    if (failure !== undefined) {
        await discardPartialExport(sink, stagePath);

        throw failure;
    }
};

/**
 * Close the staged file and move it onto `--out`.
 *
 * Commit: the bytes are all on disk, so replacing `--out` is atomic. A rejected
 * rename (`--out` is a directory, a cross-device stage, a read-only parent)
 * leaves the COMPLETE plaintext export sitting in the stage file — the
 * disclosure the staging exists to prevent — so discard it before the failure
 * propagates.
 */
const commitStagedExport = async (sink: NodeJS.WritableStream, file: { path: string; stage: string }, getError: () => Error | undefined): Promise<void> => {
    await closeFileSink(sink, file.stage, getError);

    try {
        await rename(file.stage, file.path);
    } catch (error) {
        await discardPartialExport(sink, file.stage);

        throw error;
    }
};

/**
 * Stream an export. The worker emits NDJSON; we count newlines as we go and
 * pipe straight to the output sink, so a 10M-row export doesn't materialise
 * the body in memory.
 */
const runExportCommand = async (options: ExportCommandOptions): Promise<ExportCommandResult> => {
    if (options.prod && options.url === undefined) {
        options.logger.error("--prod requires an explicit --url (refusing to export from the implicit localhost worker)");

        return { bytes: 0, code: 1, rows: 0 };
    }

    // Resolve the target FIRST: the `.dev.vars` fallback is gated on the request's
    // real destination, and with no `--url` that comes from the dev-server record,
    // not from the (undefined) flag.
    const baseUrl = resolveAdminBaseUrl(options.url, options.logger, options.cwd);

    if (baseUrl === undefined) {
        return { bytes: 0, code: 1, rows: 0 };
    }

    const { token } = resolveAdminBearer({ cwd: options.cwd ?? process.cwd(), token: options.token, url: baseUrl });

    if (!token) {
        options.logger.error("admin token required — pass --token, set LUNORA_ADMIN_TOKEN, or add it to .dev.vars (local targets only)");

        return { bytes: 0, code: 1, rows: 0 };
    }

    const requestUrl = `${baseUrl}${EXPORT_ENDPOINT_PATH}`;
    const tables = resolveTables(options.tables);

    const fetchImpl = (options.fetchImpl ?? (globalThis as unknown as { fetch: StreamingFetchLike }).fetch) as StreamingFetchLike | undefined;

    if (typeof fetchImpl !== "function") {
        throw new TypeError("no fetch implementation available — pass fetchImpl or run on Node >= 18");
    }

    options.logger.info(`POST ${requestUrl} -> export${tables ? ` (tables: ${tables.join(",")})` : ""}`);

    const response = await fetchImpl(requestUrl, {
        body: JSON.stringify(tables ? { tables } : {}),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        method: "POST",
    });

    if (!response.ok) {
        const errorText = await response.text();

        options.logger.error(`export failed: HTTP ${String(response.status)}: ${errorText}`);

        return { bytes: 0, code: 1, rows: 0 };
    }

    if (!response.body) {
        options.logger.error("export response carried no body");

        return { bytes: 0, code: 1, rows: 0 };
    }

    // Open the output sink: stdout when `out` is `undefined` / `-`, otherwise
    // a file stream so a 10M-row dump never bloats Node's heap.
    //
    // The file form writes to a sibling `.partial` and renames into place on
    // success — the same stage/commit the backup destinations use. Streaming
    // straight at `--out` truncated whatever was there the moment the request
    // opened, and the mid-stream failure path then unlinked it: refreshing
    // yesterday's dump over itself and losing the connection left neither copy.
    const out = options.out === undefined || options.out === "-" ? undefined : options.out;
    const file = out === undefined ? undefined : { path: out, stage: `${out}.${randomUUID()}.partial` };
    // `mode: 0o600` on the stage: `createWriteStream` defaults to 0o666 before
    // the umask, so under the common `umask 022` the staged file is world-readable
    // for the length of the dump — and a dump is every row of every table. The
    // rename carries the mode onto `--out`, so the committed file is private too.
    const sink = file === undefined ? process.stdout : createWriteStream(file.stage, { encoding: "utf8", mode: 0o600 });

    // A write stream with no `error` listener turns any write failure into an
    // unhandled `error` event, which takes the process down instead of surfacing
    // as a failed export. Hold the first one so the paths below can report it.
    let sinkError: Error | undefined;

    if (file !== undefined) {
        sink.on("error", (error: Error) => {
            sinkError ??= error;
        });
    }

    let bytes: number;
    let rows: number;

    try {
        ({ bytes, rows } = await streamNdjsonToSink(response.body, sink));
    } catch (error) {
        // On a mid-stream failure, close the file descriptor and remove the
        // staged file so we don't leak the fd or leave a truncated dump. `--out`
        // itself was never opened, so any previous dump there survives.
        await discardPartialExport(sink, file?.stage);

        throw error;
    }

    if (file !== undefined) {
        await commitStagedExport(sink, file, () => sinkError);

        options.logger.success(`wrote ${String(rows)} rows to ${file.path} (${String(bytes)} bytes)`);
    }

    return { bytes, code: 0, rows };
};

export type { ExportCommandOptions, ExportCommandResult };
export { runExportCommand };
