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
 * const threads = defineTable({ ... }).triggers(history.record);
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
 * **Redacted by default, at every depth.** The point of keeping a snapshot is that
 * it is readable later, and a stored `hashedPassword` is a credential at rest —
 * one that outlives the rotation that was supposed to retire it. Secret-shaped
 * fields are dropped before the row is written, recursively, so a credential
 * inside a `v.object(...)` column or an `oauth: { refreshToken }` blob goes too.
 * Matching is by exact field NAME, which is all a trigger can see, so
 * {@link DefineDocumentHistoryOptions.redact} is how you cover `api_key`,
 * `sessionToken`, and anything else this list does not spell the same way.
 *
 * **It has one blind spot.** `insertManyUnsafe` skips triggers by design, so seed,
 * migration, and admin-import writes leave no entry. If the trail is being used
 * for compliance rather than for undo, that gap has to be closed elsewhere.
 *
 * **Reads are internal.** An entry is a full row snapshot, including columns the
 * table's own RLS would hide. `listForDocument` is registered as an internal
 * query so it cannot be called from a client; wrap it in your own procedure with
 * whatever authorization the surface needs.
 */

import type { Id } from "@lunora/values";
import { v } from "@lunora/values";

import { decodeWire, encodeWire } from "../../../shared/wire-codec";
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

/**
 * Ceiling on a caller-supplied `listForDocument` limit. `take()` has no ceiling of
 * its own, so an unbounded `limit` is an unbounded index scan returning full
 * un-RLS'd row snapshots — the same reasoning `action-cache`'s `PURGE_MAX_LIMIT`
 * and `presence`'s `maxSessions` clamp were added for. Being an `internalQuery`
 * bounds who can ask, not how much one ask costs.
 */
const LIST_MAX_LIMIT = 1000;

/** Pages `vacuum` will walk in one call, so a stuck read cannot spin forever. */
const MAX_VACUUM_ROUNDS = 64;

/**
 * Default entries `vacuum` removes per call. One transaction's worth: a cron
 * that finds more re-runs, which is cheaper than opening a very large write.
 */
const DEFAULT_VACUUM_LIMIT = 512;

/** How deep the redaction filter walks before dropping a branch it cannot fully inspect. */
const MAX_REDACT_DEPTH = 16;

/**
 * Ordering, in two parts, because no single value gives both halves.
 *
 * `_commitSeq` (from `.commitOrdered()` on the table) is a per-shard integer
 * allocated ONCE PER MUTATION and strictly increasing in commit order. It is
 * durable, so it keeps ordering across a Durable Object restart — which
 * `recordedAt` cannot, being wall-clock, and which an in-process counter cannot,
 * being reset by the restart.
 *
 * What `_commitSeq` does NOT do is separate entries written by the SAME mutation,
 * and that is the common case rather than a race: Workers do not advance the
 * clock between I/O operations, so two updates to a row, or an update plus a
 * cascade, share both a `recordedAt` and a `_commitSeq`. The per-component `seq`
 * counter supplies that inner order.
 *
 * So the sort key is `[_commitSeq, seq]`: durable across mutations, defined
 * within one. `seq` is per-component rather than module-scoped so its lifetime is
 * visible and a test can simulate a restart by building a second component.
 */
const ORDER_KEYS = ["_commitSeq", "seq"] as const;

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
type DocumentHistoryComponent = {
    functions: DocumentHistoryFunctions;

    /**
     * The `.triggers(...)` argument that records this table's versions —
     * `.triggers(history.record)`.
     *
     * `after*` on all three ops: a `before*` handler runs while the write can
     * still be aborted, and a history entry for a write that never happened is a
     * lie the reader has no way to detect.
     */
    record: (t: TriggerBuilder) => Record<string, TriggerDefinition>;
} & Component<{ [DOCUMENT_HISTORY_BARE_TABLE]: ReturnType<typeof defineTable> }>;

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
            // A union rather than a bare string: the invariant belongs on the
            // column, and the read side then needs no cast back to it.
            op: v.union(v.literal("delete"), v.literal("insert"), v.literal("update")),
            previous: v.optional(v.string()),
            recordedAt: v.number(),
            /** Tie-breaker within one `recordedAt`; see the module-level `sequence`. */
            seq: v.number(),
            tableName: v.string(),
            truncated: v.optional(v.boolean()),
        })
            // Stamps `_commitSeq` on every row: the durable half of the sort key.
            .commitOrdered()
            // Drives `listForDocument`, newest-first and optionally bounded by
            // `before`. `seq` is part of the key so entries sharing a millisecond
            // still have one defined order.
            .index("byDocumentRecordedAt", ["documentId", "recordedAt", "seq"])
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

    // Separates entries sharing one mutation's `_commitSeq`. Only ever compared
    // WITHIN a `_commitSeq`, so a reset on restart cannot reorder anything: a
    // later mutation always carries a higher `_commitSeq` than an earlier one.
    let sequence = 0;
    const nextSequence = (): number => {
        sequence += 1;

        return sequence;
    };

    /**
     * Strip the secret-shaped fields, at every depth.
     *
     * Recursive, not a top-level filter: a credential is at least as likely to sit
     * inside a `v.object({ apiKey })` column or an `oauth: { refreshToken }` blob
     * as at the root, and this table retains what it is given for months. Arrays,
     * `Map`s and `Set`s are walked too — the wire codec round-trips all three, so
     * a list of connection objects, or a `Map` keyed `"refreshToken"`, is covered.
     *
     * `MAX_REDACT_DEPTH` bounds a pathological or cyclic shape; past it the branch
     * is dropped rather than copied, because a value this module cannot fully
     * inspect is not one it should store.
     */
    const redact = (value: unknown, depth = 0): unknown => {
        if (Array.isArray(value)) {
            return depth >= MAX_REDACT_DEPTH ? undefined : value.map((item) => redact(item, depth + 1));
        }

        if (typeof value !== "object" || value === null) {
            return value;
        }

        // A `Map` holds NAMED keys, so it is a container this filter has to walk:
        // a column holding `new Map([["refreshToken", tok]])` otherwise landed in
        // the table verbatim, against the module's "recursively" claim. Rebuilt as
        // a `Map` so the wire codec still round-trips it as one. A `Set` carries no
        // names of its own but its members can, so its values are walked too.
        if (value instanceof Map) {
            return depth >= MAX_REDACT_DEPTH
                ? undefined
                : new Map(
                      [...value.entries()]
                          .filter(([key]) => typeof key !== "string" || !redacted.has(key))
                          .map(([key, member]) => [key, redact(member, depth + 1)]),
                  );
        }

        if (value instanceof Set) {
            return depth >= MAX_REDACT_DEPTH ? undefined : new Set([...value].map((member) => redact(member, depth + 1)));
        }

        // Everything else that is not a plain object is a leaf. A `Date`, bytes —
        // anything the wire codec carries whole — is passed through; recursing into
        // one would corrupt it, and none of them holds a named field.
        if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
            return value;
        }

        if (depth >= MAX_REDACT_DEPTH) {
            return undefined;
        }

        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .filter(([key]) => !redacted.has(key))
                .map(([key, member]) => [key, redact(member, depth + 1)]),
        );
    };

    /**
     * Serialize one snapshot, or `undefined` when it is absent or over the cap.
     *
     * Through the wire codec, because this runs inside an AFTER-trigger: raw
     * `JSON.stringify` throws on a `bigint`, and a throw here aborts the write it
     * is recording. A table with a `v.bigint()` column and history attached would
     * have failed every insert, update and delete.
     */
    const snapshot = (row: Record<string, unknown> | undefined): string | undefined => {
        if (row === undefined) {
            return undefined;
        }

        const serialized = JSON.stringify(encodeWire(redact(row)));

        // Each side is capped on its own: a large `previous` should not discard a
        // small `doc`, which is usually the more useful half.
        return new TextEncoder().encode(serialized).length > maxSnapshotBytes ? undefined : serialized;
    };

    const write = async (
        context: TriggerContext,
        entry: { doc?: Record<string, unknown>; documentId: string; op: DocumentHistoryEntry["op"]; previous?: Record<string, unknown>; tableName: string },
    ): Promise<void> => {
        const documentJson = snapshot(entry.doc);
        const previousJson = snapshot(entry.previous);
        const truncated = (entry.doc !== undefined && documentJson === undefined) || (entry.previous !== undefined && previousJson === undefined);

        await context.db.insert(DOCUMENT_HISTORY_TABLE, {
            documentId: entry.documentId,
            op: entry.op,
            recordedAt: Date.now(),
            seq: nextSequence(),
            tableName: entry.tableName,
            // Past the cap the entry keeps its metadata and loses that payload:
            // "this row changed at this time" survives, which is the part a trail
            // cannot afford to drop.
            ...(truncated ? { truncated: true } : {}),
            ...(documentJson === undefined ? {} : { doc: documentJson }),
            ...(previousJson === undefined ? {} : { previous: previousJson }),
        });
    };

    const record = (t: TriggerBuilder): Record<string, TriggerDefinition> => {
        return {
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
        };
    };

    const listForDocument = internalQuery
        .input({ before: v.optional(v.number()), documentId: v.string(), limit: v.optional(v.number()) })
        .query(async ({ args, ctx: context }): Promise<DocumentHistoryEntry[]> => {
            const limit = args.limit !== undefined && Number.isFinite(args.limit) ? Math.min(LIST_MAX_LIMIT, Math.max(1, Math.floor(args.limit))) : PAGE;

            const rows = await context.db
                .query(DOCUMENT_HISTORY_TABLE)
                .withIndex("byDocumentRecordedAt", (q) =>
                    args.before === undefined ? q.eq("documentId", args.documentId) : q.eq("documentId", args.documentId).lte("recordedAt", args.before),
                )
                .order("desc")
                .take(limit);

            // Re-sorted on the durable key. The index reads by `recordedAt`, which
            // is what `before` bounds against and what a caller asks in — but wall
            // clock is not commit order, and a restart can hand two mutations the
            // same millisecond. `_commitSeq` is the shard's own commit counter, so
            // it separates them; `seq` separates entries inside one mutation, which
            // share a `_commitSeq`.
            //
            // Sorting the page rather than the table is exact for everything the
            // page contains. A tie group straddling `limit` can still be cut
            // mid-group — raise `limit` if you are reconstructing across one.
            rows.sort((a, b) => {
                for (const key of ORDER_KEYS) {
                    const delta = ((b[key] as number | undefined) ?? 0) - ((a[key] as number | undefined) ?? 0);

                    if (delta !== 0) {
                        return delta;
                    }
                }

                return 0;
            });

            return rows.map((row) => {
                return {
                    documentId: row["documentId"] as string,
                    op: row["op"] as DocumentHistoryEntry["op"],
                    recordedAt: row["recordedAt"] as number,
                    tableName: row["tableName"] as string,
                    // Decoded through the same codec that wrote it, so a `bigint`
                    // or `Date` column comes back as itself, not as a tagged form.
                    ...(row["doc"] === undefined ? {} : { doc: decodeWire(JSON.parse(row["doc"] as string)) as Record<string, unknown> }),
                    ...(row["previous"] === undefined ? {} : { previous: decodeWire(JSON.parse(row["previous"] as string)) as Record<string, unknown> }),
                    ...(row["truncated"] === true ? { truncated: true } : {}),
                };
            });
        });

    const vacuum = internalMutation.input({ limit: v.optional(v.number()) }).mutation(async ({ args, ctx: context }): Promise<{ deleted: number }> => {
        const cutoff = Date.now() - retentionMs;
        const limit = args.limit !== undefined && Number.isFinite(args.limit) ? Math.max(1, Math.floor(args.limit)) : DEFAULT_VACUUM_LIMIT;

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
            await Promise.all(page.map(async (row) => context.db.delete(row["_id"] as Id<string>)));
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
