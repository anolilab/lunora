/**
 * The injected SQL seam the durable RAG stores share.
 *
 * `@lunora/ai` depends on no database. A store is handed an executor instead,
 * so the same adapter runs on a Durable Object's SQLite, D1, `node:sqlite`, or
 * Postgres over Hyperdrive — and this package stays free of every one of them.
 *
 * The two supported placeholder styles are the only dialect difference the
 * stores need: SQLite and D1 bind positionally with `?`, Postgres with `$1`.
 * @experimental
 */

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

/** Which placeholder style {@link RagSqlExec} binds. */
type RagSqlDialect = "postgres" | "sqlite";

/**
 * Build the placeholder for the `index`-th (0-based) bound parameter.
 *
 * Centralised because getting it wrong is not a type error and not a test
 * failure on the dialect you developed against — it is a runtime error on the
 * other one.
 */
const placeholder = (dialect: RagSqlDialect, index: number): string => (dialect === "postgres" ? `$${String(index + 1)}` : "?");

/** A comma-separated placeholder list for `count` parameters starting at `offset`. */
const placeholderList = (dialect: RagSqlDialect, count: number, offset = 0): string =>
    Array.from({ length: count }, (_, index) => placeholder(dialect, offset + index)).join(", ");

/** A bare SQL identifier: letters, digits and underscore, not starting with a digit. */
const BARE_IDENTIFIER = /^[A-Z_]\w*$/i;

/**
 * Reject an identifier that is not a bare `[A-Za-z_][A-Za-z0-9_]*` name.
 *
 * Table names cannot be bound as parameters, so they are interpolated into the
 * statement — which makes them the one injection surface these stores have.
 * The allowlist is deliberately narrower than what SQL permits: a caller who
 * needs a quoted or schema-qualified name should be told so at construction,
 * not have their input concatenated in.
 */
const assertSafeIdentifier = (name: string, label: string): string => {
    if (!BARE_IDENTIFIER.test(name)) {
        throw new TypeError(`@lunora/ai/rag: ${label} must be a bare SQL identifier (letters, digits, underscore; not starting with a digit) — got "${name}"`);
    }

    return name;
};

/** Cosine similarity of two equal-length vectors; `0` when either has no magnitude. */
const cosineSimilarity = (left: ReadonlyArray<number>, right: ReadonlyArray<number>): number => {
    if (left.length !== right.length || left.length === 0) {
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

export type { RagSqlDialect, RagSqlExec };
export { assertSafeIdentifier, cosineSimilarity, placeholder, placeholderList, readJsonColumn };
