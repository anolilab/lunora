/**
 * Per-query D1 cost accounting.
 *
 * D1 returns `rows_read` / `rows_written` / `duration` in the `meta` object of
 * every result, and until this module existed every one of those numbers was
 * thrown away at the exec boundary. That is the one measurement that explains a
 * D1 bill, because **rows read counts rows SCANNED, not rows returned**: a query
 * filtering on an unindexed column scans the table to find its subset, so a
 * query that cost 200 rows against a small table costs 200k once the table
 * grows. Nothing deployed, and the cost went up a thousandfold — which is
 * exactly the shape of "usage spiked and no code changed".
 *
 * The dashboard's own `rowsRead` metric is per-DATABASE, so it can tell you the
 * total moved but never which query moved it. Tagging each query is what turns
 * "D1 reads spiked" into a single culprit, so the tag is the point of this
 * module and {@link d1QueryTag} keeps it deliberately low-cardinality:
 * `select:users`, never the rendered SQL with its literals, or the tag space
 * grows once per distinct parameter value and groups by nothing.
 */

/** Stable tag on every emitted event so a Logpush/SIEM consumer can filter these out of the raw Workers-trace firehose. Matches the request log's envelope. */
const D1_EVENT_SOURCE = "lunora";

/** Discriminator paired with {@link D1_EVENT_SOURCE}. */
const D1_EVENT_TYPE = "d1_query";

/**
 * Leading SQL keywords worth naming in a tag. Anything else collapses to
 * `other`, which keeps a stray `PRAGMA`/`EXPLAIN` from minting its own tag
 * shape without hiding that it ran.
 */
const TAGGED_VERBS = new Set(["delete", "insert", "select", "update"]);

/** Table token following `FROM` / `INTO` / `UPDATE`, optionally quoted. Module scope: this runs once per query, so it must not be recompiled per call. */
const TABLE_TOKEN_PATTERN = /\b(?:from|into|update)\s+["`[]?(?<table>[a-z_][\w$]*)/iu;

/** Leading SQL verb of a statement. Module scope for the same reason as {@link TABLE_TOKEN_PATTERN}. */
const LEADING_VERB_PATTERN = /^\s*(?<verb>[a-z]+)/iu;

/**
 * The table a statement names, as the token following `FROM` / `INTO` /
 * `UPDATE`. Deliberately a token scan rather than a parse: the tag only has to
 * be stable and human-recognisable, and a full SQL parser on every query would
 * cost more than the accounting it labels.
 */
const tableToken = (sql: string): string | undefined => {
    const match = TABLE_TOKEN_PATTERN.exec(sql);

    return match?.groups?.["table"]?.toLowerCase();
};

/**
 * Derive a low-cardinality tag for a rendered statement — `select:users`,
 * `insert:orders`, `select:unknown` when no table token is recognisable.
 *
 * Cardinality is the whole design constraint. The rendered SQL is unique per
 * shape and near-unique per call site, so grouping on it produces a tag space
 * that grows without bound and answers nothing; verb + table is the coarsest
 * label that still points at a specific culprit.
 */
const d1QueryTag = (sql: string): string => {
    const verbMatch = LEADING_VERB_PATTERN.exec(sql);
    const verb = verbMatch?.groups?.["verb"]?.toLowerCase() ?? "";
    const table = tableToken(sql);

    if (!TAGGED_VERBS.has(verb)) {
        return table === undefined ? "other" : `other:${table}`;
    }

    return `${verb}:${table ?? "unknown"}`;
};

/** One statement's cost, read off D1's `meta`. */
interface D1QueryCost {
    /** D1's own server-side duration in ms, when reported. */
    durationMs?: number;
    /** Rows D1 SCANNED — the billed number, and the one a missing index inflates. */
    rowsRead: number;
    /** Rows written by a DML statement; `0` for reads. */
    rowsWritten: number;
}

/** Coerce one `meta` field to a finite number, tolerating an absent or non-numeric value from a test double. */
const metaNumber = (meta: Record<string, unknown> | undefined, key: string): number | undefined => {
    const value = meta?.[key];

    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

/**
 * Project D1's `meta` onto {@link D1QueryCost}, or `undefined` when the result
 * carried no usable accounting — a test double, or a `batch()` leg that reports
 * none. Callers skip the emit entirely in that case rather than logging zeroes,
 * which would read as "this query was free".
 */
const readD1QueryCost = (meta: Record<string, unknown> | undefined): D1QueryCost | undefined => {
    const rowsRead = metaNumber(meta, "rows_read");
    const rowsWritten = metaNumber(meta, "rows_written");

    if (rowsRead === undefined && rowsWritten === undefined) {
        return undefined;
    }

    const duration = metaNumber(meta, "duration");

    return {
        ...(duration === undefined ? {} : { durationMs: duration }),
        rowsRead: rowsRead ?? 0,
        rowsWritten: rowsWritten ?? 0,
    };
};

/**
 * Emit one structured cost event per D1 statement into Workers Logs, so
 * "D1 reads spiked" resolves to a tag by group-by.
 *
 * Best-effort by contract, exactly like the request-log emit: a serialization
 * hiccup must never turn a served query into a failed one, so the caller wraps
 * this and swallows. Emitting one line per D1 statement is proportionate —
 * every one of them is already a network round trip, so the line is noise-free
 * next to the work it describes.
 *
 * The SQL text itself is NEVER emitted: it carries inlined literals on some
 * render paths, and the tag is the groupable thing anyway.
 */
const emitD1QueryCost = (sql: string, meta: Record<string, unknown> | undefined): void => {
    const cost = readD1QueryCost(meta);

    if (cost === undefined) {
        return;
    }

    const line = JSON.stringify({
        durationMs: cost.durationMs,
        rowsRead: cost.rowsRead,
        rowsWritten: cost.rowsWritten,
        source: D1_EVENT_SOURCE,
        tag: d1QueryTag(sql),
        type: D1_EVENT_TYPE,
    });

    // eslint-disable-next-line no-console -- intentional structured event emission into CF Workers Logs / Logpush, mirroring the request-log emit.
    console.log(line);
};

export type { D1QueryCost };
export { d1QueryTag, emitD1QueryCost, readD1QueryCost };
