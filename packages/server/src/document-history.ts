/**
 * Row-version history — an append-only record of what a table's rows looked
 * like, written by the table's own triggers.
 *
 * `.triggers()` already fires on every insert/update/delete with the merged row
 * and the pre-write row in hand, which is exactly the pair a version history
 * needs. What was missing was somewhere to put them and the discipline about
 * what not to put there, so an app that wanted an audit trail, an undo stack, or
 * a GDPR "what did we hold about this person" export had to build all three.
 *
 * Like `definePresence` and `defineActionCache`, this is a preset over
 * primitives that already exist — the schema-extension system for the table, the
 * trigger builder for the write path — not a new subsystem.
 *
 * # Wiring
 *
 * ```ts
 * // lunora/history.ts
 * import { defineDocumentHistory } from "@lunora/server";
 *
 * export const history = defineDocumentHistory({ retentionMs: 90 * 24 * 60 * 60 * 1000 });
 *
 * // lunora/schema.ts — attach to each table you want versioned
 * const threads = defineTable({ ... }).triggers(history.record());
 *
 * export const schema = defineSchema({ threads }).extend(history.extension);
 *
 * // Re-export so codegen registers them (both internal — see below):
 * export const { listForDocument, vacuum } = history.functions;
 * ```
 *
 * # What it records, and what it cannot
 *
 * **Not who.** A trigger's context carries `db` and `scheduler` and no identity,
 * so an entry says what changed, when, and by which operation — never by whom.
 * Attributing a change needs the actor to reach the trigger, which is a change to
 * `TriggerCtx`, not something this preset can paper over. Recording an
 * unattributed trail and *calling* it an audit log would be worse than not having
 * one, so the field simply does not exist.
 *
 * **Redacted by default.** The point of keeping a snapshot is that it is readable
 * later, and a stored `hashedPassword` is a credential at rest — one that outlives
 * the rotation that was supposed to retire it. Secret-shaped fields are dropped
 * before the row is written; {@link DefineDocumentHistoryOptions.redact} extends
 * the list.
 *
 * **Reads are internal.** An entry is a full row snapshot, including columns the
 * table's own RLS would hide. `listForDocument` is registered as an internal
 * query so it cannot be called from a client; wrap it in your own procedure with
 * whatever authorization the surface needs.
 */

import { v } from "@lunora/values";

import { initLunora } from "./builder/index";
import type { Component, SchemaExtension } from "./plugin";
import { defineComponent, defineSchemaExtension } from "./plugin";
import { defineTable } from "./schema";
import type { RegisteredMutation, RegisteredQuery, TriggerBuilder, TriggerCtx as TriggerContext, TriggerDefinition } from "./types";

/** Default retention: 90 days. `vacuum` deletes entries older than this. */
const DEFAULT_RETENTION_MS: number = 90 * 24 * 60 * 60 * 1000;

/**
 * Default cap on one serialized snapshot (bytes). Past it the entry is still
 * written — that a row changed, and when, is the part an audit trail cannot
 * afford to lose — but the snapshot itself is dropped and `truncated` is set. A
 * history that silently skipped its largest rows would be worse than one that
 * says so.
 */
const DEFAULT_MAX_SNAPSHOT_BYTES = 64 * 1024;

/** Entries read/deleted per page. */
const PAGE = 200;

/** Pages `vacuum` will walk in one call, so a stuck read cannot spin forever. */
const MAX_VACUUM_ROUNDS = 64;

/**
 * Fields never written into a snapshot, whatever table they appear on.
 *
 * Names rather than types, because that is the only signal available here: a
 * trigger sees values, not the column metadata that would say "this one is a
 * secret". Extend it per app rather than relying on this list being complete.
 */
const DEFAULT_REDACTED_FIELDS: ReadonlyArray<string> = [
    "accessToken",
    "apiKey",
    "backupCodes",
    "clientSecret",
    "hashedPassword",
    "password",
    "privateKey",
    "refreshToken",
    "secret",
    "totpSecret",
];

/** The bare extension key and table name. Prefixing makes the merged table `documentHistory_versions`. */
const DOCUMENT_HISTORY_KEY = "documentHistory";
const DOCUMENT_HISTORY_BARE_TABLE = "versions";

/** The prefixed table name the extension produces at merge time. */
const DOCUMENT_HISTORY_TABLE: "documentHistory_versions" = `${DOCUMENT_HISTORY_KEY}_${DOCUMENT_HISTORY_BARE_TABLE}`;

/** One recorded version, as {@link DocumentHistoryFunctions.listForDocument} returns it. */
interface DocumentHistoryEntry {
    /** The row as it stood after the write, redacted. Absent for a delete, and when `truncated`. */
    doc?: Record<string, unknown>;
    /** The row this version belongs to. */
    documentId: string;
    /** Which write produced this version. */
    op: "delete" | "insert" | "update";
    /** The row as it stood before the write, redacted. Absent for an insert, and when `truncated`. */
    previous?: Record<string, unknown>;
    /** When the write happened (epoch ms). */
    recordedAt: number;
    /** The table the row lives in. */
    tableName: string;
    /** `true` when the snapshots were dropped for exceeding `maxSnapshotBytes`. */
    truncated?: boolean;
}

/** Options for {@link defineDocumentHistory}. */
interface DefineDocumentHistoryOptions {
    /**
     * Cap on one serialized snapshot (bytes). Past it the entry is written
     * without its snapshots and marked `truncated`. Defaults to 64 KB.
     */
    maxSnapshotBytes?: number;

    /**
     * Extra field names to drop from every snapshot, on top of the built-in
     * secret-shaped defaults.
     */
    redact?: ReadonlyArray<string>;

    /**
     * How long (ms) an entry is kept. `vacuum` deletes entries older than this.
     * Defaults to 90 days.
     */
    retentionMs?: number;
}

/** The registered functions a document-history component ships. */
interface DocumentHistoryFunctions {
    /**
     * **Internal** query: the recorded versions of one row, newest first.
     *
     * Internal because an entry is a full row snapshot, including columns the
     * table's own RLS hides — wrap it in a procedure of your own that applies
     * whatever authorization the surface needs.
     *
     * Pass `before` to read the history as of an instant: the first entry back is
     * the last version at or before it, which is what a point-in-time
     * reconstruction needs.
     */
    listForDocument: RegisteredQuery<
        { before: ReturnType<typeof v.optional>; documentId: ReturnType<typeof v.string>; limit: ReturnType<typeof v.optional> },
        DocumentHistoryEntry[]
    >;

    /**
     * Internal mutation that deletes entries older than the retention window,
     * oldest first, and reports how many it removed. Schedule it on a cron.
     *
     * Compare `deleted` against `limit` to decide whether to run again rather
     * than assuming one pass drained the backlog.
     */
    vacuum: RegisteredMutation<{ limit: ReturnType<typeof v.optional> }, { deleted: number }>;
}

/** The component shape {@link defineDocumentHistory} returns. */
type DocumentHistoryComponent = Component<{ [DOCUMENT_HISTORY_BARE_TABLE]: ReturnType<typeof defineTable> }> & {
    functions: DocumentHistoryFunctions;

    /**
     * The `.triggers(...)` argument that records this table's versions.
     *
     * `after*` on all three ops: a `before*` handler runs while the write can
     * still be aborted, and a history entry for a write that never happened is a
     * lie the reader has no way to detect.
     */
    record: () => (t: TriggerBuilder) => Record<string, TriggerDefinition>;
};

/**
 * The document-history schema extension: one `versions` table, auto-namespaced
 * to `documentHistory_versions` at merge time.
 */
// Explicit type on this exported const (isolatedDeclarations can't infer it from
// the generic call), matching `presenceExtension`.
const documentHistoryExtension = defineSchemaExtension(DOCUMENT_HISTORY_KEY, {
    tables: {
        [DOCUMENT_HISTORY_BARE_TABLE]: defineTable({
            doc: v.optional(v.string()),
            documentId: v.string(),
            op: v.string(),
            previous: v.optional(v.string()),
            recordedAt: v.number(),
            tableName: v.string(),
            truncated: v.optional(v.boolean()),
        })
            // Drives `listForDocument`, newest-first and optionally bounded by `before`.
            .index("byDocumentRecordedAt", ["documentId", "recordedAt"])
            // Drives `vacuum`'s oldest-first scan.
            .index("byRecordedAt", ["recordedAt"]),
    },
}) as unknown as SchemaExtension<{ [DOCUMENT_HISTORY_BARE_TABLE]: ReturnType<typeof defineTable> }>;

// No generated server here, so bind the base contexts via the builder factory —
// same as `definePresence`.
const { internalMutation, internalQuery } = initLunora.dataModel().create();

/**
 * Build a document-history {@link Component} — schema extension, the
 * `.triggers()` recorder, and the `listForDocument` / `vacuum` functions.
 * @param options history configuration (retention, redaction, snapshot cap).
 * @returns a component bundling the extension, the functions, and the recorder.
 */
const defineDocumentHistory = (options: DefineDocumentHistoryOptions = {}): DocumentHistoryComponent => {
    // `Number.isFinite` first: a `NaN`/`Infinity` option would otherwise flow
    // through unchanged and land in a comparison nothing can satisfy.
    const retentionMs =
        options.retentionMs !== undefined && Number.isFinite(options.retentionMs) ? Math.max(1, Math.floor(options.retentionMs)) : DEFAULT_RETENTION_MS;
    const maxSnapshotBytes =
        options.maxSnapshotBytes !== undefined && Number.isFinite(options.maxSnapshotBytes)
            ? Math.max(1, Math.floor(options.maxSnapshotBytes))
            : DEFAULT_MAX_SNAPSHOT_BYTES;
    const redacted = new Set([...DEFAULT_REDACTED_FIELDS, ...(options.redact ?? [])]);

    /** A shallow copy with the secret-shaped fields removed. */
    const redact = (row: Record<string, unknown> | undefined): Record<string, unknown> | undefined =>
        row === undefined ? undefined : Object.fromEntries(Object.entries(row).filter(([key]) => !redacted.has(key)));

    const write = async (
        context: TriggerContext,
        entry: { doc?: Record<string, unknown>; documentId: string; op: string; previous?: Record<string, unknown>; tableName: string },
    ): Promise<void> => {
        const documentJson = entry.doc === undefined ? undefined : JSON.stringify(redact(entry.doc));
        const previousJson = entry.previous === undefined ? undefined : JSON.stringify(redact(entry.previous));
        const bytes = new TextEncoder().encode(`${documentJson ?? ""}${previousJson ?? ""}`).length;
        const truncated = bytes > maxSnapshotBytes;

        await context.db.insert(DOCUMENT_HISTORY_TABLE, {
            documentId: entry.documentId,
            op: entry.op,
            recordedAt: Date.now(),
            tableName: entry.tableName,
            // Past the cap the entry keeps its metadata and loses its payload:
            // "this row changed at this time" survives, which is the part a trail
            // cannot afford to drop.
            ...(truncated ? { truncated: true } : {}),
            ...(truncated || documentJson === undefined ? {} : { doc: documentJson }),
            ...(truncated || previousJson === undefined ? {} : { previous: previousJson }),
        });
    };

    const record =
        () =>
        (t: TriggerBuilder): Record<string, TriggerDefinition> => {return {
            // `after*` on all three: a `before*` handler runs while the write can
            // still be aborted, and an entry for a write that never landed is a
            // lie the reader cannot detect.
            documentHistoryDelete: t.afterDelete(async (context, event) =>
                write(context, { documentId: event.id, op: "delete", previous: event.previous, tableName: event.table }),
            ),
            documentHistoryInsert: t.afterInsert(async (context, event) =>
                write(context, { doc: event.doc, documentId: event.id, op: "insert", tableName: event.table }),
            ),
            documentHistoryUpdate: t.afterUpdate(async (context, event) =>
                write(context, { doc: event.doc, documentId: event.id, op: "update", previous: event.previous, tableName: event.table }),
            ),
        }};

    const listForDocument = internalQuery
        .input({ before: v.optional(v.number()), documentId: v.string(), limit: v.optional(v.number()) })
        .query(async ({ args, ctx: context }): Promise<DocumentHistoryEntry[]> => {
            const limit = args.limit !== undefined && Number.isFinite(args.limit) ? Math.max(1, Math.floor(args.limit)) : PAGE;

            const rows = await context.db
                .query(DOCUMENT_HISTORY_TABLE)
                .withIndex("byDocumentRecordedAt", (q) =>
                    args.before === undefined ? q.eq("documentId", args.documentId) : q.eq("documentId", args.documentId).lte("recordedAt", args.before),
                )
                .order("desc")
                .take(limit);

            return rows.map((row) => {return {
                documentId: row["documentId"] as string,
                op: row["op"] as DocumentHistoryEntry["op"],
                recordedAt: row["recordedAt"] as number,
                tableName: row["tableName"] as string,
                ...(row["doc"] === undefined ? {} : { doc: JSON.parse(row["doc"] as string) as Record<string, unknown> }),
                ...(row["previous"] === undefined ? {} : { previous: JSON.parse(row["previous"] as string) as Record<string, unknown> }),
                ...(row["truncated"] === true ? { truncated: true } : {}),
            }});
        });

    const vacuum = internalMutation.input({ limit: v.optional(v.number()) }).mutation(async ({ args, ctx: context }): Promise<{ deleted: number }> => {
        const cutoff = Date.now() - retentionMs;
        const limit = args.limit !== undefined && Number.isFinite(args.limit) ? Math.max(1, Math.floor(args.limit)) : PAGE * MAX_VACUUM_ROUNDS;

        let deleted = 0;

        for (let round = 0; round < MAX_VACUUM_ROUNDS && deleted < limit; round += 1) {
            // eslint-disable-next-line no-await-in-loop -- each round deletes the page the previous one read; the reads are inherently sequential
            const page = await context.db
                .query(DOCUMENT_HISTORY_TABLE)
                .withIndex("byRecordedAt", (q) => q.lt("recordedAt", cutoff))
                .order("asc")
                .take(Math.min(PAGE, limit - deleted));

            if (page.length === 0) {
                return { deleted };
            }

            // eslint-disable-next-line no-await-in-loop -- see above
            await Promise.all(page.map(async (row) => context.db.delete(row["_id"] as never)));
            deleted += page.length;
        }

        return { deleted };
    });

    const component = defineComponent(DOCUMENT_HISTORY_KEY, {
        extension: documentHistoryExtension,
        functions: { listForDocument, vacuum },
    }) as DocumentHistoryComponent;

    return { ...component, record };
};

export type { DefineDocumentHistoryOptions, DocumentHistoryComponent, DocumentHistoryEntry, DocumentHistoryFunctions };
export { defineDocumentHistory, DEFAULT_REDACTED_FIELDS as DOCUMENT_HISTORY_REDACTED_FIELDS, DOCUMENT_HISTORY_TABLE, documentHistoryExtension };
