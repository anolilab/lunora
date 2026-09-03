/* eslint-disable import/exports-last -- a types-heavy module: public types are declared next to the helpers they build on */
import type { FunctionReference, LunoraClient, SubscriptionError } from "@lunora/client";
import type { Collection, Transaction } from "@tanstack/db";
import { createCollection, safeRandomUUID } from "@tanstack/db";
import type { OfflineConfig, OfflineExecutor, OfflineTransaction, StorageDiagnostic } from "@tanstack/offline-transactions";
import { NonRetriableError, startOfflineExecutor } from "@tanstack/offline-transactions";

import { lunoraCollectionOptions } from "./collection-options";
import type { OutboxMutationMetadata, Row } from "./internals";
import { createOptimisticOnlineDetector, createOutboxCarrier, OUTBOX_MUTATION_FN_NAME, registerOutboxCarrier, runOutboxMutation } from "./internals";

/** Element type of an array (the row type a `list` query returns). */
type Element<T> = T extends ReadonlyArray<infer E> ? E : never;

/** `true` for the `any` type, `false` otherwise. */
type IsAny<T> = 0 extends 1 & T ? true : false;

/**
 * The row type a `list` query syncs. For `TList = any` (the heterogeneous-map
 * constraint) it resolves to the permissive {@link Row}, not `never` — otherwise
 * the constraint would force every `optimistic` to return `never`. For a concrete
 * `FunctionReference` it's the element type of the query's array return.
 */
type RowOfList<TList> = IsAny<TList> extends true ? Row : TList extends FunctionReference<infer _K, infer _A, infer R> ? Element<R> & Row : never;

/** Maps a write through the durable outbox: optimistic insert + a retried mutation. */
export interface InsertBinding<TRow extends Row, TInput> {
    /** The Lunora mutation that persists the row. */
    mutation: FunctionReference;
    /** Build the optimistic row to insert from the action input + the generated client id. */
    optimistic: (input: TInput, id: string) => TRow;
    /** Build the mutation args from the persisted optimistic row (forward `_id` as the `clientId`). */
    toArgs: (row: TRow) => Record<string, unknown>;
}

/** Declarative binding of a Lunora table to a live collection (+ optional write action). */
// eslint-disable-next-line unicorn/prevent-abbreviations -- "Def" reads well for a declarative collection definition; "Definition" is noise
export interface CollectionDef<TList extends FunctionReference, TInput = never> {
    /** Row key extractor — defaults to `row._id`. */
    getKey?: (row: RowOfList<TList>) => string;
    /** Optional write binding — present iff this collection is written through the outbox. */
    insert?: InsertBinding<RowOfList<TList>, TInput>;
    /** The Lunora query that lists the rows (the sync source). */
    list: TList;

    /**
     * When this collection starts syncing — `"lazy"` (default) on the first
     * `useLiveQuery` subscriber, or `"eager"` at creation, for small "instant"
     * reference data you want warm at boot. Pairs with `scopeBy` for partial
     * (per-scope) loading — together they give the full lazy/partial/eager
     * (Linear `lazy`/`partial`/`instant`) load taxonomy declaratively. No effect
     * on a `scopeBy` collection (nothing to sync until scoped).
     */
    load?: "eager" | "lazy";

    /**
     * Notified when the underlying `list` subscription errors (e.g. the server
     * rejects it). Without this the error would be swallowed and the collection
     * could hang in `loading`; the binding always moves the collection out of
     * `loading` on error, and forwards the error here if supplied.
     */
    onError?: (error: SubscriptionError) => void;
    /** A field that scopes the list (e.g. a shard key); makes the collection re-pointable via `scope`. */
    scopeBy?: string;

    /**
     * Routes the `list` subscription (and the confirmed-mutation watermark its
     * frames advance the checkpoint gate from) to a specific shard's DO — so a
     * sharded collection's overlay gate compares against that shard's mutator
     * sequence line, not the default ("") watermark bucket. `insert` writes are
     * routed with it too, and to the shard that was set when the write was
     * queued: subscriptions and the writes they observe have to land on the same
     * Durable Object, and the server derives no shard from a mutation's args.
     */
    shardKey?: string;
}

// A collection def with its type params erased to `any` (not `FunctionReference`/
// `unknown`): pinning `TList` to the base `FunctionReference` collapses the row
// type to `never`, and `TInput` is contravariant. The precise per-entry types are
// recovered from each concrete `D[K]` via `RowOf` / `InputOf`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any, unicorn/prevent-abbreviations -- see comment above; "AnyDef" mirrors `CollectionDef`
type AnyDef = CollectionDef<any, any>;

/**
 * The public row type a collection exposes — the element type of its `list`
 * query's return, with no `& Row`: a `Collection<T>` is invariant in `T`, so the
 * exposed type must be exactly the document type, not a subtype.
 */
type RowOf<C extends AnyDef> = C["list"] extends FunctionReference<infer _K, infer _A, infer R> ? Element<R> : never;

/** The action input type, inferred structurally from the def's optimistic insert. */
type InputOf<C> = C extends { insert: { optimistic: (input: infer I, id: string) => unknown } } ? I : never;

/**
 * One-shot diagnostic for a table bound by more than one `defineCollections`
 * call on the same client. Each call mints its own live collection *and* its own
 * outbox for that table, so the copies can only drift — an optimistic write or
 * sync delta lands on one, and code that reads the other silently reads stale
 * rows (the quiet failure the "One source of truth per table" docs section warns
 * about). Keyed by client + table name, so a fresh client or a split into two
 * calls with *disjoint* tables is never penalised.
 */
const duplicateTableBindings = new WeakMap<LunoraClient, Map<string, number>>();

const warnDuplicateTable = (client: LunoraClient, name: string): void => {
    let bindings = duplicateTableBindings.get(client);

    if (bindings === undefined) {
        bindings = new Map();
        duplicateTableBindings.set(client, bindings);
    }

    const count = bindings.get(name) ?? 0;

    bindings.set(name, count + 1);

    // Warn exactly when the second binding happens (the first is legitimate).
    if (count !== 1) {
        return;
    }

    // eslint-disable-next-line no-console
    console.warn(
        `[@lunora/db] table "${name}" is bound by more than one defineCollections call on this client. Each call creates its ` +
            `own live collection and outbox for the table, so the two can drift and derived indexes built from one can silently ` +
            `read stale rows. Bind every table in a single defineCollections call (see the "One source of truth per table" docs section).`,
    );
};

/**
 * Provenance stamped onto every `db.actions.*` transaction at enqueue time and
 * read back by its replay handler. The persisted mutation carries the row and
 * nothing else, so without this the replay cannot answer either question a
 * durable write raises once it outlives its session: WHO queued it, and WHICH
 * shard it belongs to. The reserved `__lunora_outbox__` handler reads the same
 * two fields off {@link OutboxMutationMetadata}.
 */
interface CollectionWriteMetadata extends Record<string, unknown> {
    /** `client.currentIdentity()` when the write was queued; the replay drops the write when it no longer matches. */
    identity: null | string;
    /** The collection's `shardKey` when the write was queued — captured, not re-read, so a queued write follows the shard it was made against even if the app reboots pointed at another. */
    shardKey?: string;
}

/** A queued write that was permanently dropped, passed to {@link DefineCollectionsOptions.onWriteRejected}. */
export interface WriteRejectedEvent {
    /**
     * The machine-readable reason — the server's error `code` (e.g. `CONFLICT`,
     * `FORBIDDEN`), or `UNKNOWN_MUTATION_FN` when the write referenced a collection
     * that no longer exists (removed in a deploy). Mirrors the client's
     * `MutationSettledEvent.code` so a consumer can branch on the verdict.
     */
    code?: string;
    /** The collection/table name the write targeted. */
    collection: string;
    /** The error that dropped the write (message carried by the underlying `NonRetriableError`). */
    error: Error;

    /**
     * The optimistic row being rolled back (the rollback follows the callback).
     * Absent only if the dropped transaction carried no recoverable row (e.g. some
     * `UNKNOWN_MUTATION_FN` cases).
     */
    row?: Row;
}

/** Options for {@link defineCollections}. */
export interface DefineCollectionsOptions {
    /**
     * Invoked when a leadership change occurs across tabs (only the leader tab
     * drains the durable outbox). Informational — useful for diagnostics; the
     * library handles the election itself.
     */
    onLeadershipChange?: (isLeader: boolean) => void;

    /**
     * Invoked when the durable outbox's storage layer fails — IndexedDB
     * unavailable (private mode), blocked, or quota exceeded. The standalone
     * client surfaces this via `offlineQueue.onPersistenceError`; this is the
     * collection-layer counterpart. A storage failure means a write is NOT durable
     * and won't survive a reload, so surface it (e.g. "your change may not be
     * saved if you close this tab").
     */
    onStorageFailure?: (diagnostic: StorageDiagnostic) => void;

    /**
     * Invoked as a queued write is permanently dropped: a coded application error
     * from the server (validation, RLS denial, conflict, surfaced as a
     * `NonRetriableError`), OR a write whose target collection no longer exists —
     * removed/renamed in a deploy (`code: "UNKNOWN_MUTATION_FN"`). This is the
     * aggregate, fire-and-forget-safe channel: unlike awaiting the per-action
     * `transaction` returned by `actions[name](...)`, it fires even when the caller
     * never retained that handle, so a UI can surface "couldn't save" instead of a
     * silently vanishing row. Transient failures (offline, 5xx) are retried by the
     * outbox, not reported here.
     *
     * Timing: the callback runs at the point of rejection; the executor's
     * optimistic-row rollback follows immediately after. The event's `row` is the
     * (about-to-be-removed) optimistic row, so don't depend on the collection
     * already reflecting the removal from inside the handler — use `row`/`error`
     * directly (e.g. for a toast).
     */
    onWriteRejected?: (event: WriteRejectedEvent) => void;
}

/** The wired data layer `defineCollections` returns. */
// eslint-disable-next-line unicorn/prevent-abbreviations -- "Db" matches the package name `@lunora/db`
export interface LunoraDb<D extends Record<string, AnyDef>> {
    /** Optimistic, durable, retried write actions — present for `insert` collections. */
    actions: { [K in keyof D]: D[K] extends { insert: object } ? (input: InputOf<D[K]>) => { id: string; transaction: Transaction } : never };
    /** The live, synced collections — feed these to `useLiveQuery`. */
    collections: { [K in keyof D]: Collection<RowOf<D[K]>, string> };
    /** The shared offline executor (the outbox). */
    executor: OfflineExecutor;

    /**
     * Number of writes still pending in the durable outbox — the depth for a
     * "N changes waiting to sync" indicator. A convenience over reaching through
     * `executor.getPendingCount()`. **Pull-only** (the underlying TanStack
     * executor exposes no change subscription): read it after a `db.actions.*`
     * call and on connection-status changes, or poll. The standalone
     * `LunoraClient` exposes the reactive `onPendingChange` for its built-in queue.
     */
    pendingCount: () => number;
    /** Re-point a `scopeBy` collection's subscription (omit `args` to detach) — present for scoped collections. */
    scope: { [K in keyof D]: D[K] extends { scopeBy: string } ? (args?: Record<string, unknown>) => void : never };
}

/**
 * Wire a set of Lunora tables into a TanStack DB data layer in one declaration:
 * each entry becomes a live, auto-indexed collection synced from its `list` query,
 * and `insert` entries get an optimistic write action backed by the
 * offline-transactions outbox (durable, retried, client-id-keyed). Scoped
 * (`scopeBy`) collections are re-pointable for sharded queries.
 *
 * This is the hand-written form; `@lunora/codegen` can emit a fully-typed call to
 * it from `schema.ts`, so an app writes nothing.
 *
 * Keep a single instance and treat the returned collections as the one source of
 * truth per table — do not mirror rows into a parallel store, or derived indexes
 * built from the copy can silently read stale data (see the `@lunora/db` docs,
 * "One source of truth per table").
 */
export const defineCollections = <D extends Record<string, AnyDef>>(client: LunoraClient, defs: D, options: DefineCollectionsOptions = {}): LunoraDb<D> => {
    const collections: Record<string, Collection<Row, string>> = {};
    const scope: Record<string, (args?: Record<string, unknown>) => void> = {};
    const mutationFns: OfflineConfig["mutationFns"] = {};

    const entries = Object.entries(defs);

    for (const [name, definition] of entries) {
        const insert = definition.insert as InsertBinding<Row, unknown> | undefined;

        warnDuplicateTable(client, name);

        // Build the live-sync read path from the shared collection-options core
        // (same diff-into-channel + auto-index + scoped-resubscribe behavior).
        const { config, scope: scopeFunction } = lunoraCollectionOptions<Row>({
            client,
            getKey: definition.getKey,
            id: name,
            // `AnyDef` erases `list` to `any` (`TList = any`); it's a `FunctionReference` here.
            list: definition.list as FunctionReference,
            ...(definition.load === undefined ? {} : { load: definition.load }),
            onError: definition.onError,
            scopeBy: definition.scopeBy,
            shardKey: definition.shardKey,
        });

        collections[name] = createCollection<Row, string>(config);

        if (definition.scopeBy !== undefined) {
            scope[name] = scopeFunction;
        }

        if (insert) {
            mutationFns[name] = async ({ idempotencyKey, transaction }) => {
                const meta = transaction.metadata as CollectionWriteMetadata | undefined;

                for (const [mutationIndex, mutation] of transaction.mutations.entries()) {
                    const row = mutation.modified as unknown as Row;
                    // Replay under the executor's stable idempotency key (suffixed
                    // with the mutation's index so a batched transaction's writes
                    // stay distinct), NOT a fresh id minted per call: a
                    // committed-but-unacked write the outbox retries then resends the
                    // same `x-lunora-mutation-id` and the server dedupes it instead
                    // of inserting the row twice. Mirrors the reserved
                    // `__lunora_outbox__` handler, which replays under
                    // `meta.idempotencyKey`.
                    const mutationId = `${idempotencyKey}:${String(mutationIndex)}`;

                    try {
                        // Identity is the trust boundary. A durable write outlives the
                        // session that queued it — a reload, or a sign-out/sign-in in the
                        // same browser profile — so replaying it under whoever holds the
                        // bearer now would attribute one user's write to another and pass
                        // THEIR row-level security. Drop it instead: the same verdict the
                        // reserved `__lunora_outbox__` handler reaches, and the one
                        // `@lunora/client`'s queue settles as OFFLINE_IDENTITY_CHANGED.
                        // Re-read per mutation, not once per transaction: a batched
                        // transaction awaits between its writes, which is exactly where a
                        // `setAuthToken` can slip in. A write persisted without the stamp
                        // (queued by an older build) has no provenance to check, so it
                        // fails closed too. Thrown inside the try so the drop reaches
                        // `onWriteRejected` rather than rolling the row back in silence.
                        if (meta?.identity !== client.currentIdentity()) {
                            throw new NonRetriableError("outbox write dropped: identity changed since it was queued");
                        }

                        // eslint-disable-next-line no-await-in-loop -- sequential keeps the outbox's FIFO ordering
                        await runOutboxMutation(() =>
                            // `shardKey` routes the write to the DO the collection's `list`
                            // subscription reads. The server derives no shard from args, so
                            // omitting it lands a `.shardBy()`'d collection's writes in the
                            // default shard — committed, ack'd, and invisible to the reader.
                            client.mutation(insert.mutation, insert.toArgs(row), { mutationId, shardKey: meta.shardKey }),
                        );
                    } catch (error) {
                        // A permanent (coded) rejection: the executor will roll the
                        // optimistic row back. Report it on the aggregate channel so a
                        // fire-and-forget caller still learns the write was dropped, then
                        // rethrow so the rollback proceeds. Transient errors retry — only
                        // the NonRetriableError verdict is terminal, so only it is reported.
                        if (error instanceof NonRetriableError && options.onWriteRejected) {
                            try {
                                options.onWriteRejected({ code: (error as Error & { code?: string }).code, collection: name, error, row });
                            } catch {
                                // A throwing listener must not escape and replace the
                                // NonRetriableError — that would turn a terminal verdict
                                // retriable (poison-message loop) and skip the rollback.
                            }
                        }

                        throw error;
                    }
                }
            };
        }
    }

    // Reserved replay handler for the unified outbox: a raw `client.mutation`
    // offline write delegated through `createExecutorOutboxSink` rides this
    // executor (one durable store) rather than the standalone `OfflineQueue`. It
    // carries no collection mutation — the target lives in `transaction.metadata`
    // — so we replay it by path and apply the same identity guard the queue path
    // uses: a write whose captured identity no longer matches the signed-in user
    // is dropped (NonRetriableError) instead of replaying as someone else.
    mutationFns[OUTBOX_MUTATION_FN_NAME] = async ({ transaction }) => {
        const meta = transaction.metadata as OutboxMutationMetadata | undefined;

        if (!meta) {
            return;
        }

        try {
            if (meta.identity !== client.currentIdentity()) {
                throw new NonRetriableError("outbox write dropped: identity changed since it was queued");
            }

            // Replay under the *original* idempotency key (not a fresh one), so a
            // committed-but-unacked write that the executor retries is deduped by the
            // server instead of applied twice.
            await runOutboxMutation(() =>
                client.mutation({ __lunoraRef: meta.functionPath }, meta.args, { mutationId: meta.idempotencyKey, shardKey: meta.shardKey }),
            );
        } catch (error) {
            // Same aggregate-channel report the per-collection handler makes, for the
            // same reason: without it this path rolls the optimistic row back with no
            // UI signal — the precise failure `onWriteRejected` was added to prevent.
            // It covers the identity drop above AND a server-coded rejection from the
            // replay, because reporting only the first would leave this handler with
            // exactly the half-guarded shape it is being fixed for.
            if (error instanceof NonRetriableError && options.onWriteRejected) {
                try {
                    options.onWriteRejected({
                        code: (error as Error & { code?: string }).code,
                        // A raw outbox write targets a function, not a collection — the
                        // path is the only identifier it carries, and it is what a
                        // consumer needs to name the dropped write.
                        collection: meta.functionPath,
                        error,
                        // No `row`: the write rides the transport carrier, whose
                        // transaction holds no optimistic collection row to hand back.
                    });
                } catch {
                    // A throwing listener must not escape and replace the
                    // NonRetriableError — that would turn a terminal verdict retriable
                    // (poison-message loop) and skip the rollback.
                }
            }

            throw error;
        }
    };

    // The transport carrier for outbox-routed raw writes (see
    // `createOutboxCarrier`): registered in the executor's collection registry
    // under the reserved key — so persisted transport transactions
    // serialize/deserialize across reloads — but NOT exposed on the returned
    // `collections` surface.
    const outboxCarrier = createOutboxCarrier();

    const executor = startOfflineExecutor({
        collections: { ...collections, [OUTBOX_MUTATION_FN_NAME]: outboxCarrier },
        mutationFns,
        onlineDetector: createOptimisticOnlineDetector(),
        ...(options.onLeadershipChange ? { onLeadershipChange: options.onLeadershipChange } : {}),
        ...(options.onStorageFailure ? { onStorageFailure: options.onStorageFailure } : {}),
        // A persisted write whose target collection was removed/renamed in a deploy
        // hits an unregistered mutationFn. The executor drops it as a
        // NonRetriableError *before* our per-collection `mutationFns` catch runs, so
        // this hook is the only place to surface it on `onWriteRejected`.
        onUnknownMutationFn: (name: string, tx: OfflineTransaction) => {
            try {
                options.onWriteRejected?.({
                    code: "UNKNOWN_MUTATION_FN",
                    collection: name,
                    error: new Error(`offline write dropped: mutation "${name}" no longer exists (removed or renamed in a deploy?)`),
                    // Best-effort recovered row: the persisted `modified` shape isn't a
                    // validated `Row`, and a batched transaction surfaces only its first
                    // mutation's row. Enough to describe the dropped write to the user.
                    row: tx.mutations[0]?.modified as Row | undefined,
                });
            } catch {
                // A throwing listener must not escape into the executor's drop path.
            }
        },
    });

    // Let `createExecutorOutboxSink(executor)` find the carrier when it persists
    // a raw `client.mutation` offline write through this executor.
    registerOutboxCarrier(executor, outboxCarrier);

    const actions: Record<string, (input: unknown) => { id: string; transaction: Transaction }> = {};

    for (const [name, definition] of entries) {
        const insert = definition.insert as InsertBinding<Row, unknown> | undefined;
        const collection = collections[name];

        if (!insert || !collection) {
            continue;
        }

        actions[name] = (input) => {
            // `safeRandomUUID` (from @tanstack/db) falls back to
            // `crypto.getRandomValues` when `crypto.randomUUID` is unavailable —
            // e.g. a plain-HTTP dev/LAN origin (non-secure context), where
            // `crypto.randomUUID` is undefined and a bare call would throw,
            // breaking every `db.actions.*` invocation.
            const id = safeRandomUUID();
            // Built from `createOfflineTransaction` rather than the executor's
            // `createOfflineAction`, which takes no `metadata`: the identity and
            // shard have to be captured HERE, while the issuing session is still
            // the current one. Both are persisted with the transaction and
            // restored with it, so a replay after a reload still knows them.
            const metadata: CollectionWriteMetadata = { identity: client.currentIdentity(), shardKey: definition.shardKey };
            const offline = executor.createOfflineTransaction({ autoCommit: false, metadata, mutationFnName: name });
            const transaction = offline.mutate(() => {
                collection.insert(insert.optimistic(input, id));
            });

            // Commit explicitly (not via `autoCommit`, whose upstream failure
            // handler rethrows inside its own .catch — every terminal verdict
            // would surface as an unhandled rejection) and swallow the outcome:
            // retries are the executor's job, permanent drops are reported
            // through `onWriteRejected`, and the caller can still await the
            // returned `transaction`. Mirrors `createExecutorOutboxSink`.
            offline.commit().catch(() => undefined);

            return { id, transaction };
        };
    }

    return { actions, collections, executor, pendingCount: () => executor.getPendingCount(), scope } as unknown as LunoraDb<D>;
};
