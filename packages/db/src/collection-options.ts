/* eslint-disable no-underscore-dangle -- `_id` is the Lunora document-id field this binding keys rows by */
import type { FunctionReference, LunoraClient, SubscriptionError } from "@lunora/client";
import type { CollectionConfig } from "@tanstack/db";
import { BTreeIndex } from "@tanstack/db";

import type { Row } from "./internals";
import { makeDiffEmit, toMap } from "./internals";

/**
 * A monotonic watermark gate. `await(threshold)` resolves once `advance` has been
 * called with a value `>= threshold`; a threshold already passed resolves
 * immediately. Used to hold a TanStack optimistic overlay until the server
 * confirms the write's checkpoint / mutation id.
 */
interface Gate {
    advance: (value: number) => void;
    await: (threshold: number) => Promise<void>;
}

const createGate = (): Gate => {
    let highest = Number.NEGATIVE_INFINITY;
    const waiters: { resolve: () => void; threshold: number }[] = [];

    return {
        advance: (value) => {
            if (value <= highest) {
                return;
            }

            highest = value;

            for (let index = waiters.length - 1; index >= 0; index -= 1) {
                const waiter = waiters[index];

                if (waiter && waiter.threshold <= highest) {
                    waiter.resolve();
                    waiters.splice(index, 1);
                }
            }
        },
        await: (threshold) => {
            if (threshold <= highest) {
                return Promise.resolve();
            }

            return new Promise<void>((resolve) => {
                waiters.push({ resolve, threshold });
            });
        },
    };
};

/**
 * Resolves the TanStack optimistic-overlay drop against the server's confirmed
 * watermarks. A mutator's optimistic transaction returns `awaitMutationId(id)`
 * (or `awaitCheckpoint(cursor)`); TanStack keeps the overlay until that promise
 * settles, so the row de-duplicates exactly as the synced server value lands — no
 * flash of the optimistic row disappearing then reappearing.
 *
 * `resolve` is called by whoever owns the watermark stream — a `data`/`delta`
 * frame's `lastMutationId`, or a shape poke's `checkpoint` — to advance the gates.
 */
export interface CheckpointRegistry {
    /** Resolve once the server has acknowledged the op-log `cursor`. */
    awaitCheckpoint: (cursor: number) => Promise<void>;
    /** Resolve once the server has echoed a `lastMutationId >= id` for this client. */
    awaitMutationId: (id: number) => Promise<void>;
    /** Advance the gates from a frame's watermark; later callers past the mark settle immediately. */
    resolve: (watermark: { checkpoint?: number; mutationId?: number }) => void;
}

/** A standalone checkpoint/mutation-id registry (also embedded in {@link lunoraCollectionOptions}). */
export const createCheckpointRegistry = (): CheckpointRegistry => {
    const checkpointGate = createGate();
    const mutationGate = createGate();

    return {
        awaitCheckpoint: (cursor) => checkpointGate.await(cursor),
        awaitMutationId: (id) => mutationGate.await(id),
        resolve: ({ checkpoint, mutationId }) => {
            if (checkpoint !== undefined) {
                checkpointGate.advance(checkpoint);
            }

            if (mutationId !== undefined) {
                mutationGate.advance(mutationId);
            }
        },
    };
};

/**
 * A replication-shape sync source (the local-first partial-replication path).
 * Mutually exclusive with {@link LunoraCollectionConfig.list}: the collection
 * live-syncs the named shape's rowset via the client's poke protocol
 * (`subscribeShape`) instead of a full-table `list` query subscription.
 */
export interface ShapeSource {
    /** Validated shape parameters (the partition selector — e.g. `{ channelId }`). */
    args?: Record<string, unknown>;
    /** The `defineShape` export name registered in `LUNORA_SHAPES`. */
    name: string;
    /** Routes the subscription to a specific shard's DO when the table is sharded. */
    shardKey?: string;
}

/** Declarative inputs for {@link lunoraCollectionOptions}. */
export interface LunoraCollectionConfig<TRow extends Row> {
    /** The Lunora client to subscribe through. */
    client: LunoraClient;
    /** Row key extractor — defaults to `row._id`. */
    getKey?: (row: TRow) => string;
    /** Collection id (TanStack identity) — defaults to the `list` function path (or `shape:` + the shape name). */
    id?: string;
    /** The Lunora query that lists the rows (the full-table sync source). Mutually exclusive with {@link LunoraCollectionConfig.shape}. */
    list?: FunctionReference;
    /** Notified when the underlying subscription errors; the collection always leaves `loading` regardless. */
    onError?: (error: SubscriptionError) => void;
    /** When set, the collection stays empty until {@link LunoraCollectionOptions.scope} points it at args (sharded). */
    scopeBy?: string;
    /** A replication shape as the sync source (partial replication). Mutually exclusive with {@link LunoraCollectionConfig.list}. */
    shape?: ShapeSource;
}

/** The result of {@link lunoraCollectionOptions}: a TanStack collection config plus its sync controls. */
export interface LunoraCollectionOptions<TRow extends Row> {
    /** Resolves optimistic-overlay drops against the server's confirmed watermarks. */
    checkpoints: CheckpointRegistry;
    /** Pass to TanStack's `createCollection`. */
    config: CollectionConfig<TRow, string>;
    /** Re-point a `scopeBy` collection's subscription (omit `args` to detach). No-op for unscoped collections. */
    scope: (args?: Record<string, unknown>) => void;
}

/**
 * Build a TanStack DB collection config (+ sync controls) that live-syncs a
 * Lunora `list` query through the client. This is the reusable core lifted out of
 * {@link import("./define-collections").defineCollections}: the same `makeDiffEmit`
 * diff-into-channel, `autoIndex:"eager"` + B-tree indexes, scoped-resubscribe, and
 * fail-safe `markReady`-on-error behavior, exposed as a standalone
 * collection-options creator so apps (and codegen) can compose it directly.
 *
 * The returned `checkpoints` registry lets a mutator runtime resolve optimistic
 * overlays against confirmed server watermarks (see {@link CheckpointRegistry}).
 */
export const lunoraCollectionOptions = <TRow extends Row>(options: LunoraCollectionConfig<TRow>): LunoraCollectionOptions<TRow> => {
    if ((options.list === undefined) === (options.shape === undefined)) {
        throw new Error("lunoraCollectionOptions: pass exactly one of `list` or `shape`");
    }

    const getKey = options.getKey ?? ((row: TRow) => row._id);
    const checkpoints = createCheckpointRegistry();
    // JSON-serialized form of each last-synced row, keyed by row id.
    // Owned here (outside sync.sync) so it persists correctly across sync
    // restarts — a new makeDiffEmit closure on restart receives the same
    // reference and starts from the committed synced state.
    const syncedJson = new Map<string, string>();

    // Mutable sync handles, populated when TanStack calls the `sync` closure and
    // driven by `scope(...)` from outside it.
    let emit: ((next: Map<string, TRow>) => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    let onErrorHandler: ((error: SubscriptionError) => void) | undefined;

    // Open the underlying sync source — a full-table `list` query subscription or
    // a replication-`shape` poke subscription — with one uniform callback shape.
    // `onReady` is invoked on the first rowset so the collection leaves `loading`.
    const openSubscription = (args: Record<string, unknown>, onReady: (() => void) | undefined): (() => void) => {
        // Typed `unknown` so the one callback satisfies both sync sources: a `list`
        // query's `(data: ReturnOf<F>)` and a shape's `(rows: Record<string, unknown>[])`.
        const onRows = (data: unknown): void => {
            emit?.(toMap(data as TRow[], getKey));
            onReady?.();

            // The shape path resolves the registry from the poke `checkpoint`,
            // and the list path resolves it from the `onCheckpoint` watermark a
            // `settled` frame forwards (both wired below). A `list` *data* frame
            // carries no per-frame watermark, so advance from the client's
            // server-confirmed custom-mutator watermark (the push-ack stream) as
            // synced rows land — a `bindMutators` optimistic overlay then drops
            // exactly when the server rows arrive instead of `awaitMutationId`
            // hanging forever after the write is accepted.
            if (options.shape === undefined) {
                checkpoints.resolve({ mutationId: options.client.confirmedMutationWatermark() });
            }
        };
        const onError = (error: SubscriptionError): void => onErrorHandler?.(error);

        // Advance the registry as the source syncs, so a mutator runtime can drop
        // optimistic overlays once the server's rows (or a `settled` no-change
        // acknowledgement) have landed. Both paths forward the same watermark
        // shape, so the handler is identical.
        const onCheckpoint = (watermark: { checkpoint?: number; mutationId?: number }): void => {
            checkpoints.resolve(watermark);
        };

        if (options.shape !== undefined) {
            return options.client.subscribeShape({ args, name: options.shape.name }, onRows, {
                onCheckpoint,
                onError,
                shardKey: options.shape.shardKey,
            });
        }

        return options.client.subscribe(options.list as FunctionReference, args, onRows, { onCheckpoint, onError });
    };

    const config: CollectionConfig<TRow, string> = {
        // Auto-build ordered (B-tree) indexes for whatever the app's live queries
        // join / filter / sort on, so they stay fast as the dataset grows.
        autoIndex: "eager",
        defaultIndexType: BTreeIndex,
        getKey,
        id: options.id ?? options.list?.__lunoraRef ?? `shape:${options.shape?.name ?? ""}`,
        sync: {
            sync: (writer) => {
                emit = makeDiffEmit<TRow>(syncedJson, writer);

                // Surface a subscription error and move the collection out of
                // `loading`, so a rejected subscription never hangs it forever.
                const onError = (error: SubscriptionError): void => {
                    writer.markReady();
                    options.onError?.(error);
                };

                onErrorHandler = onError;

                if (options.scopeBy === undefined) {
                    // A shape's own `args` select its partition up front; a `list`
                    // syncs the whole table (empty args).
                    unsubscribe = openSubscription(options.shape?.args ?? {}, () => {
                        writer.markReady();
                    });
                } else {
                    // Scoped collection: empty until `scope(args)` points it.
                    writer.markReady();
                }

                return () => {
                    emit = undefined;
                    onErrorHandler = undefined;
                    unsubscribe?.();
                    unsubscribe = undefined;
                };
            },
        },
    };

    const scope = (args?: Record<string, unknown>): void => {
        if (options.scopeBy === undefined) {
            return;
        }

        unsubscribe?.();
        unsubscribe = undefined;
        // Clear the previous scope's rows from the synced view.
        emit?.(new Map());

        if (args === undefined) {
            return;
        }

        unsubscribe = openSubscription(args, undefined);
    };

    return { checkpoints, config, scope };
};
