/**
 * The row store's fixed-shape write statements.
 *
 * Every statement a single-row write emits — the INSERT, the two OCC-guarded
 * UPDATEs, the OCC-guarded DELETE, the `changes()` probe behind them, and the
 * changelog append — has SQL text that is a pure function of the table name.
 * Nothing else varies: ids, documents and OCC snapshots are all bound
 * parameters. So the text is rendered once per table and thereafter only
 * re-bound.
 *
 * ## Why this module exists
 *
 * These were drizzle `sql` templates built and rendered inside the write path.
 * Profiling a DO insert+CDC workload over real SQLite (with statement caching
 * in the harness, matching what workerd does) put drizzle's build+render at
 * **21.9%** of the write path against **20.1%** for all of shard-engine's own
 * logic — because each write re-derived one of six constant strings through the
 * template machinery, the chunk walk, and the identifier escaper.
 *
 * It is also the more legible form. A reader of `patch` now sees
 * `UPDATE <t> SET __doc__ = ? WHERE id = ? AND __doc__ = ?` as text, rather
 * than reconstructing it from an interpolated template.
 *
 * ## The one rule
 *
 * These strings must stay byte-identical to what the drizzle templates
 * rendered, because that is the only thing establishing they are correct SQL
 * for this store. `__tests__/row-statements.test.ts` asserts exactly that,
 * statement by statement, by rendering the original template through
 * `renderSql` and comparing — so a divergence fails a test rather than
 * reaching SQLite.
 *
 * Identifiers go through {@link quoteIdentifier}, the same escaper drizzle's
 * `sql.identifier` uses, so a table name carrying a double quote is quoted
 * identically here. Never interpolate a *value* into these — they are cached by
 * table name, so a bound value spliced into the text would be served to every
 * later write on that table.
 */

import { sql as dsql } from "drizzle-orm";

import { quoteIdentifier } from "../../../shared/quote-identifier";
import { DOC_COLUMN } from "./do-sql";
import { renderSql, unionAll } from "./drizzle";

/**
 * Memoize a per-table statement builder.
 *
 * A shard's table set is fixed by its schema, so this is bounded by the schema's
 * width and never grows with traffic — the reason a plain `Map` is safe here
 * where an unbounded cache keyed by arbitrary input would not be.
 */
const perTable = (build: (quotedTable: string) => string): ((table: string) => string) => {
    const cache = new Map<string, string>();

    return (table: string): string => {
        const cached = cache.get(table);

        if (cached !== undefined) {
            return cached;
        }

        const text = build(quoteIdentifier(table));

        cache.set(table, text);

        return text;
    };
};

/** The stored-document column, pre-quoted once — it appears in five of the six statements. */
const DOC = quoteIdentifier(DOC_COLUMN);

/** `INSERT INTO <table> (id, _creationTime, __doc__) VALUES (?, ?, ?)` — binds `id`, `creationTime`, `doc`. */
const insertRowSql = perTable((table) => `INSERT INTO ${table} (id, _creationTime, ${DOC}) VALUES (?, ?, ?)`);

/**
 * `UPDATE <table> SET __doc__ = ? WHERE id = ? AND __doc__ = ?` — binds `nextDoc`, `id`, `existingDoc`.
 *
 * The trailing `__doc__ = ?` is the optimistic-concurrency guard: it matches the
 * document as it was read, so a concurrent write during the intervening `await`
 * makes this touch zero rows and `runGuardedWrite` raises instead.
 */
const patchRowSql = perTable((table) => `UPDATE ${table} SET ${DOC} = ? WHERE id = ? AND ${DOC} = ?`);

/** `UPDATE <table> SET _creationTime = ?, __doc__ = ? WHERE id = ? AND __doc__ = ?` — binds `creationTime`, `nextDoc`, `id`, `existingDoc`. */
const replaceRowSql = perTable((table) => `UPDATE ${table} SET _creationTime = ?, ${DOC} = ? WHERE id = ? AND ${DOC} = ?`);

/** `DELETE FROM <table> WHERE id = ? AND __doc__ = ?` — binds `id`, `existingDoc`. Same OCC guard as {@link patchRowSql}. */
const deleteRowSql = perTable((table) => `DELETE FROM ${table} WHERE id = ? AND ${DOC} = ?`);

/**
 * Row count of the most recent INSERT/UPDATE/DELETE, for the OCC check.
 *
 * Fully constant, so it is a value rather than a builder. `data-migration.ts`
 * already ran this as a plain string; the write path rendered the identical text
 * through drizzle on every guarded write.
 */
const CHANGES_PROBE_SQL = "SELECT changes() AS changed";

/**
 * The by-id row probe: one UNION-ALL branch per candidate table, each tagged
 * with its source table so a hit names its owner.
 *
 * Unlike the statements above this one is NOT hand-written. Its text depends on
 * how {@link unionAll} nests branches to stay under workerd's five-term
 * compound-SELECT cap, and reproducing that nesting by hand would be the kind of
 * duplicated structural logic this module exists to avoid. So the drizzle build
 * still runs — just once per distinct table list, instead of once per read.
 *
 * The cache key is the ordered table list, because the order is what the text
 * encodes. Values never enter the text: every branch binds the same `id`, so the
 * caller passes `id` once per branch (see {@link rowProbeParams}).
 */
const probeCache = new Map<string, string>();

/** Stand-in bound value used only to render {@link rowProbeSql}; it becomes a `?`. */
const PROBE_ID_PLACEHOLDER = "";

/**
 * @param tables candidate tables for this chunk, in probe order
 * @returns the rendered probe text for exactly this chunk
 */
const rowProbeSql = (tables: ReadonlyArray<string>): string => {
    // `JSON.stringify`, not a `join` — a table name may contain whatever
    // separator is chosen, and `["a b", "c"]` colliding with `["a", "b c"]`
    // would serve one list's SQL to the other. This cache returns executable
    // text, so an ambiguous key is a wrong-table read, not a mere cache miss.
    const key = JSON.stringify(tables);
    const cached = probeCache.get(key);

    if (cached !== undefined) {
        return cached;
    }

    const branches = tables.map(
        (table) =>
            // The table-name discriminator stays an inline literal (escaped) rather
            // than a bound param so it reads as `'<table>' AS __t__`.
            dsql`SELECT ${dsql.raw(`'${table.replaceAll("'", "''")}'`)} AS __t__, id, _creationTime, ${dsql.identifier(DOC_COLUMN)} FROM ${dsql.identifier(table)} WHERE id = ${PROBE_ID_PLACEHOLDER}`,
    );

    // Rendering replaces the bound value with `?`, so the placeholder never
    // reaches the text — only the shape does.
    const { sql: text } = renderSql("sqlite", dsql`${unionAll(branches)} LIMIT 1`);

    probeCache.set(key, text);

    return text;
};

/**
 * The probe binds the same `id` once per branch, in branch order.
 *
 * Takes the table list rather than a count so the result is typed `string[]` by
 * construction: `Array.from({ length }).fill(id)` (what the repo lint rule steers
 * toward) yields `unknown[]`, and the `Array.from({ length }, () => id)` form the
 * type checker prefers is what that rule rejects.
 */
const rowProbeParams = (id: string, tables: ReadonlyArray<string>): string[] => tables.map(() => id);

export { CHANGES_PROBE_SQL, deleteRowSql, insertRowSql, patchRowSql, replaceRowSql, rowProbeParams, rowProbeSql };
