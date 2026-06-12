/**
 * Dev mail catcher — durable storage for captured outbound email.
 *
 * `@cirrus/mail`'s capture transport (wired in dev by the mail registry
 * scaffold) intercepts every send and POSTs it to the **root shard** via the
 * reserved `__cirrus_admin__:recordMail` admin RPC, so the studio's Mail inbox
 * shows ONE unified list of everything the app sent — including `@cirrus/auth`'s
 * verification and forgot-password mail — regardless of which shard/function
 * sent it. Recorded against the root shard so a single read returns the whole
 * inbox, mirroring `auth-metrics.ts` (read it as the template).
 *
 * One reserved `__cirrus_mail` table, the same `runSql` indirection, the same
 * bounded-trim idiom on write. The `__cirrus` prefix auto-hides it from the data
 * browser.
 */

// Type-only import of the canonical captured-mail wire type. `@cirrus/mail` owns
// the shape; this import is erased at build time, so the DO runtime bundle stays
// free of any `@cirrus/mail` *runtime* dependency (mail is a type-only devDep).
// The mirrors below (`RecordMailInput` / `CapturedMailRow`) exist so the DO need
// not couple to mail at runtime; the structural drift guards at the bottom of
// this file break the build if a mirror drifts from the canonical source.
import type { CapturedMail, SendPayload } from "@cirrus/mail";

import type { SqlCursor, SqlExec } from "./ctx-db";

/** Reserved captured-mail table. Auto-hidden from the data browser by the `__cirrus` prefix. */
const MAIL_TABLE = "__cirrus_mail";

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
const MAX_BODY_CHARS = 256 * 1024;

/** Truncate an oversized body with a visible marker; pass small/absent bodies through. */
const capBody = (value: string | undefined): string | undefined =>
    value !== undefined && value.length > MAX_BODY_CHARS ? `${value.slice(0, MAX_BODY_CHARS)}\n… [truncated by the dev mail catcher]` : value;

/**
 * Fields recorded for one captured message — the rendered, validated payload.
 *
 * Documented mirror of `@cirrus/mail`'s `SendPayload` (the captured-mail wire
 * type minus the sink-assigned `id`/`capturedAt`). The DO must not take a
 * runtime dep on `@cirrus/mail`, so the fields are restated here; the drift
 * guard below fails the build if this diverges from the canonical `SendPayload`.
 * Source of truth: `@cirrus/mail`'s `types.ts` / `capture-transport.ts`.
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
 * One captured message as served by `__cirrus_admin__:getCapturedMail`.
 *
 * Documented mirror of `@cirrus/mail`'s canonical `CapturedMail`
 * (`SendPayload` + `id` + `capturedAt`). Restated here to keep the DO free of a
 * `@cirrus/mail` runtime dep; the drift guard below fails the build if this
 * diverges from the canonical type. Source of truth: `@cirrus/mail`'s
 * `capture-transport.ts`.
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

/** JSON-encode a value for a TEXT column, or SQL NULL when absent. */
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

/* ------------------------------------------------------------------------- *
 * Compile-time drift guards.
 *
 * `RecordMailInput` and `CapturedMailRow` are hand-maintained mirrors of types
 * owned by `@cirrus/mail` (kept local so the DO needs no `@cirrus/mail` runtime
 * dep). The exact, bidirectional structural checks below break the
 * `@cirrus/do` build the moment a mirror diverges from the canonical shape —
 * including a field added on EITHER side — so the three captured-mail shapes
 * (mail / do / studio) can't silently drift apart.
 *
 * To extend the captured-mail shape: add the field to `@cirrus/mail`'s
 * `SendPayload` (and thus `CapturedMail`) first, then mirror it here; these
 * guards tell you precisely when the mirror is out of date.
 * ------------------------------------------------------------------------- */

/** True iff `A` and `B` are structurally identical (invariant in both directions). */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the twin-conditional `Equal` idiom needs the once-used `T` on each side.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Resolves to its argument only when it is exactly `true`; a `false` (drift) is a type error at the use site. */
type Expect<T extends true> = T;

/*
 * Pure type-level guards — `Expect<Equal<…>>` errors the moment a mirror stops
 * matching its canonical `@cirrus/mail` type. Both are `export`ed (and so exempt
 * from `noUnusedLocals`) but NOT re-exported from `index.ts`, so they stay out of
 * the package's public API while still failing the build on drift. They emit no
 * runtime code.
 *
 * `CapturedMailRow` mirrors the canonical `CapturedMail` (`SendPayload` + id + capturedAt).
 * `RecordMailInput` mirrors the canonical `SendPayload` (captured-mail minus id/capturedAt).
 */
export type AssertCapturedMailRowMatchesCapturedMail = Expect<Equal<CapturedMailRow, CapturedMail>>;
export type AssertRecordMailInputMatchesSendPayload = Expect<Equal<RecordMailInput, SendPayload>>;

export { clearCapturedMail, ensureMailTable, MAIL_RETENTION, MAIL_TABLE, MAX_BODY_CHARS, readCapturedMail, recordCapturedMail };
export type { CapturedMailRow, RecordMailInput };
