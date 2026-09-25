/**
 * Keep a RAG index in step with a table, so the table IS the index.
 *
 * `rag.index(...)` is a manual call, which means an app that edits a document
 * has to remember to re-index it — and a forgotten call is invisible: retrieval
 * keeps answering, just from stale text. The fix is to hang the re-index off the
 * write itself.
 *
 * Embedding is network I/O, so it cannot run inside the mutation that wrote the
 * row. The bridge is the two seams that already exist: a table `.triggers()`
 * handler runs in the write path and can `ctx.scheduler.runAfter(...)`, so the
 * trigger records the intent and an internal ACTION does the embedding a moment
 * later. That is what {@link ragSyncTriggers} wires up.
 *
 * Re-indexing unchanged text is already cheap — `rag.index` short-circuits on a
 * content hash — but this skips scheduling entirely when an update touched none
 * of the indexed text, the projected metadata, the namespace or the source id,
 * so an unrelated column edit costs nothing at all.
 */

import { stableStringify } from "../../../../shared/stable-key";

/**
 * A dispatchable function reference — the `internal.docs.reindex` you pass as
 * `action`. Typed structurally (rather than `unknown`) so passing the wrong
 * thing is a compile error: mis-wiring the action is the mistake this API is
 * most likely to see, and it would otherwise surface as a silent no-op.
 */
interface RagSyncActionReference {
    readonly __lunoraRef: string;
}

/** Structural slice of `ctx.scheduler` — enough to defer the re-index. */
interface RagSyncScheduler {
    runAfter: (delayMs: number, target: unknown, args?: Record<string, unknown>) => Promise<string>;
}

/** Structural slice of the `TriggerCtx` a `.triggers()` handler receives. */
interface RagSyncTriggerContext {
    readonly scheduler: RagSyncScheduler;
}

/** The trigger events this helper handles, narrowed to what it reads. */
interface RagSyncEvent {
    readonly doc?: Record<string, unknown>;
    readonly id: string;
    readonly previous?: Record<string, unknown>;
}

/** What the scheduled action receives — one document to re-index, or one to drop. */
interface RagSyncArgs extends Record<string, unknown> {
    /** `true` when the source's chunks must go: call `rag.remove({ id, namespace })`. */
    deleted?: boolean;
    /** The source id — the same `id` you pass to `rag.index`/`rag.remove`. */
    id: string;
    /** The {@link RagSyncOptions.metadata} projection, to pass to `rag.index`. Absent on a delete or when there is none. */
    metadata?: Record<string, unknown>;
    /** The {@link RagSyncOptions.namespace} projection, to pass to `rag.index`/`rag.remove`. Absent when there is none. */
    namespace?: string;
    /** The text to embed. Absent on a delete. */
    text?: string;
}

interface RagSyncOptions<Document extends Record<string, unknown> = Record<string, unknown>> {
    /**
     * The internal action to dispatch — it receives {@link RagSyncArgs} and calls
     * `rag.index` / `rag.remove`. An action, not a mutation: embedding is network
     * I/O and never runs in the deterministic write path.
     */
    action: RagSyncActionReference;

    /**
     * How long to wait before re-indexing. A small delay coalesces nothing by
     * itself, but it keeps the embed off the write's own tail latency. Default
     * `0` — as soon as the mutation commits.
     */
    delayMs?: number;
    /** The source id to index under. Defaults to the row's own id. */
    id?: (document: Document) => string;

    /**
     * Metadata copied onto every chunk (`rag.index({ metadata })`) — the fields a
     * `rlsFilter` or `metadataFilter` scopes retrieval by, such as a tenant or
     * owner id. Compared on update like the text: a row that moves tenant with
     * unchanged text is re-indexed, so the old tenant stops retrieving it.
     */
    metadata?: (document: Document) => Record<string, unknown> | undefined;

    /**
     * The Vectorize namespace to index under (`rag.index({ namespace })`), e.g.
     * the tenant key. When it changes on update, the chunks in the old namespace
     * are removed before the row is indexed into the new one.
     */
    namespace?: (document: Document) => string | undefined;
    /** The text to embed. Return `undefined` to skip the row (a draft, an empty body). */
    text: (document: Document) => string | undefined;
}

/** One trigger definition, structurally — matches what `.triggers((t) => …)` returns. */
type RagSyncHandler = (context: RagSyncTriggerContext, event: RagSyncEvent) => Promise<void>;

/**
 * Build the three write-path handlers that keep a RAG index in step with a
 * table. Wire them into the table's `.triggers()`:
 *
 * ```ts
 * const sync = ragSyncTriggers({ action: internal.docs.reindex, text: (doc) => doc.body });
 *
 * export const schema = defineSchema({
 *     docs: defineTable({ body: v.string(), title: v.string() }).triggers((t) => ({
 *         ragDelete: t.afterDelete(sync.afterDelete),
 *         ragInsert: t.afterInsert(sync.afterInsert),
 *         ragUpdate: t.afterUpdate(sync.afterUpdate),
 *     })),
 * });
 * ```
 *
 * The action on the other end is three lines:
 *
 * ```ts
 * export const reindex = internalAction.input({ deleted: v.optional(v.boolean()), id: v.string(), text: v.optional(v.string()) }).action(
 *     async ({ args, ctx }) => {
 *         const rag = docsRag(ctx);
 *
 *         await (args.deleted === true || args.text === undefined ? rag.remove({ id: args.id }) : rag.index({ id: args.id, text: args.text }));
 *     },
 * );
 * ```
 *
 * A multi-tenant table also passes `metadata` and/or `namespace` (for example
 * `metadata: (doc) => ({ orgId: doc.orgId })`) and forwards `args.metadata` /
 * `args.namespace` to `rag.index` and `rag.remove`. Without them, a row that
 * moves tenant keeps its old scope in the index and stays retrievable by the
 * tenant it left.
 */
const ragSyncTriggers = <Document extends Record<string, unknown> = Record<string, unknown>>(
    options: RagSyncOptions<Document>,
): { afterDelete: RagSyncHandler; afterInsert: RagSyncHandler; afterUpdate: RagSyncHandler } => {
    const delayMs = options.delayMs ?? 0;
    const sourceId = (document: Record<string, unknown>, fallback: string): string => (options.id === undefined ? fallback : options.id(document as Document));
    const textOf = (document: Record<string, unknown> | undefined): string | undefined =>
        document === undefined ? undefined : options.text(document as Document);
    const metadataOf = (document: Record<string, unknown>): Record<string, unknown> | undefined => options.metadata?.(document as Document);
    const namespaceOf = (document: Record<string, unknown>): string | undefined => options.namespace?.(document as Document);

    /** Where a row's chunks live: its source id, plus its namespace when there is one. */
    const locate = (document: Record<string, unknown>, fallbackId: string): Pick<RagSyncArgs, "id" | "namespace"> => {
        const namespace = namespaceOf(document);

        return { id: sourceId(document, fallbackId), ...(namespace === undefined ? {} : { namespace }) };
    };

    /** The re-index args for a row whose text is `text`. */
    const indexArgs = (document: Record<string, unknown>, fallbackId: string, text: string): RagSyncArgs => {
        const metadata = metadataOf(document);

        return { ...locate(document, fallbackId), ...(metadata === undefined ? {} : { metadata }), text };
    };

    const schedule = async (context: RagSyncTriggerContext, args: RagSyncArgs): Promise<void> => {
        await context.scheduler.runAfter(delayMs, options.action, args);
    };

    return {
        afterDelete: async (context, event) => {
            const document = event.previous ?? event.doc;

            await schedule(context, { deleted: true, ...(document === undefined ? { id: event.id } : locate(document, event.id)) });
        },
        afterInsert: async (context, event) => {
            const text = textOf(event.doc);

            if (text === undefined || event.doc === undefined) {
                return;
            }

            await schedule(context, indexArgs(event.doc, event.id, text));
        },
        afterUpdate: async (context, event) => {
            if (event.doc === undefined) {
                return;
            }

            const text = textOf(event.doc);
            const before = textOf(event.previous);
            const location = locate(event.doc, event.id);
            // `options.id` / `options.namespace` may derive from a mutable column
            // (a slug, a tenant). When either moves, the chunks at the OLD
            // location are orphaned — indexed forever, and retrievable by the
            // old tenant — unless they are removed explicitly.
            const previousLocation = event.previous === undefined ? location : locate(event.previous, event.id);
            const moved = previousLocation.id !== location.id || previousLocation.namespace !== location.namespace;
            // Metadata is what `rlsFilter` / `metadataFilter` scope by, so a change
            // to it is a change to who can retrieve the row, even when the text
            // is identical. Compared key-order-insensitively.
            const metadataChanged =
                options.metadata !== undefined &&
                event.previous !== undefined &&
                stableStringify(metadataOf(event.doc)) !== stableStringify(metadataOf(event.previous));

            if (moved) {
                await schedule(context, { deleted: true, ...previousLocation });
            } else if (text === before && !metadataChanged) {
                // Same location, text and metadata: an edit that touched none of
                // them costs nothing — no dispatch, no embedding, no vector write.
                return;
            }

            // The text went away (cleared, or the row no longer qualifies): the
            // old chunks must go too, or retrieval keeps serving deleted content.
            await (text === undefined ? schedule(context, { deleted: true, ...location }) : schedule(context, indexArgs(event.doc, event.id, text)));
        },
    };
};

export type { RagSyncActionReference, RagSyncArgs, RagSyncOptions };
export { ragSyncTriggers };
