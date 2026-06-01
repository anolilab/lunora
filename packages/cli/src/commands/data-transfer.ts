/**
 * `cirrus export` / `cirrus import` — Convex-style bulk data transfer.
 *
 * `export` streams NDJSON from the worker's `POST /_cirrus/admin/export`
 * endpoint to stdout (or `--out` file). `import` reads an NDJSON file and
 * POSTs batches to `POST /_cirrus/admin/import`, surfacing inserted/error
 * counts to the user.
 *
 * Authentication mirrors `vis migrate`: an admin bearer via `--token` or
 * `CIRRUS_ADMIN_TOKEN`. `--prod` (with an explicit `--url`) is the guardrail
 * against accidentally targeting localhost in production scripts.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";

import { resolveAdminBaseUrl } from "../util/admin-url.js";
import type { Logger } from "../util/logger.js";
import type { FetchLike } from "./run.js";

const EXPORT_ENDPOINT_PATH = "/_cirrus/admin/export";
const IMPORT_ENDPOINT_PATH = "/_cirrus/admin/import";

/** Rows per HTTP request when importing. Convex uses ~500; same here. */
export const DEFAULT_IMPORT_BATCH_SIZE = 500;

/**
 * Minimal projection of `globalThis.fetch` for the export path — we need
 * `body` as a stream-iterable, which the shared {@link FetchLike} type
 * intentionally hides for the JSON-only commands.
 */
export type StreamingFetchLike = (
    input: string,
    init?: { body?: string; headers?: Record<string, string>; method?: string },
) => Promise<{
    body: ReadableStream<Uint8Array> | null;
    json: () => Promise<unknown>;
    ok: boolean;
    status: number;
    text: () => Promise<string>;
}>;

export interface ExportCommandOptions {
    cwd?: string;
    fetchImpl?: StreamingFetchLike;
    logger: Logger;
    /** Output file path; `undefined`/`-` streams to stdout. */
    out?: string;
    /** Guardrail: refuse to target localhost when set. */
    prod?: boolean;
    /** Comma-separated table list; omit to export every table. */
    tables?: string;
    /** Admin bearer token (or `CIRRUS_ADMIN_TOKEN`). */
    token?: string;
    /** Worker URL (default `http://localhost:8787`). */
    url?: string;
}

export interface ExportCommandResult {
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
 * Stream an export. The worker emits NDJSON; we count newlines as we go and
 * pipe straight to the output sink, so a 10M-row export doesn't materialise
 * the body in memory.
 */
export const runExportCommand = async (options: ExportCommandOptions): Promise<ExportCommandResult> => {
    if (options.prod && options.url === undefined) {
        options.logger.error("--prod requires an explicit --url (refusing to export from the implicit localhost worker)");

        return { bytes: 0, code: 1, rows: 0 };
    }

    const token = options.token ?? process.env["CIRRUS_ADMIN_TOKEN"];

    if (!token) {
        options.logger.error("admin token required — pass --token or set CIRRUS_ADMIN_TOKEN");

        return { bytes: 0, code: 1, rows: 0 };
    }

    const baseUrl = resolveAdminBaseUrl(options.url, options.logger);

    if (baseUrl === null) {
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
    const outPath = options.out === undefined || options.out === "-" ? undefined : options.out;
    const sink = outPath === undefined ? process.stdout : createWriteStream(outPath, { encoding: "utf8" });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let rows = 0;
    let leftover = "";

    // Honour backpressure: if the sink can't keep up (slow filesystem, piped
    // stdout consumer), `sink.write` returns false — wait for `drain` before
    // resuming. Otherwise Node buffers writes in the heap and a 10M-row
    // export materialises in memory, defeating the streaming goal.
    const writeWithBackpressure = async (line: string): Promise<void> => {
        if (!sink.write(line)) {
            await new Promise<void>((resolve) => {
                sink.once("drain", resolve);
            });
        }
    };

    while (true) {
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        const chunk = decoder.decode(value, { stream: true });

        bytes += value.length;
        leftover += chunk;

        let newlineIndex = leftover.indexOf("\n");

        while (newlineIndex !== -1) {
            rows += 1;
            const line = `${leftover.slice(0, newlineIndex)}\n`;

            // eslint-disable-next-line no-await-in-loop -- backpressure is intentionally sequential
            await writeWithBackpressure(line);
            leftover = leftover.slice(newlineIndex + 1);
            newlineIndex = leftover.indexOf("\n");
        }
    }

    if (leftover.length > 0) {
        rows += 1;
        await writeWithBackpressure(`${leftover}\n`);
    }

    if (outPath !== undefined) {
        await new Promise<void>((resolve, reject) => {
            (sink as ReturnType<typeof createWriteStream>).end((error?: Error) => {
                error ? reject(error) : resolve();
            });
        });

        options.logger.success(`wrote ${String(rows)} rows to ${outPath} (${String(bytes)} bytes)`);
    }

    return { bytes, code: 0, rows };
};

export interface ImportCommandOptions {
    /** Rows per HTTP request. Defaults to {@link DEFAULT_IMPORT_BATCH_SIZE}. */
    batchSize?: number;
    cwd?: string;
    fetchImpl?: StreamingFetchLike;
    /** Source NDJSON file. Required. */
    file: string;
    logger: Logger;
    prod?: boolean;

    /**
     * Wrap each line as `{table:&lt;name>,doc:&lt;line>}`. Use when the source NDJSON
     * is bare docs from a single table — Convex's `convex import --table users`
     * shape.
     */
    table?: string;
    token?: string;
    url?: string;
}

export interface ImportCommandResult {
    body: unknown;
    code: number;
    /** Total inserted rows across batches. */
    inserted: number;
}

/**
 * Stream an NDJSON file in chunks, POSTing each batch to
 * `/_cirrus/admin/import`. We keep the line buffer bounded by `batchSize` so a
 * multi-GiB file imports without buffering everything in memory.
 */
export const runImportCommand = async (options: ImportCommandOptions): Promise<ImportCommandResult> => {
    if (options.prod && options.url === undefined) {
        options.logger.error("--prod requires an explicit --url (refusing to import to the implicit localhost worker)");

        return { body: undefined, code: 1, inserted: 0 };
    }

    const token = options.token ?? process.env["CIRRUS_ADMIN_TOKEN"];

    if (!token) {
        options.logger.error("admin token required — pass --token or set CIRRUS_ADMIN_TOKEN");

        return { body: undefined, code: 1, inserted: 0 };
    }

    try {
        const stats = await stat(options.file);

        if (!stats.isFile()) {
            options.logger.error(`not a file: ${options.file}`);

            return { body: undefined, code: 1, inserted: 0 };
        }
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        options.logger.error(`failed to stat ${options.file}: ${message}`);

        return { body: undefined, code: 1, inserted: 0 };
    }

    const baseUrl = resolveAdminBaseUrl(options.url, options.logger);

    if (baseUrl === null) {
        return { body: undefined, code: 1, inserted: 0 };
    }

    const requestUrl = `${baseUrl}${IMPORT_ENDPOINT_PATH}`;
    const batchSize = options.batchSize ?? DEFAULT_IMPORT_BATCH_SIZE;

    const fetchImpl = (options.fetchImpl ?? (globalThis as unknown as { fetch: StreamingFetchLike }).fetch) as StreamingFetchLike | undefined;

    if (typeof fetchImpl !== "function") {
        throw new TypeError("no fetch implementation available — pass fetchImpl or run on Node >= 18");
    }

    options.logger.info(`POST ${requestUrl} -> import ${options.file}`);

    // Read the file as text and split into lines, then chunk + POST. For very
    // large files we could swap this for createReadStream + line streaming —
    // batching makes the in-memory cost bounded per request either way.
    const stream = createReadStream(options.file, { encoding: "utf8" });
    const inserted: Record<string, number> = {};
    const errors: { code: string; line: number; message: string; table: string }[] = [];
    let conflicts = 0;
    let buffer = "";
    let batch: string[] = [];
    let lineNumber = 0;

    const flush = async (): Promise<void> => {
        if (batch.length === 0) {
            return;
        }

        const body = batch.join("\n");

        batch = [];

        const response = await fetchImpl(requestUrl, {
            body,
            headers: { authorization: `Bearer ${token}`, "content-type": "application/x-ndjson" },
            method: "POST",
        });

        // Surface non-2xx as a hard failure — without this the command
        // exited 0 with `inserted` unchanged when the server rejected a
        // batch (auth failure, 5xx, malformed bearer), silently dropping
        // rows. response.json() could also throw on a non-JSON error body.
        if (!response.ok) {
            const text = await response.text().catch(() => "<no body>");

            throw new Error(`import batch failed (HTTP ${String(response.status)}): ${text}`);
        }

        const json = (await response.json()) as {
            conflicts?: number;
            errors?: { code: string; line: number; message: string; table: string }[];
            inserted?: Record<string, number>;
        };

        if (json.inserted) {
            for (const [table, count] of Object.entries(json.inserted)) {
                inserted[table] = (inserted[table] ?? 0) + count;
            }
        }

        if (Array.isArray(json.errors)) {
            errors.push(...json.errors);
        }

        if (typeof json.conflicts === "number") {
            conflicts += json.conflicts;
        }
    };

    const processLine = (line: string): void => {
        const trimmed = line.trim();

        if (trimmed.length === 0) {
            return;
        }

        lineNumber += 1;

        if (options.table === undefined) {
            batch.push(trimmed);

            return;
        }

        // `--table` wraps each bare doc — the source is `{...}\n{...}\n`,
        // not `{table,doc}` envelopes. Guard the parse so a malformed line
        // surfaces a row-scoped error instead of an unhandled rejection.
        let document_: unknown;

        try {
            document_ = JSON.parse(trimmed);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);

            throw new Error(`invalid JSON on line ${String(lineNumber)}: ${message}`, { cause: error });
        }

        batch.push(JSON.stringify({ doc: document_, table: options.table }));
    };

    // `for await ... of` natively awaits each chunk + propagates errors
    // through the surrounding async function, so a thrown `processLine`/
    // `flush` rejects the outer promise instead of becoming an unhandled
    // rejection. Backpressure falls out of `await` — the loop only requests
    // the next chunk when the current one is drained.
    for await (const chunk of stream) {
        const text = typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");

        buffer += text;

        let newlineIndex = buffer.indexOf("\n");

        while (newlineIndex !== -1) {
            processLine(buffer.slice(0, newlineIndex));
            buffer = buffer.slice(newlineIndex + 1);
            newlineIndex = buffer.indexOf("\n");

            if (batch.length >= batchSize) {
                // eslint-disable-next-line no-await-in-loop -- one POST per filled batch is the point
                await flush();
            }
        }
    }

    if (buffer.length > 0) {
        processLine(buffer);
    }

    await flush();

    const insertedTotal = Object.values(inserted).reduce((a, b) => a + b, 0);
    const body = { conflicts, errors, inserted };

    options.logger.info(JSON.stringify(body, undefined, 2));
    options.logger.success(`imported ${String(insertedTotal)} rows (${String(conflicts)} conflicts, ${String(errors.length)} errors)`);

    return { body, code: errors.length > 0 ? 1 : 0, inserted: insertedTotal };
};
