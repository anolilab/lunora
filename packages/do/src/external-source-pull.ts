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

import type { DatabaseWriterLike, SqlExec } from "./ctx-db";
import type { MaterializeResult } from "./external-source-materialize";
import { runExternalSourceTick } from "./external-source-materialize";

/** The minimal SqlClient surface the poll loop calls (mirrors `@lunora/hyperdrive`'s `SqlClient`). */
interface SourceClientLike {
    query: <Row = Record<string, unknown>>(text: string, parameters?: ReadonlyArray<unknown>) => Promise<Row[]>;
}

/** Poll cadence: `"manual"` (never auto-poll) or a minimum interval between polls. */
type SourceRefresh = "manual" | { everyMs: number };

/** The runtime `.source(...)` config the poll loop reads — a structural mirror of `@lunora/server`'s `ExternalSourceDefinition` (only the fields the tick uses). */
interface ExternalSourceLike {
    binding: string;
    columns?: ReadonlyArray<string>;
    idColumn?: string;
    map?: (row: Record<string, unknown>) => Record<string, unknown>;
    query: string;
    refresh?: SourceRefresh;
    tenantBy?: (shardKey: string) => ReadonlyArray<unknown>;
}

/**
 * Lift an external row to a Lunora document: the `idColumn` value becomes a
 * stringified `_id`, then either `map` shapes the body or every other column is
 * copied verbatim. Throws on a missing/null id, and on a non-scalar id, so a
 * misconfigured query fails loudly instead of materializing rows under the literal
 * id `"undefined"` (or collapsing many rows onto one id). Shared with
 * `@lunora/hyperdrive`'s `projectSourceRow`.
 */
const liftSourceId = (
    row: Record<string, unknown>,
    options: { idColumn?: string; map?: (row: Record<string, unknown>) => Record<string, unknown> } = {},
): Record<string, unknown> => {
    const { idColumn = "id", map } = options;
    const idValue = row[idColumn];

    if (idValue === undefined || idValue === null) {
        throw new Error(`external-source: row is missing id column "${idColumn}"`);
    }

    if (typeof idValue !== "string" && typeof idValue !== "number" && typeof idValue !== "bigint") {
        throw new TypeError(`external-source: id column "${idColumn}" must be a string or number`);
    }

    const id = String(idValue);

    if (map) {
        return { ...map(row), _id: id };
    }

    const body: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(row)) {
        if (key !== idColumn) {
            body[key] = value;
        }
    }

    return { ...body, _id: id };
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
    const rows = await client.query(source.query, parameters);
    const documents = rows.map((row) => liftSourceId(row, { idColumn: source.idColumn, map: source.map }));

    return runExternalSourceTick(sql, writer, documents, { columns: source.columns, table });
};

export { isSourceDue, liftSourceId, pullExternalSourceTick };
export type { ExternalSourceLike, SourceClientLike, SourceRefresh };
