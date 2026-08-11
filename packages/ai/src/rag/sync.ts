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
 * content hash — but this skips scheduling entirely when an update didn't touch
 * the indexed text, so an unrelated column edit costs nothing at all.
 */

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
    /** `true` when the source row was deleted: call `rag.remove({ id })`. */
    deleted?: boolean;
    /** The source id — the same `id` you pass to `rag.index`/`rag.remove`. */
    id: string;
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
 */
const ragSyncTriggers = <Document extends Record<string, unknown> = Record<string, unknown>>(
    options: RagSyncOptions<Document>,
): { afterDelete: RagSyncHandler; afterInsert: RagSyncHandler; afterUpdate: RagSyncHandler } => {
    const delayMs = options.delayMs ?? 0;
    const sourceId = (document: Record<string, unknown>, fallback: string): string => (options.id === undefined ? fallback : options.id(document as Document));
    const textOf = (document: Record<string, unknown> | undefined): string | undefined =>
        document === undefined ? undefined : options.text(document as Document);

    const schedule = async (context: RagSyncTriggerContext, args: RagSyncArgs): Promise<void> => {
        await context.scheduler.runAfter(delayMs, options.action, args);
    };

    return {
        afterDelete: async (context, event) => {
            const document = event.previous ?? event.doc;

            await schedule(context, { deleted: true, id: document === undefined ? event.id : sourceId(document, event.id) });
        },
        afterInsert: async (context, event) => {
            const text = textOf(event.doc);

            if (text === undefined || event.doc === undefined) {
                return;
            }

            await schedule(context, { id: sourceId(event.doc, event.id), text });
        },
        afterUpdate: async (context, event) => {
            const text = textOf(event.doc);
            const before = textOf(event.previous);

            // An edit that didn't touch the indexed text costs nothing: no action
            // dispatch, no embedding call, no vector write.
            if (text === before || event.doc === undefined) {
                return;
            }

            const id = sourceId(event.doc, event.id);

            // The text went away (cleared, or the row no longer qualifies): the
            // old chunks must go too, or retrieval keeps serving deleted content.
            await (text === undefined ? schedule(context, { deleted: true, id }) : schedule(context, { id, text }));
        },
    };
};

export type { RagSyncActionReference, RagSyncArgs, RagSyncOptions };
export { ragSyncTriggers };
