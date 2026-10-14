/**
 * The injected SQL seam the durable RAG stores share.
 *
 * `@lunora/ai` depends on no database. A store is handed an executor instead,
 * so the same adapter runs on a Durable Object's SQLite, D1, `node:sqlite`, or
 * Postgres over Hyperdrive — and this package stays free of every one of them.
 *
 * The statements the stores emit are SQLite-shaped (`ON CONFLICT … DO UPDATE`,
 * `CREATE INDEX IF NOT EXISTS`, `?` placeholders), so the executor must front a
 * SQLite engine — a Durable Object, D1, or `node:sqlite`.
 * @experimental
 */

import { LunoraError } from "@lunora/errors";

import { isBareIdentifier } from "../../../../shared/bare-identifier";

/**
 * Run one statement and return its rows.
 *
 * Rows come back as plain objects keyed by column name — the shape
 * `SqlStorage#exec().toArray()`, D1's `.all().results`, and `postgres.js` all
 * already produce. A statement returning nothing yields an empty array.
 *
 * May be synchronous: a Durable Object's SQLite is, and forcing it through a
 * promise would add a microtask per row batch for nothing.
 */
type RagSqlExec = (sql: string, parameters: ReadonlyArray<unknown>) => Promise<ReadonlyArray<Record<string, unknown>>> | ReadonlyArray<Record<string, unknown>>;

/** A comma-separated `?` placeholder list for `count` bound parameters. */
const placeholderList = (count: number): string => Array.from<string>({ length: count }).fill("?").join(", ");

/**
 * How many values one `IN (…)` list may spend on placeholders.
 *
 * Workerd caps `SQLITE_MAX_VARIABLE_NUMBER` at **100** per statement on both
 * Durable Object storage and D1 — the two backends these stores target — and
 * exceeding it is a prepare-time `too many SQL variables` failure, not a slow
 * query. 64 leaves headroom for the namespace binding and anything else the
 * same statement carries.
 *
 * `node:sqlite` (what the tests run on) is built with the stock 32 766 cap and
 * cannot reproduce the limit, so the guard is the batching itself plus the
 * assertions on rendered SQL — not an integration test that would pass either
 * way.
 */
const IN_LIST_BUDGET = 64;

/**
 * Split `items` into slices of at most `budget` entries, so each becomes one
 * statement that stays under the placeholder cap. An empty input yields no
 * slices.
 * @param items the values to batch
 * @param budget entries per slice; lower it when each entry costs more than one placeholder (a multi-row `VALUES` list spends one per column)
 */
const inListBatches = <T>(items: ReadonlyArray<T>, budget: number = IN_LIST_BUDGET): T[][] => {
    const size = Math.max(1, Math.floor(budget));
    const batches: T[][] = [];

    for (let start = 0; start < items.length; start += size) {
        batches.push(items.slice(start, start + size));
    }

    return batches;
};

/**
 * Reject an identifier that is not a bare `[A-Za-z_][A-Za-z0-9_]*` name.
 *
 * The test itself lives in `shared/bare-identifier.ts` — it is the sole defense
 * against identifier injection wherever a name is spliced into raw SQL, so it has
 * one definition across the three packages that need it. The message stays here,
 * because it names this package's option.
 */
const assertSafeIdentifier = (name: string, label: string): string => {
    if (!isBareIdentifier(name)) {
        throw new TypeError(`@lunora/ai/rag: ${label} must be a bare SQL identifier (letters, digits, underscore; not starting with a digit) — got "${name}"`);
    }

    return name;
};

/**
 * Cosine similarity of two equal-length vectors; `0` when either has no magnitude.
 *
 * Unequal widths are an ERROR, not a score of 0. Returning 0 made a dimension
 * mismatch invisible in the worst possible way: every row in the namespace tied
 * at 0, so the ranking degenerated to table order and `query` returned the first
 * `topK` rows — unrelated passages, with no error, straight into the model's
 * context. That is what changing an index's `embeddingModel` without reindexing
 * looked like from the outside.
 */
const cosineSimilarity = (left: ReadonlyArray<number>, right: ReadonlyArray<number>): number => {
    if (left.length !== right.length) {
        throw new LunoraError(
            "RAG_DIMENSION_MISMATCH",
            `@lunora/ai/rag: the stored vectors are ${String(right.length)}-dimension but the query embedding is ${String(left.length)}-dimension — ` +
                "they were written by a different embedding model. Restore the previous `embeddingModel`, or reindex this namespace (bump `embeddingModelVersion`)",
        );
    }

    if (left.length === 0) {
        return 0;
    }

    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;

    for (const [index, leftValue] of left.entries()) {
        const rightValue = right[index] as number;

        dot += leftValue * rightValue;
        leftNorm += leftValue * leftValue;
        rightNorm += rightValue * rightValue;
    }

    const magnitude = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);

    return magnitude === 0 ? 0 : dot / magnitude;
};

/**
 * Parse a JSON column that may already have been decoded by the driver.
 *
 * Returns `unknown` on purpose: what a column holds is a runtime fact, so a
 * generic here would only let a caller assert a type this cannot check.
 */
const readJsonColumn = (value: unknown): unknown => {
    if (value === undefined || value === null) {
        return undefined;
    }

    if (typeof value === "string") {
        try {
            return JSON.parse(value);
        } catch {
            return undefined;
        }
    }

    return value;
};

export type { RagSqlExec };
export { assertSafeIdentifier, cosineSimilarity, IN_LIST_BUDGET, inListBatches, placeholderList, readJsonColumn };
