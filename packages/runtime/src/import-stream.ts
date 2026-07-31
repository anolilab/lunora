/**
 * The NDJSON import pipeline, extracted from `create-worker.ts`. Drains the
 * inbound import body line-by-line under the shared body-size cap, validates and
 * buckets each row into per-shard batches / the global-rows list / a per-row
 * error list, then fans the buckets out to the coordinator (shard-local) and the
 * `importGlobals` callback (global plane). `streamingImport` is the sole public
 * entry; everything else is its internal machinery. The pipeline is parameterised
 * by `WorkerOptions`, so it imports only that type (erased at build) from
 * `create-worker` — no runtime values cross the edge.
 */
import { MAX_BODY_BYTES } from "./body-readers";
import type { ShardingInfo, WorkerOptions } from "./create-worker";
import { LunoraError } from "./errors";
import type { ShardNamespaceLike } from "./resolve-shard";

interface AdminBatch {
    rows: { doc: Record<string, unknown>; table: string }[];
    shardKey: string;
    startLine: number;
}

type ImportRowError = { code: string; line: number; message: string; table: string };

type ParsedImportRow = { error: ImportRowError; ok: false } | { doc: Record<string, unknown>; ok: true; table: string };

/**
 * Validate one NDJSON import line into a `{ table, doc }` row, or an
 * `ImportRowError` describing why the line was rejected. Pure — the caller
 * owns line numbering and accumulation.
 * @returns a discriminated-union result — `{ ok: true, doc, table }` or `{ ok: false, error }`.
 */
const parseImportRow = (trimmed: string, lineNumber: number): ParsedImportRow => {
    let parsed: unknown;

    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return { error: { code: "BAD_ROW", line: lineNumber, message: "line is not valid JSON", table: "" }, ok: false };
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { error: { code: "BAD_ROW", line: lineNumber, message: "row must be a JSON object", table: "" }, ok: false };
    }

    const candidate = parsed as { doc?: unknown; table?: unknown };

    if (typeof candidate.table !== "string" || candidate.table.length === 0) {
        return { error: { code: "BAD_ROW", line: lineNumber, message: "row is missing `table`", table: "" }, ok: false };
    }

    if (!candidate.doc || typeof candidate.doc !== "object" || Array.isArray(candidate.doc)) {
        return { error: { code: "BAD_ROW", line: lineNumber, message: "row is missing or malformed `doc`", table: candidate.table }, ok: false };
    }

    return { doc: candidate.doc as Record<string, unknown>, ok: true, table: candidate.table };
};

type ResolvedImportShardKey = { error: ImportRowError; ok: false } | { ok: true; shardKey: string };

/**
 * Resolve the shard key a shard-local import row routes to. Returns the key, or
 * an `ImportRowError` when a `shardBy` table is missing its shard field.
 * @returns a discriminated-union result — `{ ok: true, shardKey }` or `{ ok: false, error }`.
 */
const resolveImportShardKey = (
    documentRow: Record<string, unknown>,
    table: string,
    info: ShardingInfo | undefined,
    defaultShard: string,
    lineNumber: number,
): ResolvedImportShardKey => {
    if (info?.mode.kind === "shardBy" && typeof info.mode.field === "string") {
        const raw = documentRow[info.mode.field];

        if (raw === undefined || raw === null) {
            return {
                error: { code: "BAD_ROW", line: lineNumber, message: `row missing shard field "${info.mode.field}" for table "${table}"`, table },
                ok: false,
            };
        }

        return { ok: true, shardKey: typeof raw === "string" ? raw : JSON.stringify(raw) };
    }

    return { ok: true, shardKey: defaultShard };
};

interface BucketedImport {
    errors: ImportRowError[];
    globalRows: { doc: Record<string, unknown>; line: number; table: string }[];
    perShard: Map<string, AdminBatch>;

    /**
     * Non-blank NDJSON lines read from the body — the denominator a caller
     * compares the inserted total against.
     *
     * Counted HERE, as each line is consumed, rather than reconstructed
     * afterwards from the three buckets: `errors` is handed to the caller by
     * reference and appended to during fan-out, so a post-hoc sum counts every
     * failed row twice — once in its bucket and again as an error.
     */
    received: number;
}

/**
 * Drain the inbound NDJSON body line-by-line (enforcing the byte budget as
 * bytes arrive), validating + bucketing each row into the per-shard batches,
 * the global-rows list, or the per-row error list. Pure routing — the caller
 * fans the buckets out to their storage planes.
 */
const bucketImportStream = async (request: Request, options: WorkerOptions, defaultShard: string): Promise<BucketedImport> => {
    if (!request.body) {
        throw new LunoraError("Import endpoint requires a request body", { code: "BAD_REQUEST", status: 400 });
    }

    const errors: ImportRowError[] = [];
    // Each global row carries its true physical source line so error attribution
    // survives interspersed shard rows / blank lines — a single `startLine` can
    // only describe rows physically contiguous from the first one.
    const globalRows: { doc: Record<string, unknown>; line: number; table: string }[] = [];
    const perShard = new Map<string, AdminBatch>();
    let received = 0;
    // Physical 1-based source line index. Incremented for EVERY line handled,
    // including blank ones, so `error.line` / `startLine` always point at the
    // user's actual source line. Counting only non-blank lines (the old bug)
    // mis-attributed errors whenever the NDJSON had a leading/interior blank line.
    let physicalLine = 0;

    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // Enforce the body-size cap as bytes arrive — `Content-Length` is forgeable
    // and an NDJSON import is exactly the streaming/chunked shape that bypasses
    // the header fast-path. Abort with 413 once cumulative bytes exceed the cap.
    let totalBytes = 0;

    const handleLine = (line: string): void => {
        // Advance the physical line counter first so blank lines still consume a
        // line number — keeps `error.line` aligned with the source file.
        physicalLine += 1;

        const trimmed = line.trim();

        if (trimmed.length === 0) {
            return;
        }

        received += 1;

        const row = parseImportRow(trimmed, physicalLine);

        if (!row.ok) {
            errors.push(row.error);

            return;
        }

        const { doc: documentRow, table } = row;
        const info = options.resolveTableSharding?.(table);

        if (info?.mode.kind === "global") {
            globalRows.push({ doc: documentRow, line: physicalLine, table });

            return;
        }

        // Shard-local routing: shardBy(field) picks the value of `doc[field]`;
        // root/undefined modes route to the default shard.
        const resolved = resolveImportShardKey(documentRow, table, info, defaultShard, physicalLine);

        if (!resolved.ok) {
            errors.push(resolved.error);

            return;
        }

        const existing = perShard.get(resolved.shardKey);

        if (existing) {
            existing.rows.push({ doc: documentRow, table });
        } else {
            perShard.set(resolved.shardKey, { rows: [{ doc: documentRow, table }], shardKey: resolved.shardKey, startLine: physicalLine });
        }
    };

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- drain the NDJSON body stream until the reader signals `done`
    while (true) {
        // eslint-disable-next-line no-await-in-loop -- stream reads are inherently sequential; each chunk depends on the prior read
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a stream read can yield `done: false` with an undefined `value`; guard before reading byteLength
        if (value) {
            totalBytes += value.byteLength;

            if (totalBytes > MAX_BODY_BYTES) {
                // eslint-disable-next-line no-await-in-loop -- one-shot cleanup on the over-budget abort path before throwing
                await reader.cancel().catch(() => {});

                throw new LunoraError("Body too large", { code: "PAYLOAD_TOO_LARGE", status: 413 });
            }
        }

        buffer += decoder.decode(value, { stream: true });

        let newlineIndex = buffer.indexOf("\n");

        while (newlineIndex !== -1) {
            const line = buffer.slice(0, newlineIndex);

            buffer = buffer.slice(newlineIndex + 1);
            handleLine(line);
            newlineIndex = buffer.indexOf("\n");
        }
    }

    if (buffer.length > 0) {
        handleLine(buffer);
    }

    return { errors, globalRows, perShard, received };
};

interface ImportTotals {
    conflicts: number;
    errors: ImportRowError[];
    inserted: Record<string, number>;
}

/**
 * Fold a per-plane insert result (`{ inserted, errors, conflicts }`) into the
 * running totals, mutating them in place. `totals` is an accumulator the caller
 * owns — by design it threads one mutable record through both storage planes.
 */
const mergeImportResult = (
    totals: ImportTotals,
    result: { conflicts: number; errors: ReadonlyArray<ImportRowError>; inserted: Record<string, number> },
): void => {
    for (const [table, count] of Object.entries(result.inserted)) {
        // eslint-disable-next-line no-param-reassign -- `totals` is the caller-owned accumulator threaded through both import planes
        totals.inserted[table] = (totals.inserted[table] ?? 0) + count;
    }

    for (const rowError of result.errors) {
        totals.errors.push({ ...rowError });
    }

    // eslint-disable-next-line no-param-reassign -- `totals` is the caller-owned accumulator threaded through both import planes
    totals.conflicts += result.conflicts;
};

/**
 * Stream the inbound NDJSON body, bucket rows per shard, and forward them to
 * the coordinator's import fan-out. Globals are siphoned off and handed to the
 * `importGlobals` callback (if present) so the two storage planes can run in
 * parallel.
 */
const streamingImport = async (
    request: Request,
    options: WorkerOptions,
    forwardedHeaders: Record<string, string>,
    namespace: ShardNamespaceLike,
): Promise<{
    conflicts: number;
    errors: ImportRowError[];
    inserted: Record<string, number>;
    received: number;
    warnings?: string[];
}> => {
    const defaultShard = options.defaultShardKey ?? "__root__";

    const { errors, globalRows, perShard, received } = await bucketImportStream(request, options, defaultShard);

    const totals: ImportTotals = { conflicts: 0, errors, inserted: {} };
    const warnings: string[] = [];

    // A worker with no `resolveTableSharding` cannot tell a `.global()` table
    // from a shard-local one, so every row routes to the default shard. That is
    // the right default for a single-shard app and silent misplacement for a
    // sharded one — and it also suppresses the `GLOBAL_NOT_CONFIGURED` error
    // below, because no row is ever classified global. Two missing options
    // cancelling out each other's diagnostics is why this read as a 200 with
    // nothing written and nothing wrong.
    if (options.resolveTableSharding === undefined && perShard.size > 0) {
        warnings.push(
            "no `resolveTableSharding` is configured, so every row was routed to the default shard and no row could be recognised as `.global()` — " +
                "correct for a single-shard app, silent misplacement for a sharded one",
        );
    }

    // Fan shard-local batches out via the coordinator. The order of batches
    // is insertion order so error line numbers reflect the source NDJSON.
    if (perShard.size > 0) {
        const coordinator = options.queryCoordinator;

        if (!coordinator) {
            throw new LunoraError("Import endpoint requires a `queryCoordinator` on the worker", { code: "BAD_REQUEST", status: 400 });
        }

        // `namespace` is the worker's jurisdiction-pinned shard binding (create-worker
        // pins it once). Fanning out through it keeps import writing to the SAME DOs
        // the app reads — using the raw `options.shardDO` would land rows in the
        // un-pinned global DOs, outside the residency boundary and unreachable by
        // the live worker (a fail-open leak).
        const result = await coordinator.orchestrateImport(namespace, {
            batches: [...perShard.values()],
            headers: forwardedHeaders,
        });

        mergeImportResult(totals, result);
    }

    // Run global imports through the user-supplied helper.
    if (globalRows.length > 0) {
        if (options.importGlobals) {
            // Pass each row's true physical `line` (carried on the row) so error
            // attribution is correct even when global rows are interspersed with
            // shard rows or blank lines. `startLine` is the first global row's
            // line, retained only as a backward-compat fallback.
            const startLine = globalRows[0]?.line ?? 1;
            const result = await options.importGlobals({ rows: globalRows, startLine });

            mergeImportResult(totals, result);
        } else {
            for (const globalRow of globalRows) {
                totals.errors.push({
                    code: "GLOBAL_NOT_CONFIGURED",
                    line: globalRow.line,
                    message: `row targets global table "${globalRow.table}" but no \`importGlobals\` is configured`,
                    table: globalRow.table,
                });
            }
        }
    }

    // `received` is the honest denominator, counted as each line was read (see
    // `BucketedImport.received`). Without it the response asserted success by
    // omission: `errors: []` and `conflicts: 0` together read as "nothing went
    // wrong", and an empty `inserted` map is also exactly what a legitimately
    // empty batch returns — so a bulk import that was structurally unable to
    // write was indistinguishable from one that had nothing to do, and a
    // migration script could report "imported 4.2M rows" against an empty
    // database. A caller compares `received` against the inserted total.
    return {
        conflicts: totals.conflicts,
        errors: totals.errors,
        inserted: totals.inserted,
        received,
        ...(warnings.length > 0 ? { warnings } : {}),
    };
};

export type { ImportRowError };
export { streamingImport };
