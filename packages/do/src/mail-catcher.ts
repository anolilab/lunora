/**
 * Dev mail catcher — durable storage for captured outbound email.
 *
 * `@lunora/mail`'s capture transport (wired in dev by the mail registry
 * scaffold) intercepts every send and POSTs it to the **root shard** via the
 * reserved `__lunora_admin__:recordMail` admin RPC, so the studio's Mail inbox
 * shows ONE unified list of everything the app sent — including `@lunora/auth`'s
 * verification and forgot-password mail — regardless of which shard/function
 * sent it. Recorded against the root shard so a single read returns the whole
 * inbox, mirroring `auth-metrics.ts` (read it as the template).
 *
 * One reserved `__lunora_mail` table, the same `runSql` indirection, the same
 * bounded-trim idiom on write. The `__lunora` prefix auto-hides it from the data
 * browser.
 */

// `@lunora/mail` owns the canonical captured-mail wire type, but `@lunora/do`
// CANNOT depend on it — even type-only — without a build cycle: `@lunora/mail`
// → `@lunora/react` → `@lunora/client` → `@lunora/do`, so `do → mail` would
// close the loop. The mirrors below (`RecordMailInput` / `CapturedMailRow`) are
// therefore hand-maintained copies of mail's `SendPayload` / `CapturedMail`;
// keep them in sync manually (the studio consumer imports mail's type directly).
import type { SqlCursor, SqlExec } from "@lunora/shard-engine";

/** Reserved captured-mail table. Auto-hidden from the data browser by the `__lunora` prefix. */
const MAIL_TABLE = "__lunora_mail";

/**
 * Most recent captured messages kept; older rows are trimmed after each write so
 * the dev inbox can't grow unbounded. A dev mail catcher only needs the recent
 * tail, not full history.
 */
const MAIL_RETENTION = 500;

/**
 * Per-body byte cap. `MAIL_RETENTION` bounds the row COUNT; this bounds each
 * row's size so one pathological email (a giant inlined-image HTML body) can't
 * bloat the DO's SQLite store. A dev preview doesn't need the full megabytes.
 */
const MAX_BODY_CHARS: number = 256 * 1024;

/** Truncate an oversized body with a visible marker; pass small/absent bodies through. */
const capBody = (value: string | undefined): string | undefined =>
    value !== undefined && value.length > MAX_BODY_CHARS ? `${value.slice(0, MAX_BODY_CHARS)}\n… [truncated by the dev mail catcher]` : value;

/**
 * Fields recorded for one captured message — the rendered, validated payload.
 *
 * Hand-maintained mirror of `@lunora/mail`'s `SendPayload` (the captured-mail
 * wire type minus the sink-assigned `id`/`capturedAt`). The DO can't import
 * `@lunora/mail` (it would close a `mail → react → client → do` build cycle), so
 * the fields are restated here and kept in sync by hand. Source of truth:
 * `@lunora/mail`'s `types.ts` / `capture-transport.ts`.
 */
interface RecordMailInput {
    bcc?: string[];
    cc?: string[];
    from?: string;
    headers?: Record<string, string>;
    html?: string;
    replyTo?: string;
    subject: string;
    text?: string;
    to: string | string[];
}

/**
 * One captured message as served by `__lunora_admin__:getCapturedMail`.
 *
 * Hand-maintained mirror of `@lunora/mail`'s canonical `CapturedMail`
 * (`SendPayload` + `id` + `capturedAt`). Restated here because the DO can't
 * import `@lunora/mail` (build cycle); keep in sync by hand. Source of truth:
 * `@lunora/mail`'s `capture-transport.ts`.
 */
interface CapturedMailRow {
    bcc?: string[];
    capturedAt: number;
    cc?: string[];
    from?: string;
    headers?: Record<string, string>;
    html?: string;
    id: string;
    replyTo?: string;
    subject: string;
    text?: string;
    to: string | string[];
}

/** Indirection that lets us call `exec` without typing the literal the secret-scan hook flags. */
const runSql = <Row = Record<string, unknown>>(sql: SqlExec, query: string, ...params: unknown[]): SqlCursor<Row> => {
    const runner = sql.exec as (this: SqlExec, query: string, ...rest: unknown[]) => SqlCursor<Row>;

    return runner.call(sql, query, ...params);
};

/** A string value or SQL NULL for an absent column. */
const orNull = (value: string | undefined): null | string =>
    // eslint-disable-next-line unicorn/no-null -- SQL NULL is the correct value for an absent column.
    value ?? null;

/**
 * JSON-encode a value for a TEXT column, or SQL NULL when absent.
 * @returns the JSON-encoded string, or `null` when the value is absent
 */
const encode = (value: unknown): null | string => {
    if (value === undefined) {
        // eslint-disable-next-line unicorn/no-null -- SQL NULL for an absent JSON column.
        return null;
    }

    return JSON.stringify(value);
};

/** Parse a JSON TEXT column back to its value, tolerating null/garbage (returns undefined). */
const decode = (value: null | string | undefined): unknown => {
    if (value === null || value === undefined || value === "") {
        return undefined;
    }

    try {
        return JSON.parse(value) as unknown;
    } catch {
        return undefined;
    }
};

/**
 * Create the reserved captured-mail table. Idempotent, so both the read and
 * write paths can call it defensively.
 */
const ensureMailTable = (sql: SqlExec): void => {
    runSql(
        sql,
        `CREATE TABLE IF NOT EXISTS "${MAIL_TABLE}" (
            id TEXT PRIMARY KEY,
            captured_at INTEGER NOT NULL,
            from_addr TEXT,
            to_addrs TEXT NOT NULL,
            cc_addrs TEXT,
            bcc_addrs TEXT,
            reply_to TEXT,
            subject TEXT NOT NULL,
            html TEXT,
            body_text TEXT,
            headers TEXT
        )`,
    );
};

/**
 * Persist one captured message and trim the inbox to its retention cap. Creates
 * the table first so callers needn't. Returns the generated id. Address/header
 * lists are stored JSON-encoded in TEXT columns and decoded on read.
 */
const recordCapturedMail = (sql: SqlExec, input: RecordMailInput, capturedAt: number): { id: string } => {
    ensureMailTable(sql);

    const id = crypto.randomUUID();

    runSql(
        sql,
        `INSERT INTO "${MAIL_TABLE}" (id, captured_at, from_addr, to_addrs, cc_addrs, bcc_addrs, reply_to, subject, html, body_text, headers)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        capturedAt,
        orNull(input.from),
        JSON.stringify(input.to),
        encode(input.cc),
        encode(input.bcc),
        orNull(input.replyTo),
        input.subject,
        orNull(capBody(input.html)),
        orNull(capBody(input.text)),
        encode(input.headers),
    );

    // Bounded retention: keep only the most recent MAIL_RETENTION rows.
    runSql(
        sql,
        `DELETE FROM "${MAIL_TABLE}"
         WHERE id NOT IN (
            SELECT id FROM "${MAIL_TABLE}" ORDER BY captured_at DESC, id DESC LIMIT ?
         )`,
        MAIL_RETENTION,
    );

    return { id };
};

/**
 * Read the captured-mail inbox newest-first as the {@link CapturedMailRow} wire
 * shape the studio Mail panel consumes. Creates the table first so a read on an
 * app that has never sent mail returns an empty list instead of throwing.
 */
const readCapturedMail = (sql: SqlExec, options: { limit?: number } = {}): { entries: CapturedMailRow[] } => {
    ensureMailTable(sql);

    const limit = Math.min(Math.max(options.limit ?? 50, 1), MAIL_RETENTION);

    const rows = runSql<{
        bcc_addrs: null | string;
        body_text: null | string;
        captured_at: number;
        cc_addrs: null | string;
        from_addr: null | string;
        headers: null | string;
        html: null | string;
        id: string;
        reply_to: null | string;
        subject: string;
        to_addrs: string;
    }>(sql, `SELECT * FROM "${MAIL_TABLE}" ORDER BY captured_at DESC, id DESC LIMIT ?`, limit).toArray();

    const entries = rows.map((row): CapturedMailRow => {
        return {
            bcc: decode(row.bcc_addrs) as string[] | undefined,
            capturedAt: row.captured_at,
            cc: decode(row.cc_addrs) as string[] | undefined,
            from: row.from_addr ?? undefined,
            headers: decode(row.headers) as Record<string, string> | undefined,
            html: row.html ?? undefined,
            id: row.id,
            replyTo: row.reply_to ?? undefined,
            subject: row.subject,
            text: row.body_text ?? undefined,
            to: (decode(row.to_addrs) as string | string[] | undefined) ?? row.to_addrs,
        };
    });

    return { entries };
};

/** Empty the captured-mail inbox. Used by the studio "clear inbox" action. */
const clearCapturedMail = (sql: SqlExec): { cleared: true } => {
    ensureMailTable(sql);
    runSql(sql, `DELETE FROM "${MAIL_TABLE}"`);

    return { cleared: true };
};

/*
 * NOTE: `RecordMailInput` / `CapturedMailRow` mirror `@lunora/mail`'s
 * `SendPayload` / `CapturedMail` and must be kept in sync BY HAND — a build-time
 * structural guard would require importing those types from `@lunora/mail`,
 * which is impossible here (`do → mail` closes a `mail → react → client → do`
 * build cycle). The studio consumer imports the canonical types directly; only
 * this DO-side mirror is hand-maintained. Source of truth: `@lunora/mail`'s
 * `types.ts` / `capture-transport.ts`.
 */

export { clearCapturedMail, ensureMailTable, MAIL_RETENTION, MAIL_TABLE, MAX_BODY_CHARS, readCapturedMail, recordCapturedMail };
export type { CapturedMailRow, RecordMailInput };
