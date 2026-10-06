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
import type { SectionRow } from "./export-sections";
import { assertSupportedHeader, HEADER_TABLE, importSectionRows, isSectionTable } from "./export-sections";
import type { QueryCoordinator } from "./query-coordinator";
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

    /**
     * Section lines (`$lunora` / `$auth` / `$kv` / `$storage`, see
     * `./export-sections`), in file order.
     */
    sectionRows: SectionRow[];
}

/**
 * Drain the inbound NDJSON body line-by-line (enforcing the byte budget as
 * bytes arrive), validating + bucketing each row into the per-shard batches,
 * the global-rows list, or the per-row error list. Pure routing — the caller
 * fans the buckets out to their storage planes.
 */
const bucketImportStream = async (
    request: Request,
    options: WorkerOptions,
    defaultShard: string,
    replaceScope: ReadonlySet<string> | undefined,
): Promise<BucketedImport> => {
    // An empty replace is meaningful — it empties every table in scope.
    if (!request.body && replaceScope === undefined) {
        throw new LunoraError("Import endpoint requires a request body", { code: "BAD_REQUEST", status: 400 });
    }

    const errors: ImportRowError[] = [];
    // Each global row carries its true physical source line so error attribution
    // survives interspersed shard rows / blank lines — a single `startLine` can
    // only describe rows physically contiguous from the first one.
    const globalRows: { doc: Record<string, unknown>; line: number; table: string }[] = [];
    const perShard = new Map<string, AdminBatch>();
    const sectionRows: SectionRow[] = [];
    let received = 0;
    // Physical 1-based source line index. Incremented for EVERY line handled,
    // including blank ones, so `error.line` / `startLine` always point at the
    // user's actual source line. Counting only non-blank lines (the old bug)
    // mis-attributed errors whenever the NDJSON had a leading/interior blank line.
    let physicalLine = 0;

    if (!request.body) {
        return { errors, globalRows, perShard, received, sectionRows };
    }

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

        if (isSectionTable(table)) {
            // A header from a newer format is refused here, before anything is written.
            if (table === HEADER_TABLE) {
                assertSupportedHeader(documentRow);
            }

            sectionRows.push({ doc: documentRow, line: physicalLine, table });

            return;
        }

        if (replaceScope !== undefined && !replaceScope.has(table)) {
            errors.push({ code: "BAD_ROW", line: physicalLine, message: `table "${table}" is not in this replace import's tables`, table });

            return;
        }

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

    return { errors, globalRows, perShard, received, sectionRows };
};

/**
 * A shard the import fan-out could not write to at all (timed out, or the shard
 * RPC errored). Distinct from an {@link ImportRowError}: no line of the source
 * NDJSON is at fault, and an unknown number of that shard's rows are simply not
 * in the database.
 */
interface ImportShardFailure {
    message: string;
    shardKey: string;
    timedOut: boolean;
}

interface ImportTotals {
    conflicts: number;
    deleted: Record<string, number>;
    errors: ImportRowError[];
    failed: ImportShardFailure[];
    inserted: Record<string, number>;
}

/**
 * The shards that did not complete, as reported by `rollUpImport`.
 *
 * A dead shard is recorded ONLY in `failed` / `shards[].error` — it contributes
 * nothing to `errors`, `inserted` or `conflicts`, which is exactly why folding
 * only those three made a 3-shard import that lost one shard to
 * `perShardTimeoutMs` answer `200 { errors: [], conflicts: 0 }` with a third of
 * the dataset missing: structurally indistinguishable from a clean run.
 */
const shardFailures = (shards: ReadonlyArray<{ error?: { message: string; timedOut: boolean }; shardKey: string }>): ImportShardFailure[] =>
    shards.flatMap((shard) => (shard.error ? [{ message: shard.error.message, shardKey: shard.shardKey, timedOut: shard.error.timedOut }] : []));

/**
 * Fold a per-plane insert result (`{ inserted, errors, conflicts }`) into the
 * running totals, mutating them in place. `totals` is an accumulator the caller
 * owns — by design it threads one mutable record through both storage planes.
 */
const mergeImportResult = (
    totals: ImportTotals,
    result: { conflicts: number; deleted?: Record<string, number>; errors: ReadonlyArray<ImportRowError>; inserted: Record<string, number> },
): void => {
    for (const [table, count] of Object.entries(result.inserted)) {
        // eslint-disable-next-line no-param-reassign -- `totals` is the caller-owned accumulator threaded through both import planes
        totals.inserted[table] = (totals.inserted[table] ?? 0) + count;
    }

    for (const [table, count] of Object.entries(result.deleted ?? {})) {
        // eslint-disable-next-line no-param-reassign -- `totals` is the caller-owned accumulator threaded through both import planes
        totals.deleted[table] = (totals.deleted[table] ?? 0) + count;
    }

    for (const rowError of result.errors) {
        totals.errors.push({ ...rowError });
    }

    // eslint-disable-next-line no-param-reassign -- `totals` is the caller-owned accumulator threaded through both import planes
    totals.conflicts += result.conflicts;
};

/**
 * Hand the `.global()` rows to the user-supplied `importGlobals`, folding its
 * result into `totals`. A replace (`globalScope` non-empty) runs even with no
 * rows — it empties those tables — and is skipped once the shard-local half has
 * failed, so a refused replace does not go on to rewrite D1.
 */
const importGlobalPlane = async (
    options: WorkerOptions,
    totals: ImportTotals,
    warnings: string[],
    globalRows: BucketedImport["globalRows"],
    globalScope: ReadonlyArray<string>,
): Promise<void> => {
    if (globalScope.length > 0 && (totals.errors.length > 0 || totals.failed.length > 0)) {
        warnings.push(`the .global() table(s) ${globalScope.join(", ")} were not replaced because the shard-local half of the replace failed`);

        return;
    }

    if (globalRows.length === 0 && globalScope.length === 0) {
        return;
    }

    if (!options.importGlobals) {
        for (const globalRow of globalRows) {
            totals.errors.push({
                code: "GLOBAL_NOT_CONFIGURED",
                line: globalRow.line,
                message: `row targets global table "${globalRow.table}" but no \`importGlobals\` is configured`,
                table: globalRow.table,
            });
        }

        return;
    }

    // Pass each row's true physical `line` (carried on the row) so error
    // attribution is correct even when global rows are interspersed with shard
    // rows or blank lines. `startLine` is the first global row's line, retained
    // only as a backward-compat fallback.
    const result = await options.importGlobals({
        ...(globalScope.length > 0 ? { replaceTables: globalScope } : {}),
        rows: globalRows,
        startLine: globalRows[0]?.line ?? 1,
    });

    mergeImportResult(totals, result);
};

/**
 * Stream the inbound NDJSON body, bucket rows per shard, and forward them to
 * the coordinator's import fan-out. Globals are siphoned off and handed to the
 * `importGlobals` callback (if present) so the two storage planes can run in
 * parallel.
 *
 * `replaceTables` switches to replace mode: those tables end up holding exactly
 * the imported rows — existing `_id`s overwritten, everything else deleted.
 * Nothing is written when any line is refused up front; each shard then replaces
 * in one transaction (rolled back on any row error), and the `.global()` half
 * runs only once every shard succeeded, so a failure stops at a shard boundary
 * rather than running on into D1.
 */
const streamingImport = async (
    request: Request,
    options: WorkerOptions,
    coordinator: QueryCoordinator,
    forwardedHeaders: Record<string, string>,
    namespace: ShardNamespaceLike,
    replaceTables?: ReadonlyArray<string>,
): Promise<{
    conflicts: number;
    /** Replace mode only: rows removed per table because the import did not carry them. */
    deleted?: Record<string, number>;
    errors: ImportRowError[];
    failed: ImportShardFailure[];
    inserted: Record<string, number>;
    received: number;
    warnings?: string[];
}> => {
    const defaultShard = options.defaultShardKey ?? "__root__";
    const isGlobal = (table: string): boolean => options.resolveTableSharding?.(table)?.mode.kind === "global";
    const globalScope = replaceTables?.filter((table) => isGlobal(table)) ?? [];
    const shardScope = replaceTables?.filter((table) => !isGlobal(table)) ?? [];

    // Refused before reading a byte: with no global importer the `.global()`
    // tables could be neither written nor emptied, and a replace that silently
    // skips half its scope is not a replace.
    if (globalScope.length > 0 && !options.importGlobals) {
        throw new LunoraError(`replace import covers .global() table(s) ${globalScope.join(", ")} but no \`importGlobals\` is configured`, {
            code: "GLOBAL_NOT_CONFIGURED",
            status: 400,
        });
    }

    const { errors, globalRows, perShard, received, sectionRows } = await bucketImportStream(
        request,
        options,
        defaultShard,
        replaceTables === undefined ? undefined : new Set(replaceTables),
    );

    const totals: ImportTotals = { conflicts: 0, deleted: {}, errors, failed: [], inserted: {} };
    const warnings: string[] = [];

    // A replace deletes, so it writes nothing at all unless every line parsed.
    if (replaceTables !== undefined && errors.length > 0) {
        return { conflicts: 0, deleted: {}, errors, failed: [], inserted: {}, received };
    }

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
    if (perShard.size > 0 || shardScope.length > 0) {
        // `namespace` is the worker's jurisdiction-pinned shard binding (create-worker
        // pins it once). Fanning out through it keeps import writing to the SAME DOs
        // the app reads — using the raw `options.shardDO` would land rows in the
        // un-pinned global DOs, outside the residency boundary and unreachable by
        // the live worker (a fail-open leak).
        const result = await coordinator.orchestrateImport(namespace, {
            batches: [...perShard.values()],
            headers: forwardedHeaders,
            ...(shardScope.length > 0 ? { replace: { defaultShardKey: defaultShard, tables: shardScope } } : {}),
        });

        mergeImportResult(totals, result);
        totals.failed.push(...shardFailures(result.shards));
    }

    await importGlobalPlane(options, totals, warnings, globalRows, globalScope);

    if (sectionRows.length > 0) {
        mergeImportResult(totals, await importSectionRows(options, sectionRows));
    }

    // `received` is the honest denominator, counted as each line was read (see
    // `BucketedImport.received`). Without it the response asserted success by
    // omission: `errors: []` and `conflicts: 0` together read as "nothing went
    // wrong", and an empty `inserted` map is also exactly what a legitimately
    // empty batch returns — so a bulk import that was structurally unable to
    // write was indistinguishable from one that had nothing to do, and a
    // migration script could report "imported 4.2M rows" against an empty
    // database. A caller compares `received` against the inserted total.
    //
    // `failed` is the other half of that honesty: a non-empty array means an
    // unknown slice of the batch never reached storage, so `inserted` is a floor
    // rather than a result. The endpoint answers 207 in that case.
    return {
        conflicts: totals.conflicts,
        ...(replaceTables === undefined ? {} : { deleted: totals.deleted }),
        errors: totals.errors,
        failed: totals.failed,
        inserted: totals.inserted,
        received,
        ...(warnings.length > 0 ? { warnings } : {}),
    };
};

export type { ImportRowError };
export { streamingImport };
