/**
 * Classifying a `ctx.sql` statement for telemetry — the only thing the
 * instrumenter ever reads from the statement text.
 */

/**
 * The leading SQL keywords `ctx.sql` reports as `db.operation.name`. An
 * allowlist, not "whatever the first word is": the operation lands in a span
 * name and a summary key, both of which must stay low-cardinality, and a
 * statement that opens with something unexpected is reported as `OTHER`
 * rather than minting a new group. `WITH` is reported as-is — finding the
 * statement a CTE feeds would mean parsing past it, which this deliberately
 * never does.
 */
const SQL_OPERATIONS = new Set([
    "ALTER",
    "ANALYZE",
    "BEGIN",
    "CALL",
    "COMMIT",
    "COPY",
    "CREATE",
    "DEALLOCATE",
    "DELETE",
    "DESCRIBE",
    "DO",
    "DROP",
    "EXECUTE",
    "EXPLAIN",
    "GRANT",
    "INSERT",
    "LISTEN",
    "LOCK",
    "MERGE",
    "NOTIFY",
    "PREPARE",
    "REFRESH",
    "RELEASE",
    "REPLACE",
    "REVOKE",
    "ROLLBACK",
    "SAVEPOINT",
    "SELECT",
    "SET",
    "SHOW",
    "START",
    "TABLE",
    "TRUNCATE",
    "UNLISTEN",
    "UPDATE",
    "VACUUM",
    "VALUES",
    "WITH",
]);

/** `db.operation.name` for a statement whose leading keyword is not in {@link SQL_OPERATIONS}. */
const SQL_OPERATION_OTHER = "OTHER";

/** One leading keyword — applied to a bounded slice, so it never scans the statement. */
const SQL_KEYWORD = /^[a-z]+/iu;

/**
 * The statement's operation, from its LEADING keyword only (`SELECT`, `INSERT`,
 * …, else `OTHER`).
 *
 * Skips leading whitespace, `--` line comments, `/* … *\/` block comments (a
 * driver or ORM often prepends one) and opening parentheses, then reads one
 * keyword. Nothing past that keyword is examined, so no literal, identifier or
 * parameter from the statement can reach a span — the cheap parse is also the
 * safe one. A linear scan rather than a regex so a pathological comment run
 * cannot backtrack.
 */
const sqlOperationName = (text: unknown): string => {
    if (typeof text !== "string") {
        return SQL_OPERATION_OTHER;
    }

    let index = 0;

    while (index < text.length) {
        const char = text.charAt(index);

        if (char === "(" || char.trim() === "") {
            index += 1;
        } else if (text.startsWith("--", index)) {
            const end = text.indexOf("\n", index);

            if (end === -1) {
                return SQL_OPERATION_OTHER;
            }

            index = end + 1;
        } else if (text.startsWith("/*", index)) {
            const end = text.indexOf("*/", index + 2);

            if (end === -1) {
                return SQL_OPERATION_OTHER;
            }

            index = end + 2;
        } else {
            break;
        }
    }

    const keyword = SQL_KEYWORD.exec(text.slice(index, index + 16))?.[0].toUpperCase();

    return keyword !== undefined && SQL_OPERATIONS.has(keyword) ? keyword : SQL_OPERATION_OTHER;
};

/**
 * OTel `db.system.name` for a `ctx.sql` client: whatever its driver adapter
 * stamped (`fromPostgresJs` / `fromNodePg` → `postgresql`, `fromMysql2` →
 * `mysql`), else the semconv's `other_sql` for a hand-built client that did not
 * say.
 */
const sqlSystemOf = (stampedSystem: string | undefined): string => stampedSystem ?? "other_sql";

export { sqlOperationName, sqlSystemOf };
