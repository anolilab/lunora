/**
 * The per-table pull + cadence layer of external-source ingest (plan 077). The DO
 * poll alarm calls these per sourced table; extracting them here (rather than
 * inlining in the codegen-emitted DO subclass) keeps the loop's real logic — the
 * id-lift, the tenant-scoped query, the cadence gate — typed and unit-tested
 * instead of living only inside a code-generation string.
 *
 * The id-lift is the single source of truth shared with `@lunora/hyperdrive`'s
 * `projectSourceRow` (which delegates to {@link liftSourceId}), so the manual
 * bridge and the declarative `.source()` path can never drift in their
 * missing-id / non-scalar-id handling.
 */

import { LunoraError } from "@lunora/errors";

import type { DatabaseWriterLike, SqlExec } from "./ctx-db";
import { deserializeCursor, maxCursorValue, migrateSourceCursor, readSourceCursor, writeSourceCursor } from "./external-source-cursor";
import type { MaterializeResult } from "./external-source-materialize";
import { materializeExternalRowsIncremental, runExternalSourceTick } from "./external-source-materialize";

/** The minimal SqlClient surface the poll loop calls (mirrors `@lunora/hyperdrive`'s `SqlClient`). */
interface SourceClientLike {
    query: <Row = Record<string, unknown>>(text: string, parameters?: ReadonlyArray<unknown>) => Promise<Row[]>;
}

/** Poll cadence: `"manual"` (never auto-poll) or a minimum interval between polls. */
type SourceRefresh = "manual" | { everyMs: number };

/** The incremental cursor config (plan 136): the watermark column + the watermark-parameterized pull query. */
interface SourceCursorLike {
    column: string;
    query: string;
}

/** The runtime `.source(...)` config the poll loop reads — a structural mirror of `@lunora/server`'s `ExternalSourceDefinition` (only the fields the tick uses). */
interface ExternalSourceLike {
    binding: string;
    columns?: ReadonlyArray<string>;
    cursor?: SourceCursorLike;
    idColumn?: string;
    map?: (row: Record<string, unknown>) => Record<string, unknown>;
    mode?: string;
    query: string;
    reconcileEveryMs?: number;
    refresh?: SourceRefresh;
    softDeleteColumn?: string;
    tenantBy?: (shardKey: string) => ReadonlyArray<unknown>;
}

/**
 * Coerce a driver-native value that `stableStringify` can't represent (see
 * `shared/stable-key.ts`) into its JSON-safe form: a `Date` → its ISO string, a
 * `bigint` → its decimal string. Every other value passes through unchanged.
 *
 * node-pg / postgres-js / mysql2 return `timestamp`/`datetime` columns as JS
 * `Date` and `bigint`/`int8` columns as `bigint` — both throw a `TypeError` out of
 * `stableStringify` (used by the full-pull diff and the incremental content
 * short-circuit), which bricks ingest for any table with such a column (e.g. the
 * canonical `cursor: { column: "updated_at" }` incremental config). This is the
 * single boundary where driver-native types cross into DO SQLite JSON; a new
 * source driver (or a new non-JSON column type) must be normalized here too.
 * `shared/stable-key.ts`'s throw contract is intentionally left unchanged — this
 * normalizes the value *before* it can ever reach that encoder.
 */
const normalizeSourceValue = (value: unknown): unknown => {
    if (value instanceof Date) {
        return value.toISOString();
    }

    if (typeof value === "bigint") {
        return String(value);
    }

    if (Array.isArray(value)) {
        return value.map((element) => normalizeSourceValue(element));
    }

    if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
        return normalizeSourceDocument(value as Record<string, unknown>);
    }

    return value;
};

/**
 * Normalize every field of a lifted document (see {@link normalizeSourceValue}).
 * Applied once at the lift boundary (inside {@link liftSourceId}) so both the
 * full-pull diff (`diffExternalSource`) and the incremental content short-circuit
 * (`materializeExternalRowsIncremental`) — and whatever a stored row reads back
 * as — see the same JSON-safe values.
 */
const normalizeSourceDocument = (document: Record<string, unknown>): Record<string, unknown> => {
    const normalized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(document)) {
        normalized[key] = normalizeSourceValue(value);
    }

    return normalized;
};

/**
 * Lift an external row to a Lunora document: the `idColumn` value becomes a
 * stringified `_id`, then either `map` shapes the body or every other column is
 * copied verbatim. Throws on a missing/null id, and on a non-scalar id, so a
 * misconfigured query fails loudly instead of materializing rows under the literal
 * id `"undefined"` (or collapsing many rows onto one id). Shared with
 * `@lunora/hyperdrive`'s `projectSourceRow`. The returned document's values are
 * normalized (see {@link normalizeSourceValue}) so a `Date`/`bigint` column never
 * reaches `stableStringify` un-normalized.
 */
const liftSourceId = (
    row: Record<string, unknown>,
    options: { idColumn?: string; map?: (row: Record<string, unknown>) => Record<string, unknown> } = {},
): Record<string, unknown> => {
    const { idColumn = "id", map } = options;
    const idValue = row[idColumn];

    if (idValue === undefined || idValue === null) {
        throw new LunoraError("INTERNAL", `external-source: row is missing id column "${idColumn}"`);
    }

    if (typeof idValue !== "string" && typeof idValue !== "number" && typeof idValue !== "bigint") {
        throw new TypeError(`external-source: id column "${idColumn}" must be a string or number`);
    }

    const id = String(idValue);

    if (map) {
        return normalizeSourceDocument({ ...map(row), _id: id });
    }

    const body: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(row)) {
        if (key !== idColumn) {
            body[key] = value;
        }
    }

    return normalizeSourceDocument({ ...body, _id: id });
};

/**
 * Whether a source should poll on this alarm tick. `"manual"` never auto-polls;
 * `{ everyMs }` polls at most once per interval (the alarm floor still bounds it
 * from below); an omitted `refresh` polls every tick. `lastPolledMs` is `undefined`
 * before the first poll (always due).
 */
const isSourceDue = (refresh: SourceRefresh | undefined, lastPolledMs: number | undefined, nowMs: number): boolean => {
    if (refresh === "manual") {
        return false;
    }

    if (refresh === undefined || lastPolledMs === undefined) {
        return true;
    }

    return nowMs - lastPolledMs >= refresh.everyMs;
};

/** The raw driver rows plus their lifted Lunora documents (index-aligned), the shared output of every source query. */
interface PulledSlice {
    /** Lifted Lunora documents (`liftSourceId` per row), index-aligned to {@link PulledSlice.rows}. */
    documents: Record<string, unknown>[];
    /** The raw external rows as the driver returned them — kept for watermark / soft-delete reads the id-lift may drop. */
    rows: Record<string, unknown>[];
}

/**
 * Run `query` with `parameters` and lift every row to a Lunora document. Returns
 * both the raw rows (the cursor/soft-delete columns are read from these, before the
 * id-lift may project them away) and the index-aligned lifted documents, so the
 * per-tick paths never lift a row twice.
 */
const pullAndLift = async (client: SourceClientLike, query: string, parameters: ReadonlyArray<unknown>, source: ExternalSourceLike): Promise<PulledSlice> => {
    const rows = await client.query(query, parameters);
    const documents = rows.map((row) => liftSourceId(row, { idColumn: source.idColumn, map: source.map }));

    return { documents, rows };
};

/**
 * Pull a sourced table's tenant slice from `client`, project each row through
 * {@link liftSourceId}, and materialize it via {@link runExternalSourceTick}
 * (read local baseline → diff → apply through the validated CDC writer). The
 * per-table body the DO poll alarm runs; `shardKey` binds into `tenantBy`.
 */
const pullExternalSourceTick = async (
    sql: SqlExec,
    writer: DatabaseWriterLike,
    client: SourceClientLike,
    table: string,
    source: ExternalSourceLike,
    shardKey: string,
): Promise<MaterializeResult> => {
    const parameters = source.tenantBy ? source.tenantBy(shardKey) : [];
    const { documents } = await pullAndLift(client, source.query, parameters, source);

    return runExternalSourceTick(sql, writer, documents, { columns: source.columns, table });
};

/**
 * Whether an upstream row is a soft-delete tombstone under `column`. A set
 * `deleted_at` (any non-null value, e.g. a timestamp), an `is_deleted = true`, or a
 * non-zero flag all read as deleted; `null` / `undefined` / `false` / `0` mean
 * live. Note an **empty string** reads as deleted (`"" !== 0`), so an upstream that
 * clears the column to `""` rather than `NULL` for a live row would mis-signal —
 * use `NULL` for live rows. The incremental query MUST return tombstoned rows
 * (don't filter `WHERE deleted_at IS NULL`) or the delete is never observed.
 */
const isSoftDeleted = (row: Record<string, unknown>, column: string): boolean => {
    const value = row[column];

    return value !== null && value !== undefined && value !== false && value !== 0;
};

/**
 * Run one **incremental** tick (plan 136). Reads the durable watermark for
 * `(table, shardKey)`; on the first ever poll or when the `reconcileEveryMs` sweep
 * is due it runs a **full-pull** (seed/GC: {@link runExternalSourceTick} observes
 * deletes and re-establishes membership), otherwise it pulls only rows past the
 * watermark via `cursor.query` and upserts them ({@link materializeExternalRowsIncremental},
 * tombstones → deletes). Either way it advances the watermark to the max cursor
 * value seen and persists it (and the reconcile timestamp).
 *
 * **Crash safety** is by ordering + idempotency, NOT an atomic transaction across
 * the two write channels (the apply goes through the `writer`; the watermark write
 * is a raw `sql` write): the watermark advances only AFTER a fully-applied slice,
 * so a crash between the apply and the watermark write leaves the watermark behind
 * and the next tick re-pulls the same `>= watermark` slice — which the upsert
 * short-circuits (unchanged rows) or re-applies idempotently. It only ever replays,
 * never skips (same self-healing argument as `advanceClientWatermark`).
 *
 * Requires `source.cursor` (validated at `defineSchema` for incremental mode); a
 * missing cursor throws rather than silently degrading to a stuck watermark.
 */
const pullExternalSourceIncrementalTick = async (
    sql: SqlExec,
    writer: DatabaseWriterLike,
    client: SourceClientLike,
    table: string,
    source: ExternalSourceLike,
    shardKey: string,
    nowMs: number,
): Promise<{ applied: number }> => {
    const { cursor } = source;

    if (!cursor) {
        throw new LunoraError(
            "INTERNAL",
            `external-source: table "${table}" is mode "incremental" but has no \`cursor\` — this should have been rejected at defineSchema`,
        );
    }

    migrateSourceCursor(sql);

    const state = readSourceCursor(sql, table, shardKey);
    const tenantParameters = source.tenantBy ? source.tenantBy(shardKey) : [];
    const reconcileDue = source.reconcileEveryMs !== undefined && (state.lastReconcileMs === null || nowMs - state.lastReconcileMs >= source.reconcileEveryMs);
    // First ever poll (no watermark) or a due reconcile ⇒ full-pull: seed the
    // membership + watermark, and GC any upstream deletes the incremental slices
    // couldn't see (absent-from-slice ≠ deleted).
    const fullPull = state.watermark === null || reconcileDue;

    let slice: PulledSlice;
    let applied: number;

    // The condition is inlined (not `if (fullPull)`) so TS narrows `state.watermark`
    // to a non-null string in the `else` branch — no cast on `deserializeCursor`.
    if (state.watermark === null || reconcileDue) {
        slice = await pullAndLift(client, source.query, tenantParameters, source);

        // Exclude tombstoned rows from full-pull/reconcile membership (same
        // predicate the incremental branch uses to resolve `deletedIds`), or a
        // soft-deleted upstream row would be re-inserted as live on every seed/
        // reconcile sweep — the full-pull diff otherwise treats "present in the
        // slice" as "should exist locally" with no soft-delete awareness.
        const { softDeleteColumn } = source;
        const documents = softDeleteColumn
            ? slice.documents.filter((_document, index) => {
                  const row = slice.rows[index];

                  return !(row && isSoftDeleted(row, softDeleteColumn));
              })
            : slice.documents;

        ({ applied } = await runExternalSourceTick(sql, writer, documents, { columns: source.columns, table }));
    } else {
        slice = await pullAndLift(client, cursor.query, [...tenantParameters, deserializeCursor(state.watermark)], source);

        const { softDeleteColumn } = source;
        // Resolve tombstone ids by index off the already-lifted documents (no second
        // lift); `rows[index]` is index-aligned to `documents[index]` (same slice).
        const deletedIds = softDeleteColumn
            ? new Set(
                  slice.documents.flatMap((document, index) => {
                      const row = slice.rows[index];

                      return row && isSoftDeleted(row, softDeleteColumn) ? [String(document._id)] : [];
                  }),
              )
            : undefined;

        ({ applied } = await materializeExternalRowsIncremental(writer, slice.documents, { columns: source.columns, deletedIds, table }));
    }

    // Advance from the RAW rows' cursor column (read before the id-lift may drop it).
    const watermark = maxCursorValue(slice.rows, cursor.column, state.watermark);

    // A full-pull that returned rows but couldn't advance the watermark means the
    // seed `query` doesn't project `cursor.column` (or aliases it differently than
    // `cursor.query` does) — otherwise every tick would full-pull forever, silently.
    // Fail loud instead (surfaced in the Logs panel via the poll loop's catch).
    if (fullPull && watermark === null && slice.rows.length > 0) {
        throw new LunoraError(
            "INTERNAL",
            `external-source: table "${table}" (mode "incremental") pulled ${String(slice.rows.length)} rows but none carry the cursor column "${cursor.column}" — the seed \`query\` must project it (matching \`cursor.query\`'s alias), or the watermark can never advance.`,
        );
    }

    // The incremental branch's analogue of the seed check above, adapted for a
    // non-null prior watermark: a non-empty `>= watermark` slice where NOT A
    // SINGLE row carries a value for `cursor.column` means `cursor.query` doesn't
    // project it (or aliases it differently than the seed `query` does) — the
    // watermark is stranded and every tick re-pulls the same slice forever. This
    // deliberately does NOT compare the advanced `watermark` against
    // `state.watermark`: a row genuinely carrying the boundary value (equal to
    // the current watermark, since the query is `>= watermark` by design — see
    // the incremental materialize function's doc comment) is the normal
    // steady-state re-pull, not a misconfiguration, and must not throw.
    const noRowCarriesCursor = slice.rows.length > 0 && slice.rows.every((row) => row[cursor.column] === null || row[cursor.column] === undefined);

    if (!fullPull && noRowCarriesCursor) {
        throw new LunoraError(
            "INTERNAL",
            `external-source: table "${table}" (mode "incremental") pulled ${String(slice.rows.length)} rows but none carry the cursor column "${cursor.column}" — \`cursor.query\` must project it (matching the seed \`query\`'s alias), or the watermark can never advance and every tick re-pulls the same stranded slice.`,
        );
    }

    writeSourceCursor(sql, table, shardKey, { lastReconcileMs: fullPull ? nowMs : state.lastReconcileMs, watermark });

    return { applied };
};

export { isSoftDeleted, isSourceDue, liftSourceId, normalizeSourceValue, pullExternalSourceIncrementalTick, pullExternalSourceTick };
export type { ExternalSourceLike, SourceClientLike, SourceCursorLike, SourceRefresh };
