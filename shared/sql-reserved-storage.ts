/**
 * Finds a reference to reserved framework storage in a SQL statement, for the
 * read-only console gate (`shared/sql-readonly.ts`).
 *
 * Reserved storage is the named-admin-token table and the SQLite table-valued
 * functions that read the schema or raw pages (`pragma_*`, `dbstat`,
 * `sqlite_dbpage`). The check runs over IDENTIFIERS only, from a real tokenizer:
 * comments and string literals are skipped, so data that merely mentions one of
 * these words is not refused, and every spelling SQLite accepts for the same
 * identifier (`x`, `"x"`, `` `x` ``, `[x]`, any case) is read as the one name.
 *
 * One quirk keeps string literals from being skipped outright: SQLite accepts
 * `'name'` as an identifier in more places than can be listed (after `FROM`,
 * `JOIN`, a comma that continues a join list past `ON`, `USING`, an alias or
 * `INDEXED BY`, after a `.`), and no SQLite authorizer is available to ask. So the
 * check does not enumerate positions: a literal whose WHOLE content, trimmed and
 * case-folded, is a reserved name is refused wherever it stands. A literal that
 * merely contains one (`LIKE '%pragma_%'`, `'pragma_level is high'`) is data.
 *
 * Fails closed: a quote or block comment that never closes returns the first
 * reserved name found anywhere in the remaining text, quotes removed, rather than
 * trusting a scan that cannot tell where the literal ends.
 *
 * Zero-dependency, like the other `shared/` SQL helpers: the DO and the browser
 * both inline it.
 */
import { ADMIN_TOKEN_TABLE } from "./admin-token-table";

const RESERVED_NAMES = new Set([ADMIN_TOKEN_TABLE, "dbstat", "sqlite_dbpage"]);

const RESERVED_PREFIX = "pragma_";

const isWordStart = (char: string): boolean => /[\p{L}_]/u.test(char) || (char.codePointAt(0) ?? 0) > 127;

const isWordChar = (char: string): boolean => /[\p{L}\p{N}_$]/u.test(char) || (char.codePointAt(0) ?? 0) > 127;

/** A whole literal that is a `pragma_*` table-valued function name. */
const PRAGMA_FUNCTION = /^pragma_\w+$/u;

/** Matches a quoted-literal's `name` (trimmed, lower-cased) against the reserved set; an exact name, not a substring. */
const reservedLiteralOf = (name: string): string | undefined => (RESERVED_NAMES.has(name) || PRAGMA_FUNCTION.test(name) ? name : undefined);

/** Matches `name` (already lower-cased) against the reserved set. */
const reservedNameOf = (name: string): string | undefined => {
    if (RESERVED_NAMES.has(name) || name.startsWith(RESERVED_PREFIX)) {
        return name;
    }

    return undefined;
};

/** Read a quoted run starting at `from` (the opening quote); `undefined` when it never closes. */
const readQuoted = (sql: string, from: number, close: string): undefined | { end: number; text: string } => {
    let text = "";
    let index = from + 1;

    while (index < sql.length) {
        const char = sql[index] as string;

        if (char === close) {
            // A doubled quote is an escaped quote; `]` has no escape.
            if (close !== "]" && sql[index + 1] === close) {
                text += close;
                index += 2;
                continue;
            }

            return { end: index + 1, text };
        }

        text += char;
        index += 1;
    }

    return undefined;
};

const QUOTE_CLOSERS: Readonly<Record<string, string>> = { '"': '"', "`": "`", "[": "]" };

/** Fail-closed fallback for text a tokenizer cannot finish: the old, quote-stripped substring scan. */
const scanUnterminated = (rest: string): string | undefined => {
    const folded = rest.toLowerCase().replaceAll(/["'`[\]]/gu, "");

    for (const name of RESERVED_NAMES) {
        if (folded.includes(name)) {
            return name;
        }
    }

    return /\bpragma_/u.test(folded) ? RESERVED_PREFIX : undefined;
};

/**
 * The reserved name `sql` refers to, lower-cased, or `undefined` when it refers to none.
 * @param sql a single statement
 */
const findReservedStorage = (sql: string): string | undefined => {
    let index = 0;

    while (index < sql.length) {
        const char = sql[index] as string;

        if (/\s/u.test(char)) {
            index += 1;
        } else if (char === "-" && sql[index + 1] === "-") {
            const newline = sql.indexOf("\n", index);

            index = newline === -1 ? sql.length : newline + 1;
        } else if (char === "/" && sql[index + 1] === "*") {
            const end = sql.indexOf("*/", index + 2);

            if (end === -1) {
                return scanUnterminated(sql.slice(index + 2));
            }

            index = end + 2;
        } else if (char === "'") {
            const literal = readQuoted(sql, index, "'");

            if (literal === undefined) {
                return scanUnterminated(sql.slice(index + 1));
            }

            const found = reservedLiteralOf(literal.text.trim().toLowerCase());

            if (found !== undefined) {
                return found;
            }

            index = literal.end;
        } else if (char in QUOTE_CLOSERS) {
            const identifier = readQuoted(sql, index, QUOTE_CLOSERS[char] as string);

            if (identifier === undefined) {
                return scanUnterminated(sql.slice(index + 1));
            }

            const found = reservedNameOf(identifier.text.toLowerCase());

            if (found !== undefined) {
                return found;
            }

            index = identifier.end;
        } else if (isWordStart(char)) {
            let end = index + 1;

            while (end < sql.length && isWordChar(sql[end] as string)) {
                end += 1;
            }

            const word = sql.slice(index, end).toLowerCase();
            const found = reservedNameOf(word);

            if (found !== undefined) {
                return found;
            }

            index = end;
        } else {
            index += 1;
        }
    }

    return undefined;
};

export { findReservedStorage };
