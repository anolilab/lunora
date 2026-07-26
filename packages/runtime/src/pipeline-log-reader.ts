/**
 * Read the durable `ctx.log` archive that `pipelineLogSink` writes back.
 *
 * `pipelineLogSink` (see `observability-sinks.ts`) durably persists every
 * `ctx.log` line to a Cloudflare Pipeline to R2 (an Apache Iceberg table in R2
 * Data Catalog). Nothing on the platform reads that archive back for you — this
 * module is the reader. It builds a safe, keyset-paginated `SELECT` over the
 * Iceberg table with `@lunora/bindings/r2sql` and returns typed log rows.
 *
 * **Column contract.** This module OWNS the read-side column names: the defaults
 * in {@link DEFAULT_LOG_COLUMNS} mirror, one-for-one, the keys `pipelineLogSink`
 * writes (`functionPath`, `level`, `message`, `ts`, `fields`, `shardKey`,
 * `userId`, `traceId`, `spanId`). An operator whose Iceberg schema renames a
 * column (or whose Pipeline transform does) passes a `columnMap` to realign the
 * reader without touching the writer. Keep the two sides in lockstep: a column
 * added to the sink record must gain a default here.
 *
 * **Injection safety.** R2 SQL has no parameter binding — every value is inlined
 * into the statement text. So each user-supplied filter value flows through the
 * `sql` tag / `lit`, never string-concatenated, and column names (which are
 * operator config, not request input) are spliced with `raw`. See
 * `@lunora/bindings/r2sql`'s `sql.ts` for the escaping contract.
 *
 * **Pagination.** Keyset on `ts DESC`, not `OFFSET` — R2 SQL scans Iceberg data
 * files and a large `OFFSET` re-scans every skipped row, whereas a `ts`-bounded
 * `WHERE` prunes whole files. `ts` is **not unique**, so the keyset is lossless
 * only if resume is *inclusive*: the cursor `ts` is the last returned row's `ts`,
 * the next page fetches every row at-or-older-than it, and the
 * {@link PipelineLogCursor} `seen` hashes drop exactly the boundary rows already
 * emitted — no row on a tied millisecond is skipped (the old exclusive
 * strictly-older cursor silently dropped them) or duplicated. We still over-fetch
 * by one to detect a next page; a page dominated by a single `ts` grows that
 * window (bounded) so pagination still advances.
 */
import type { R2SqlClient, SelectBuilder } from "@lunora/bindings/r2sql";
import { desc, raw, sql } from "@lunora/bindings/r2sql";

import type { ContextLogLevel } from "../../../shared/log-event";
import { LOG_LEVEL_ORDER } from "../../../shared/log-event";

/**
 * The written-column contract: every field `pipelineLogSink` emits, mapped to the
 * column it is stored under by default (the identity mapping). Also the source of
 * truth for the {@link PipelineLogField} union. Mirrors the record built in
 * `pipelineLogSink` — the read side of the same contract.
 */
const DEFAULT_COLUMNS = {
    fields: "fields",
    functionPath: "functionPath",
    level: "level",
    message: "message",
    shardKey: "shardKey",
    spanId: "spanId",
    traceId: "traceId",
    ts: "ts",
    userId: "userId",
} as const;

/** Default page size when a query omits `limit`. Matches R2 SQL's own default. */
const DEFAULT_LIMIT = 500;

/** R2 SQL's documented `LIMIT` ceiling — the reader never fetches more than this in one query. */
const MAX_LIMIT = 10_000;

/**
 * One raw cell as R2 SQL returns it: a scalar or null (log columns never hold a
 * nested object). Typing the row this narrowly keeps `String(...)` coercions safe
 * from an "[object Object]" stringification.
 */
type StoredCell = boolean | null | number | string;

/** A raw result row keyed by physical column name. */
type StoredRow = Record<string, StoredCell | undefined>;

/** Clamp a requested limit into R2 SQL's `[1, 10000]` integer range, defaulting an absent/invalid value. */
const clampLimit = (limit: number | undefined): number => {
    if (limit === undefined || !Number.isFinite(limit)) {
        return DEFAULT_LIMIT;
    }

    // Floor first so a fractional request can't slip past the integer LIMIT the
    // builder's `assertLimit` enforces, then bound to the documented range.
    const floored = Math.floor(limit);

    if (floored < 1) {
        return 1;
    }

    if (floored > MAX_LIMIT) {
        return MAX_LIMIT;
    }

    return floored;
};

/** Coerce a stored `ts` cell (number, or numeric string from some engines) to epoch-millis. */
const toTs = (value: StoredCell | undefined): number => (typeof value === "number" ? value : Number(value));

/** Coerce a scalar cell to a string, treating null/absent as the empty string (never stringifies an object). */
const renderCell = (value: StoredCell | undefined): string => (value === null || value === undefined ? "" : String(value));

/** Decode a stored `fields` cell: parse a JSON string (the `serializeFields` shape) back to a value, else pass through. */
const decodeFields = (value: StoredCell): unknown => {
    if (typeof value !== "string") {
        return value;
    }

    try {
        return JSON.parse(value) as unknown;
    } catch {
        // Not JSON (a sink without `serializeFields`, or a plain string column):
        // hand back the raw string rather than dropping it.
        return value;
    }
};

/**
 * A stable ~62-bit identity hash of a decoded row, rendered as two base-36 parts.
 *
 * The sink shape carries no guaranteed-unique column (`traceId`/`spanId` are
 * optional and often absent), so keyset pagination over the non-unique `ts`
 * cannot dedup boundary ties by id. Instead we hash the row's whole rendered
 * identity — `ts` plus every canonical field — and carry those hashes on the
 * cursor. Two rows that are byte-for-byte identical within one millisecond hash
 * the same and are treated as interchangeable duplicates (acceptable: they are
 * indistinguishable to a consumer anyway). The combined ~62-bit width makes an
 * accidental collision between genuinely different rows on the same `ts`
 * negligible.
 */
const hashRow = (row: PipelineLogRow): string => {
    // A JSON tuple so no field delimiter can be forged by a value that happens to
    // contain the separator (an absent optional serialises as `null`); `fields` is
    // included so structured payloads distinguish otherwise-identical lines.
    const identity = JSON.stringify([row.ts, row.level, row.functionPath, row.message, row.traceId, row.spanId, row.shardKey, row.userId, row.fields]);

    // Two independent polynomial rolling hashes over large primes, combined into
    // one token. Pure modular arithmetic (no bit ops): each accumulator stays well
    // under 2^53 so every step is exact in a JS double. The two moduli together
    // give ~62 bits of identity — ample for de-duping rows within a single `ts`.
    let h1 = 0;
    let h2 = 0;

    for (const character of identity) {
        const code = character.codePointAt(0) ?? 0;

        h1 = (h1 * 31 + code) % 2_147_483_647;
        h2 = (h2 * 131 + code) % 4_294_967_291;
    }

    return `${h1.toString(36)}.${h2.toString(36)}`;
};

/**
 * Apply every value filter and the inclusive keyset bound to a prepared builder.
 * Extracted so the paginated query stays readable; each value flows through the
 * `sql` tag (escaped), column names come from operator config via `raw`.
 */
const applyLogFilters = (
    builder: SelectBuilder<StoredRow>,
    query: PipelineLogQuery,
    columns: Record<PipelineLogField, string>,
    cursorTs: number | undefined,
): void => {
    if (query.sinceTs !== undefined) {
        builder.where(sql`${raw(columns.ts)} >= ${query.sinceTs}`);
    }

    if (query.untilTs !== undefined) {
        builder.where(sql`${raw(columns.ts)} <= ${query.untilTs}`);
    }

    if (query.level !== undefined) {
        // Exact severity wins over `minLevel` (documented on the type): a caller
        // asking for one level should not also get everything above it.
        builder.where(sql`${raw(columns.level)} = ${query.level}`);
    } else if (query.minLevel !== undefined) {
        // Expand the floor to the explicit set at/above it in the severity ramp; an
        // `IN (...)` over a small closed set is clearer to the engine (and reader)
        // than a comparison over a non-numeric column.
        const floorIndex = LOG_LEVEL_ORDER.indexOf(query.minLevel);
        const allowed = floorIndex === -1 ? [...LOG_LEVEL_ORDER] : LOG_LEVEL_ORDER.slice(floorIndex);

        builder.where(sql`${raw(columns.level)} IN ${allowed}`);
    }

    if (query.functionPath !== undefined) {
        builder.where(sql`${raw(columns.functionPath)} = ${query.functionPath}`);
    }

    if (query.functionPathPrefix !== undefined) {
        // `LIKE 'prefix%'`: the trailing `%` sits inside the escaped literal so it
        // stays the wildcard, while the prefix itself is quote-escaped and cannot
        // break out. (A `%`/`_` within the prefix acts as a wildcard — documented.)
        builder.where(sql`${raw(columns.functionPath)} LIKE ${`${query.functionPathPrefix}%`}`);
    }

    if (query.traceId !== undefined) {
        builder.where(sql`${raw(columns.traceId)} = ${query.traceId}`);
    }

    if (query.shardKey !== undefined) {
        builder.where(sql`${raw(columns.shardKey)} = ${query.shardKey}`);
    }

    if (query.userId !== undefined) {
        builder.where(sql`${raw(columns.userId)} = ${query.userId}`);
    }

    if (cursorTs !== undefined) {
        // Keyset resume is inclusive (`<=`, not `<`): the boundary `ts` is the last
        // row we returned, and other rows sharing that millisecond may still be
        // unreturned. The caller's `seen` set drops the ones we already emitted, so
        // no row is skipped or duplicated.
        builder.where(sql`${raw(columns.ts)} <= ${cursorTs}`);
    }
};

/**
 * The canonical field names of one persisted log record — the keys
 * `pipelineLogSink` writes. Used as the {@link PipelineLogColumnMap} keys and the
 * {@link PipelineLogRow} shape, so the reader stays decoupled from whatever
 * physical column names the operator's Iceberg table happens to use.
 */
export type PipelineLogField = keyof typeof DEFAULT_COLUMNS;

/**
 * Field-to-column-name map. Defaults to the identity mapping (each field stored
 * under its own name, matching what `pipelineLogSink` writes). Override per-field
 * when the Iceberg schema renames a column; unspecified fields keep their
 * default. This is the single knob that lets one reader serve differently shaped
 * Data Catalog tables.
 */
export type PipelineLogColumnMap = Partial<Record<PipelineLogField, string>>;

/**
 * An opaque keyset cursor. `ts` is the epoch-millis of the **last returned** row
 * (not an un-returned overflow row), so the next page resumes *inclusively* at
 * that boundary and never skips a row that shares that millisecond. Because `ts`
 * is not unique, `seen` carries the identity hashes of the already-returned rows
 * sitting exactly on that boundary `ts`, so the next page can drop them without
 * re-emitting them. Both fields are JSON-serialisable; consumers pass the whole
 * object back unchanged.
 */
export interface PipelineLogCursor {
    /**
     * Identity hashes (see the internal `hashRow`) of the rows already returned
     * that share the boundary `ts`. The next page fetches every row at-or-older-than
     * the boundary and filters out any whose hash is in this set, so boundary rows
     * are neither dropped nor duplicated. Only ever holds rows at the single
     * boundary `ts`; omitted (or empty) when the boundary carries no already-returned ties.
     */
    seen?: string[];
    /** Epoch-millis boundary; the next page is every row at or older than this. */
    ts: number;
}

/** Filters for one {@link PipelineLogReader} query. Every value is inlined safely (`lit`/`sql`). */
export interface PipelineLogQuery {
    /** Continue after a previous page (inclusive keyset on `ts DESC`, dedup'd by {@link PipelineLogCursor} `seen`). Combined with the other filters. */
    cursor?: PipelineLogCursor;
    /** Match only this exact function path's records. Prefer `functionPathPrefix` for a namespace sweep. */
    functionPath?: string;
    /** Match records whose `functionPath` starts with this string (rendered as a `LIKE 'prefix%'`). */
    functionPathPrefix?: string;
    /** Match only this exact severity. When set, `minLevel` is ignored for the same field. */
    level?: ContextLogLevel;
    /** Max rows to return. Clamped to `[1, 10000]`; defaults to {@link DEFAULT_LOG_LIMIT}. */
    limit?: number;
    /** Severity floor: keep every level at or above this in {@link LOG_LEVEL_ORDER} (e.g. `warn` keeps warn, error, fatal). */
    minLevel?: ContextLogLevel;
    /** Match only this shard key. */
    shardKey?: string;
    /** Lower time bound, inclusive (`ts` at or after this), epoch-millis. */
    sinceTs?: number;
    /** Match only this trace id. */
    traceId?: string;
    /** Upper time bound, inclusive (`ts` at or before this), epoch-millis. */
    untilTs?: number;
    /** Match only this acting user id. */
    userId?: string;
}

/**
 * One decoded log record. Always keyed by the canonical {@link PipelineLogField}
 * names regardless of the physical columns (the reader remaps via `columnMap`),
 * so consumers never see the operator's storage names.
 */
export interface PipelineLogRow {
    /**
     * Structured fields, when the record carried them. A `serializeFields` sink
     * stores these as a JSON string, which the reader parses back to an object;
     * a plain string that is not valid JSON is returned verbatim.
     */
    fields?: unknown;
    /** Function path that emitted the line, e.g. `"messages:list"`. */
    functionPath: string;
    /** Severity the line was logged at. */
    level: ContextLogLevel;
    /** Rendered message. */
    message: string;
    /** Shard key for single-shard calls, when present. */
    shardKey?: string;
    /** Span id the line was emitted under, when present. */
    spanId?: string;
    /** Trace id the line belongs to, when present. */
    traceId?: string;
    /** Epoch-millis the line was emitted. */
    ts: number;
    /** Acting user id, when present. */
    userId?: string;
}

/** One page of {@link PipelineLogRow}s, newest first, plus the cursor for the next page (absent means last page). */
export interface PipelineLogPage {
    /** The cursor to pass as {@link PipelineLogQuery} `cursor` for the following page; absent when this is the last page. */
    nextCursor?: PipelineLogCursor;
    /** The rows, ordered `ts DESC` (newest first). At most `limit` of them. */
    rows: PipelineLogRow[];
}

/** Options for {@link createPipelineLogReader}. */
export interface PipelineLogReaderOptions {
    /**
     * Override any physical column name that diverges from the default (identity)
     * mapping. Unspecified fields keep their {@link DEFAULT_LOG_COLUMNS} name.
     */
    columnMap?: PipelineLogColumnMap;

    /**
     * The Iceberg namespace the `table` lives in (R2 Data Catalog database).
     * Combined as `namespace.table` in the `FROM` clause; omit when `table`
     * already carries its namespace.
     */
    namespace?: string;
    /** The Iceberg table name the Pipeline writes log records to (e.g. `"logs"`). */
    table: string;
}

/** The reader surface: a single keyset-paginated {@link PipelineLogPage} query. */
export interface PipelineLogReader {
    /** Run one filtered, keyset-paginated read and return a {@link PipelineLogPage}. */
    query: (query?: PipelineLogQuery) => Promise<PipelineLogPage>;
}

/** The written-column contract exposed publicly: canonical field to default physical column name. */
export const DEFAULT_LOG_COLUMNS: Readonly<Record<PipelineLogField, string>> = DEFAULT_COLUMNS;

/** Default page size when a query omits `limit`. */
export const DEFAULT_LOG_LIMIT: number = DEFAULT_LIMIT;

/**
 * Build a durable-log reader over one R2 Data Catalog (Iceberg) table.
 *
 * The returned {@link PipelineLogReader} compiles each call to a safe
 * `SELECT ... WHERE ... ORDER BY ts DESC LIMIT n` (over-fetching by one) and
 * decodes the rows back to the canonical {@link PipelineLogRow} shape. All value
 * filters are escaped through `@lunora/bindings/r2sql`'s `sql`/`lit`; column
 * names come from `options.columnMap` (operator config), spliced with `raw`.
 * @param client An {@link R2SqlClient} (`createR2Sql({ accountId, apiToken, bucket })`).
 * @param options The target `table` (plus optional `namespace`) and any `columnMap` overrides.
 */
export const createPipelineLogReader = (client: R2SqlClient, options: PipelineLogReaderOptions): PipelineLogReader => {
    // Resolve the physical column for each field once (defaults + overrides), so
    // every query reuses the same operator-configured names.
    const columns: Record<PipelineLogField, string> = { ...DEFAULT_COLUMNS, ...options.columnMap };
    // `namespace.table` (or a bare `table` already carrying its namespace). The
    // builder's `tableRef` validates this reference, so an operator can't inject
    // via a crafted table/namespace either.
    const tableReference = options.namespace === undefined ? options.table : `${options.namespace}.${options.table}`;

    // Decode one raw storage row into the canonical, physical-name-agnostic shape.
    const decodeRow = (row: StoredRow): PipelineLogRow => {
        const out: PipelineLogRow = {
            functionPath: renderCell(row[columns.functionPath]),
            // The stored `level` is one of the canonical severities; the reader
            // trusts the writer's contract here rather than re-validating.
            level: renderCell(row[columns.level]) as ContextLogLevel,
            message: renderCell(row[columns.message]),
            ts: toTs(row[columns.ts]),
        };

        // Optional columns: attach only when the engine returned a value, so a
        // `PipelineLogRow` mirrors the sparse record the sink wrote.
        const fields = row[columns.fields];

        if (fields !== undefined && fields !== null) {
            out.fields = decodeFields(fields);
        }

        const shardKey = row[columns.shardKey];

        if (shardKey !== undefined && shardKey !== null) {
            out.shardKey = renderCell(shardKey);
        }

        const userId = row[columns.userId];

        if (userId !== undefined && userId !== null) {
            out.userId = renderCell(userId);
        }

        const traceId = row[columns.traceId];

        if (traceId !== undefined && traceId !== null) {
            out.traceId = renderCell(traceId);
        }

        const spanId = row[columns.spanId];

        if (spanId !== undefined && spanId !== null) {
            out.spanId = renderCell(spanId);
        }

        return out;
    };

    // Build + run one read of `fetchLimit` rows with every filter + the inclusive
    // cursor bound. A fresh builder each call so a grown re-fetch does not
    // accumulate WHERE clauses.
    const fetchRows = async (query: PipelineLogQuery, cursorTs: number | undefined, fetchLimit: number): Promise<StoredRow[]> => {
        const builder = client
            .from<StoredRow>(tableReference)
            // Project only the mapped columns (never `SELECT *`) so the read is
            // stable against unrelated columns in the Iceberg table.
            .select(
                raw(columns.functionPath),
                raw(columns.level),
                raw(columns.message),
                raw(columns.ts),
                raw(columns.fields),
                raw(columns.shardKey),
                raw(columns.userId),
                raw(columns.traceId),
                raw(columns.spanId),
            );

        applyLogFilters(builder, query, columns, cursorTs);

        builder.orderBy(desc(raw(columns.ts))).limit(fetchLimit);

        const { rows } = await builder.run();

        return rows;
    };

    // One grow-attempt: fetch `fetchLimit` rows, decode them, and drop any boundary
    // row already returned on a prior page (its hash is in `seen`). `truncated`
    // means the store filled the whole window, so more matching rows may remain
    // unseen — the caller cannot yet conclude "no next page".
    const readAttempt = async (
        query: PipelineLogQuery,
        cursorTs: number | undefined,
        seen: Set<string> | undefined,
        fetchLimit: number,
    ): Promise<{ decoded: PipelineLogRow[]; truncated: boolean }> => {
        const rows = await fetchRows(query, cursorTs, fetchLimit);
        const decoded: PipelineLogRow[] = [];

        for (const row of rows) {
            const decodedRow = decodeRow(row);
            const alreadyReturned = seen !== undefined && cursorTs !== undefined && decodedRow.ts === cursorTs && seen.has(hashRow(decodedRow));

            if (!alreadyReturned) {
                decoded.push(decodedRow);
            }
        }

        return { decoded, truncated: rows.length >= fetchLimit };
    };

    return {
        query: async (query: PipelineLogQuery = {}): Promise<PipelineLogPage> => {
            const limit = clampLimit(query.limit);
            const { cursor } = query;
            const cursorTs = cursor?.ts;
            // Boundary rows already returned on prior page(s) sharing `cursorTs` —
            // dropped from this page so an inclusive resume never re-emits them.
            const seen = cursor?.seen !== undefined && cursor.seen.length > 0 ? new Set(cursor.seen) : undefined;

            // Fetch one more than asked: an extra surviving row both flags a next
            // page and lets us skip minting a cursor at a true end-of-stream. The
            // base over-fetch may need to grow (below) when boundary de-duplication
            // consumes the extra budget on a page dominated by one `ts`.
            const baseFetchLimit = Math.min(limit + 1, MAX_LIMIT);

            // Grow the fetch window when boundary de-duplication leaves us unable to
            // tell whether a next page exists. Doubling, hard-capped so a page made
            // entirely of one `ts` cannot loop forever (the engine `LIMIT` ceiling
            // caps it regardless). Rare — only bites a page dominated by a single ms.
            const maxAttempts = 3;
            let decoded: PipelineLogRow[] = [];
            let truncated = false;

            for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
                const fetchLimit = Math.min(baseFetchLimit * 2 ** attempt, MAX_LIMIT);

                // eslint-disable-next-line no-await-in-loop -- each grow depends on the prior fetch's result; sequential by nature
                const attemptResult = await readAttempt(query, cursorTs, seen, fetchLimit);

                decoded = attemptResult.decoded;
                truncated = attemptResult.truncated;

                // A confirmed overflow row, or a store that returned everything it
                // has, both settle the "is there more?" question — stop growing.
                if (decoded.length > limit || !truncated || fetchLimit >= MAX_LIMIT) {
                    break;
                }
            }

            const hasOverflow = decoded.length > limit;
            const pageRows = hasOverflow ? decoded.slice(0, limit) : decoded;

            // Emit a next cursor when either a real overflow row proved more remains,
            // or we bailed out of the grow loop still `truncated` on a non-empty page
            // (the deferred-fix degenerate case: more than one page of a single
            // identical `ts`). The non-empty guard keeps that fallback from looping
            // on a page that de-duplicated down to nothing.
            const lastRow = pageRows.at(-1);

            if (lastRow === undefined || !(hasOverflow || truncated)) {
                return { rows: pageRows };
            }

            // Cursor `ts` is the **last returned** row's `ts`. `seen` carries every
            // returned row on that boundary `ts`, accumulated across consecutive
            // pages that share it (a tie spanning multiple pages) so none is
            // re-emitted; it resets whenever the boundary advances to an older `ts`.
            const boundaryTs = lastRow.ts;
            const boundaryHashes = pageRows.filter((row) => row.ts === boundaryTs).map((row) => hashRow(row));
            const carried = cursorTs === boundaryTs && cursor?.seen !== undefined ? cursor.seen : [];
            const nextSeen = [...carried, ...boundaryHashes];

            return { nextCursor: nextSeen.length > 0 ? { seen: nextSeen, ts: boundaryTs } : { ts: boundaryTs }, rows: pageRows };
        },
    };
};
