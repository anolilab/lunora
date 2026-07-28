/**
 * Schema-aware autocomplete logic for the read-only SQL editor — pure, so the
 * token extraction and ranking can be unit-tested without a DOM. The editor
 * sources its schema from the admin RPCs it already calls (`listTables` for
 * table names, `readTablePage`'s `columns` for per-table columns); this module
 * turns the current caret position into a ranked suggestion list and the span
 * of text a chosen suggestion should replace.
 */
import { sqlContextOf } from "./sql-context";

/** What a single suggestion stands for, so the dropdown can badge it. */
type SuggestionKind = "column" | "keyword" | "table";

/** One ranked completion candidate for the token under the caret. */
interface Suggestion {
    /** A table name for a column suggestion, so the dropdown can hint its origin. */
    readonly detail?: string;
    readonly kind: SuggestionKind;
    readonly label: string;
}

/**
 * The schema the editor knows about: every table name, and the columns probed
 * per table (only the tables the operator has expanded/queried are present, so
 * column coverage grows as they explore — table names are always complete).
 */
interface SqlSchema {
    /** Columns per table, keyed by table name. Missing table ⇒ columns not probed yet. */
    readonly columns: Readonly<Record<string, ReadonlyArray<string>>>;
    readonly tables: ReadonlyArray<string>;
}

/** The token under the caret plus the [start, end) span it occupies in the source. */
interface TokenSpan {
    readonly end: number;
    readonly start: number;
    readonly text: string;
}

/** Max suggestions shown at once — enough to be useful, short enough to scan. */
const MAX_SUGGESTIONS = 8;

/**
 * The SQL keywords offered as completions. Read-only editor, so this is the
 * SELECT/WITH/EXPLAIN vocabulary an operator actually types — not the full
 * dialect. Upper-cased to match the canonical rendering the Format button emits.
 */
const KEYWORDS: ReadonlyArray<string> = [
    "AND",
    "ASC",
    "AS",
    "BY",
    "COUNT",
    "DESC",
    "DISTINCT",
    "EXPLAIN",
    "FROM",
    "GROUP",
    "HAVING",
    "INNER",
    "JOIN",
    "LEFT",
    "LIKE",
    "LIMIT",
    "NOT",
    "NULL",
    "OFFSET",
    "ON",
    "ORDER",
    "OR",
    "QUERY",
    "SELECT",
    "WHERE",
    "WITH",
];

/** The SQL clauses after which a column reference is the likelier completion than a table. */
const COLUMN_CLAUSES = new Set<string>(["AND", "BY", "HAVING", "ON", "OR", "SELECT", "WHERE"]);

/** Matches a single identifier-body character (letters, digits, `_`, `$`). */
const WORD_CHAR = /[\w$]/;

/** A token character: an identifier body. The caret splits the token on anything else. */
const isWordChar = (char: string | undefined): boolean => char !== undefined && WORD_CHAR.test(char);

/** The trailing identifier of `text` (the run of word chars at its end), or `""` when it ends in punctuation/space. */
const trailingWord = (text: string): string => {
    let start = text.length;

    while (start > 0 && isWordChar(text[start - 1])) {
        start -= 1;
    }

    return text.slice(start);
};

/**
 * Find the identifier token the caret sits at the end of. Scans backward from
 * `caret` over word characters; the returned span is the contiguous run ending
 * at the caret, so accepting a suggestion replaces exactly what was typed. An
 * empty token (caret after whitespace/punctuation) yields a zero-width span at
 * the caret — callers treat that as "no active token" and show nothing.
 */
const tokenAt = (value: string, caret: number): TokenSpan => {
    let start = caret;

    while (start > 0 && isWordChar(value[start - 1])) {
        start -= 1;
    }

    return { end: caret, start, text: value.slice(start, caret) };
};

/**
 * Whether the caret is positioned where a column reference is the likelier
 * completion than a table — i.e. immediately after a `.` qualifier
 * (`messages.`) or after a clause that reads columns (`SELECT`, `WHERE`, `BY`,
 * `ON`, `AND`, `OR`, `HAVING`). Best-effort: it only re-orders the ranking, so
 * a miss still surfaces every candidate, just lower down.
 */
const prefersColumns = (value: string, start: number): boolean => {
    const before = value.slice(0, start).trimEnd();

    return before.endsWith(".") || COLUMN_CLAUSES.has(trailingWord(before).toUpperCase());
};

/**
 * The TABLE a `.` qualifier before the caret resolves to (`messages.|` ⇒
 * `messages`, and `m.|` ⇒ `messages` when the statement says `FROM messages m`).
 * `undefined` when the caret isn't qualified by a dotted prefix.
 *
 * Resolution goes through `sql-context.ts` — the same alias map the linter uses
 * — rather than treating the word before the dot as a table name. Reading the
 * bare word cannot see aliases, so `SELECT m.| FROM messages m` completed
 * nothing at all, while the linter (correctly) understood `m`. One resolver, so
 * the two features cannot disagree about what a qualifier means.
 */
const qualifierTable = (value: string, start: number, tables: ReadonlyArray<string>): string | undefined => {
    const before = value.slice(0, start);

    if (!before.endsWith(".")) {
        return undefined;
    }

    const name = trailingWord(before.slice(0, -1));

    if (name === "") {
        return undefined;
    }

    // An unresolved qualifier falls back to the literal name: the table may
    // simply not be in `tables` yet (the list loads asynchronously), and
    // offering its columns is better than offering nothing.
    return sqlContextOf(value, tables).targets.get(name.toLowerCase()) ?? name;
};

/** Case-insensitive prefix match; an empty needle matches everything (so a bare clause still offers candidates). */
const matches = (candidate: string, needle: string): boolean => candidate.toLowerCase().startsWith(needle.toLowerCase());

/**
 * Collect up to `max` prefix-matching names, stopping as soon as the cap is hit.
 * The final list is sliced to {@link MAX_SUGGESTIONS} anyway, so scanning a whole
 * many-thousand-object schema per keystroke is wasted work — this bounds it.
 */
const takeMatches = (names: ReadonlyArray<string>, needle: string, max: number, make: (name: string) => Suggestion): Suggestion[] => {
    const out: Suggestion[] = [];

    for (const name of names) {
        if (matches(name, needle)) {
            out.push(make(name));

            if (out.length >= max) {
                break;
            }
        }
    }

    return out;
};

/**
 * De-duped column matches across every probed table (first table wins as the
 * detail hint), bounded to `max`. Bounded like {@link takeMatches}: the empty-needle
 * case (a bare `SELECT `) would otherwise walk every column in the schema before
 * the caller slices the result down to a handful.
 */
const takeColumnMatches = (schema: SqlSchema, needle: string, max: number): Suggestion[] => {
    const seen = new Map<string, string>();

    for (const [table, columns] of Object.entries(schema.columns)) {
        for (const column of columns) {
            if (matches(column, needle) && !seen.has(column)) {
                seen.set(column, table);

                if (seen.size >= max) {
                    return [...seen].map(([column_, table_]) => {
                        return { detail: table_, kind: "column" as const, label: column_ };
                    });
                }
            }
        }
    }

    return [...seen].map(([column, table]) => {
        return { detail: table, kind: "column" as const, label: column };
    });
};

/**
 * Rank completions for the token under `caret` against `schema`. Tables, the
 * probed columns, and the keyword vocabulary are each prefix-filtered by the
 * typed token, then ordered: a `tbl.` qualifier restricts to that table's
 * columns; otherwise columns lead when the clause reads columns (and tables
 * lead when it reads tables), with keywords last. Exact-token matches and the
 * empty-token case are suppressed for keywords so typing a complete word
 * doesn't pop a one-item menu of itself. Capped at {@link MAX_SUGGESTIONS}.
 */
const suggestionsFor = (value: string, caret: number, schema: SqlSchema): Suggestion[] => {
    const span = tokenAt(value, caret);
    const qualifier = qualifierTable(value, span.start, schema.tables);

    // A dotted `tbl.` qualifier completes only that table's columns.
    if (qualifier !== undefined) {
        const owned = schema.columns[qualifier] ?? schema.columns[qualifier.toLowerCase()] ?? [];

        return takeMatches(owned, span.text, MAX_SUGGESTIONS, (column) => {
            return { detail: qualifier, kind: "column" as const, label: column };
        });
    }

    // An empty, unqualified token only completes after a column-reading clause —
    // otherwise every keystroke at a blank caret would pop the whole vocabulary.
    if (span.text === "" && !prefersColumns(value, span.start)) {
        return [];
    }

    // Each source is bounded to MAX_SUGGESTIONS — the final list never shows more,
    // so collecting beyond the cap is wasted work on a large schema.
    const tableHits = takeMatches(schema.tables, span.text, MAX_SUGGESTIONS, (table) => {
        return { kind: "table" as const, label: table };
    });
    const columnHits = takeColumnMatches(schema, span.text, MAX_SUGGESTIONS);

    const keywordHits: Suggestion[] = KEYWORDS.filter(
        (keyword) => span.text !== "" && matches(keyword, span.text) && keyword.toLowerCase() !== span.text.toLowerCase(),
    ).map((keyword) => {
        return { kind: "keyword" as const, label: keyword };
    });

    const ordered = prefersColumns(value, span.start) ? [...columnHits, ...tableHits, ...keywordHits] : [...tableHits, ...columnHits, ...keywordHits];

    return ordered.slice(0, MAX_SUGGESTIONS);
};

/**
 * Splice an accepted `suggestion` into `value` over the caret's token span,
 * returning the new text and the caret offset that should follow it (just past
 * the inserted label). Pure, so the editor's accept handler stays a one-liner.
 */
const acceptSuggestion = (value: string, caret: number, suggestion: Suggestion): { caret: number; value: string } => {
    const span = tokenAt(value, caret);
    const next = value.slice(0, span.start) + suggestion.label + value.slice(span.end);

    return { caret: span.start + suggestion.label.length, value: next };
};

export { acceptSuggestion, MAX_SUGGESTIONS, suggestionsFor, tokenAt };
export type { SqlSchema, Suggestion, SuggestionKind, TokenSpan };
