/* eslint-disable no-underscore-dangle -- `_id` is the Cirrus document-id field this binding keys rows by */
/* eslint-disable import/exports-last -- a types-heavy module: public types are declared next to the helpers they build on */
import type { CirrusClient, FunctionReference } from "@cirrus/client";
import type { Collection, Transaction } from "@tanstack/db";
import { BTreeIndex, createCollection } from "@tanstack/db";
import type { OfflineConfig, OfflineExecutor } from "@tanstack/offline-transactions";
import { startOfflineExecutor } from "@tanstack/offline-transactions";

import type { Row } from "./internals";
import { createOptimisticOnlineDetector, makeDiffEmit, runOutboxMutation, toMap } from "./internals";

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
    /** The Cirrus mutation that persists the row. */
    mutation: FunctionReference;
    /** Build the optimistic row to insert from the action input + the generated client id. */
    optimistic: (input: TInput, id: string) => TRow;
    /** Build the mutation args from the persisted optimistic row (forward `_id` as the `clientId`). */
    toArgs: (row: TRow) => Record<string, unknown>;
}

/** Declarative binding of a Cirrus table to a live collection (+ optional write action). */
// eslint-disable-next-line unicorn/prevent-abbreviations -- "Def" reads well for a declarative collection definition; "Definition" is noise
export interface CollectionDef<TList extends FunctionReference, TInput = never> {
    /** Row key extractor — defaults to `row._id`. */
    getKey?: (row: RowOfList<TList>) => string;
    /** Optional write binding — present iff this collection is written through the outbox. */
    insert?: InsertBinding<RowOfList<TList>, TInput>;
    /** The Cirrus query that lists the rows (the sync source). */
    list: TList;
    /** A field that scopes the list (e.g. a shard key); makes the collection re-pointable via `scope`. */
    scopeBy?: string;
}

// A collection def with its type params erased to `any` (not `FunctionReference`/
// `unknown`): pinning `TList` to the base `FunctionReference` collapses the row
// type to `never`, and `TInput` is contravariant. The precise per-entry types are
// recovered from each concrete `D[K]` via `RowOf` / `InputOf`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any, unicorn/prevent-abbreviations -- see comment above; "AnyDef" mirrors `CollectionDef`
type AnyDef = CollectionDef<any, any>;

/**
 * The public row type a collection exposes — the element type of its `list`
 * query's return, with no `& Row`: a `Collection&lt;T>` is invariant in `T`, so the
 * exposed type must be exactly the document type, not a subtype.
 */
type RowOf<C extends AnyDef> = C["list"] extends FunctionReference<infer _K, infer _A, infer R> ? Element<R> : never;

/** The action input type, inferred structurally from the def's optimistic insert. */
type InputOf<C> = C extends { insert: { optimistic: (input: infer I, id: string) => unknown } } ? I : never;

/** The wired data layer `defineCollections` returns. */
// eslint-disable-next-line unicorn/prevent-abbreviations -- "Db" matches the package name `@cirrus/db`
export interface CirrusDb<D extends Record<string, AnyDef>> {
    /** Optimistic, durable, retried write actions — present for `insert` collections. */
    actions: { [K in keyof D]: D[K] extends { insert: object } ? (input: InputOf<D[K]>) => { id: string; transaction: Transaction } : never };
    /** The live, synced collections — feed these to `useLiveQuery`. */
    collections: { [K in keyof D]: Collection<RowOf<D[K]>, string> };
    /** The shared offline executor (the outbox). */
    executor: OfflineExecutor;
    /** Re-point a `scopeBy` collection's subscription (omit `args` to detach) — present for scoped collections. */
    scope: { [K in keyof D]: D[K] extends { scopeBy: string } ? (args?: Record<string, unknown>) => void : never };
}

/**
 * Wire a set of Cirrus tables into a TanStack DB data layer in one declaration:
 * each entry becomes a live, auto-indexed collection synced from its `list` query,
 * and `insert` entries get an optimistic write action backed by the
 * offline-transactions outbox (durable, retried, client-id-keyed). Scoped
 * (`scopeBy`) collections are re-pointable for sharded queries.
 *
 * This is the hand-written form; `@cirrus/codegen` can emit a fully-typed call to
 * it from `schema.ts`, so an app writes nothing.
 */
export const defineCollections = <D extends Record<string, AnyDef>>(client: CirrusClient, defs: D): CirrusDb<D> => {
    const collections: Record<string, Collection<Row, string>> = {};
    const scope: Record<string, (args?: Record<string, unknown>) => void> = {};
    const subscriptions: Record<string, (() => void) | undefined> = {};
    const emitters: Record<string, ((rows: Map<string, Row>) => void) | undefined> = {};
    const mutationFns: OfflineConfig["mutationFns"] = {};

    const entries = Object.entries(defs);

    for (const [name, definition] of entries) {
        const getKey = definition.getKey ?? ((row: Row) => row._id);
        const insert = definition.insert as InsertBinding<Row, unknown> | undefined;
        const synced = new Map<string, Row>();

        collections[name] = createCollection<Row, string>({
            // Auto-build ordered (B-tree) indexes for whatever the app's live
            // queries join / filter / sort on, so they stay fast as data grows.
            autoIndex: "eager",
            defaultIndexType: BTreeIndex,
            getKey,
            id: name,
            sync: {
                sync: (writer) => {
                    const emit = makeDiffEmit<Row>(synced, writer);
                    emitters[name] = emit;

                    if (definition.scopeBy === undefined) {
                        // Static collection: subscribe to the unscoped list now.
                        subscriptions[name] = client.subscribe(definition.list, {}, (rows) => {
                            emit(toMap(rows as Row[], getKey));
                            writer.markReady();
                        });
                    } else {
                        // Scoped collection: stays empty until `scope[name](args)`.
                        writer.markReady();
                    }

                    return () => {
                        emitters[name] = undefined;
                        subscriptions[name]?.();
                        subscriptions[name] = undefined;
                    };
                },
            },
        });

        if (definition.scopeBy !== undefined) {
            scope[name] = (args) => {
                subscriptions[name]?.();
                subscriptions[name] = undefined;
                // Clear the previous scope's rows from the synced view.
                emitters[name]?.(new Map());

                if (args === undefined) {
                    return;
                }

                subscriptions[name] = client.subscribe(definition.list, args, (rows) => {
                    emitters[name]?.(toMap(rows as Row[], getKey));
                });
            };
        }

        if (insert) {
            mutationFns[name] = async ({ transaction }) => {
                for (const mutation of transaction.mutations) {
                    const row = mutation.modified as unknown as Row;

                    // eslint-disable-next-line no-await-in-loop -- sequential keeps the outbox's FIFO ordering
                    await runOutboxMutation(() => client.mutation(insert.mutation, insert.toArgs(row)));
                }
            };
        }
    }

    const executor = startOfflineExecutor({
        collections,
        mutationFns,
        onlineDetector: createOptimisticOnlineDetector(),
    });

    const actions: Record<string, (input: unknown) => { id: string; transaction: Transaction }> = {};

    for (const [name, definition] of entries) {
        const insert = definition.insert as InsertBinding<Row, unknown> | undefined;
        const collection = collections[name];

        if (!insert || !collection) {
            continue;
        }

        const action = executor.createOfflineAction<{ id: string; input: unknown }>({
            mutationFnName: name,
            onMutate: ({ id, input }) => {
                collection.insert(insert.optimistic(input, id));
            },
        });

        actions[name] = (input) => {
            // eslint-disable-next-line n/no-unsupported-features/node-builtins -- runs in browser/edge/Node ≥22; `crypto.randomUUID` is available in all of them
            const id = crypto.randomUUID();
            const transaction = action({ id, input });

            return { id, transaction };
        };
    }

    return { actions, collections, executor, scope } as unknown as CirrusDb<D>;
};
