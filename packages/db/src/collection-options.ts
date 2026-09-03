import type { FunctionReference, LunoraClient, SubscriptionError } from "@lunora/client";
import { LunoraError } from "@lunora/errors";
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
    /** Whether `threshold` has already been reached (so no waiting is needed). */
    passed: (threshold: number) => boolean;

    /**
     * Settle every parked waiter, then rewind the watermark to "nothing
     * confirmed". For an identity switch: the previous identity's writes are
     * already durable server-side (so its waiters must settle, not hang), while
     * the new identity starts a fresh sequence space the old mark must not
     * answer for.
     */
    reset: () => void;
    /** How many waiters are still held — a diagnostics read. */
    waiting: () => number;
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
        passed: (threshold) => threshold <= highest,
        reset: () => {
            for (const waiter of waiters.splice(0)) {
                waiter.resolve();
            }

            highest = Number.NEGATIVE_INFINITY;
        },
        waiting: () => waiters.length,
    };
};

/** One-shot warning so a lossy sync stream is noticed without spamming the console per write. */
let warnedCheckpointFallback = false;

/** Default `onFallback` for {@link createCheckpointRegistry} — warns once per process. */
const defaultOnFallback = (event: CheckpointFallbackEvent): void => {
    if (warnedCheckpointFallback) {
        return;
    }

    warnedCheckpointFallback = true;

    // eslint-disable-next-line no-console
    console.warn(
        `[@lunora/db] released an optimistic overlay via the ${String(event.waitedMs)}ms checkpoint fallback: the server confirmed ` +
            `${event.kind} ${String(event.watermark)} but no sync frame ever echoed it. A dropped shape poke or \`settled\` frame is the ` +
            `usual cause — inspect the subscription rather than raising \`fallbackMs\`. (Reported once per process.)`,
    );
};

/**
 * Live per-shard registries, keyed by client then shard key. Read by
 * {@link getShardCheckpoints}.
 *
 * A registry MUST be shared by every collection on the same shard. `clientSeq` is
 * per-client-per-shard and `bindMutators` pushes all its mutators down one FIFO
 * chain, so the watermark a write waits on is advanced by whichever subscription
 * happens to be poked first. A registry minted per collection therefore hangs:
 * writing `tagColors` advances the shard watermark, the `tagColors` registry hears
 * the poke, and the `nodes` registry's `awaitMutationId` never settles — leaving
 * that transaction's `isPersisted` pending forever.
 */
const registriesByClient = new WeakMap<LunoraClient, Map<string, CheckpointRegistry>>();

/**
 * The identity each client's registries last advanced under. The server keys its
 * mutation watermark per identity (and `bindMutators` resets `clientSeq` on an
 * identity change to match), so a registry whose gates advanced under user A
 * would answer user B's `awaitMutationId(1)` immediately — dropping the overlay
 * before B's authoritative row synced. {@link getShardCheckpoints} checks this
 * lazily on every call and rewinds the client's registries in place (see
 * {@link registryResets}), mirroring `resetCounterForIdentity` in
 * `define-mutators.ts` (there is no identity-change event to subscribe to).
 *
 * The identity is whatever `client.currentIdentity()` reports, which is
 * deliberately the SAME key `confirmedMutationWatermark` buckets by. Without a
 * stable `subject` passed to `setAuthToken` that key is a token hash, so a plain
 * token refresh reads as an identity change and rewinds here — which is correct,
 * not incidental: the client's watermark cache and `bindMutators`' `clientSeq`
 * rewind on exactly the same signal, and a registry left ahead of a
 * freshly-zeroed sequence space would release every subsequent overlay
 * immediately. (An app that wants refreshes to be transparent passes `subject` —
 * the same guidance the watermark cache already carries.)
 */
const identityByClient = new WeakMap<LunoraClient, string | null>();

/**
 * Registries that have a sync source wired to them. Read by
 * {@link hasCheckpointsAttached}.
 *
 * `bindMutators` gates an overlay on the shard's registry only if *something*
 * advances it — otherwise the mutator would wait out the whole fallback window on
 * every write. A `lunoraCollectionOptions` call marks its registry here at creation
 * time (not at first sync), because a lazily-syncing collection still means the
 * watermark stream exists and will confirm the write.
 *
 * Package-internal: deliberately not re-exported from `index.ts`.
 */
const attachedRegistries = new WeakSet<CheckpointRegistry>();

/**
 * Identity-switch reset hooks for registries built by
 * {@link createCheckpointRegistry}. Read by {@link getShardCheckpoints}'s sweep.
 *
 * A switch must rewind a shard's watermark space WITHOUT swapping the registry
 * object: the documented wiring captures `checkpoints` once from
 * `lunoraCollectionOptions` and hands it to `bindMutators` as an EXPLICIT
 * registry (always honored, never re-derived), and codegen's
 * `<shape>Collection()` returns it the same way. Replacing the instance would
 * leave every one of those captures pointed at a retired gate — resolved to
 * `Infinity` by its teardown, so each post-switch `awaitMutationId` returns
 * already-settled and the overlay drops before the new identity's row syncs.
 * Resetting in place keeps every captured reference live (and keeps the shard's
 * {@link attachedRegistries} mark, so the first post-switch write is still gated).
 *
 * Package-internal, like {@link attachedRegistries}: an app resetting a live
 * registry by hand would silently un-gate whatever is in flight.
 */
const registryResets = new WeakMap<CheckpointRegistry, () => void>();

/** A watermark pair — the two monotonic lines a checkpoint registry gates on. */
export interface CheckpointWatermark {
    /** Op-log cursor the server has durably applied. */
    checkpoint?: number;
    /** Highest `clientSeq` the server has echoed back for this client. */
    mutationId?: number;
}

/** Reported when the fallback releases an overlay the sync stream never confirmed. */
export interface CheckpointFallbackEvent {
    /** Which gate released. */
    kind: "checkpoint" | "mutationId";
    /** How long the release waited past the server acknowledgement, in ms. */
    waitedMs: number;
    /** The watermark that was acknowledged but never confirmed by a sync frame. */
    watermark: number;
}

/** Counters for {@link CheckpointRegistry.stats} — feeds a debug/diagnostics surface. */
export interface CheckpointRegistryStats {
    /** How many times the fallback timer released an overlay (a non-zero value means sync frames are being lost). */
    fallbacks: number;
    /** Overlays currently waiting on a checkpoint cursor. */
    pendingCheckpointWaiters: number;
    /** Overlays currently waiting on a mutation id. */
    pendingMutationWaiters: number;
}

/** Tuning for {@link createCheckpointRegistry}. */
export interface CheckpointRegistryOptions {
    /**
     * How long an {@link CheckpointRegistry.acknowledge}d watermark waits for the
     * authoritative sync frame before the overlay is released anyway. Default 3000.
     * `0` disables the fallback (an overlay then waits forever for the frame — the
     * pre-fallback behavior, which hangs on a dropped poke).
     */
    fallbackMs?: number;

    /**
     * Notified each time the fallback fires. A fallback is never *correct* — it
     * means a poke or `settled` frame that should have confirmed the write never
     * arrived — so this is the hook for a warning or a metric. Defaults to a
     * one-shot `console.warn`.
     */
    onFallback?: (event: CheckpointFallbackEvent) => void;
}

/**
 * Resolves the TanStack optimistic-overlay drop against the server's confirmed
 * watermarks. A mutator's optimistic transaction returns `awaitMutationId(id)`
 * (or `awaitCheckpoint(cursor)`); TanStack keeps the overlay until that promise
 * settles, so the row de-duplicates exactly as the synced server value lands — no
 * flash of the optimistic row disappearing then reappearing.
 *
 * Two inputs, deliberately distinct:
 *
 * - {@link CheckpointRegistry.resolve} is the **authoritative** advance, called by whoever owns
 * the watermark stream — a `data`/`delta` frame's `lastMutationId`, or a shape poke's
 * `checkpoint`. The synced rows have landed, so gates open immediately.
 * - {@link CheckpointRegistry.acknowledge} is the **provisional** advance, called when the server
 * has accepted the write (the mutator RPC ack) but the matching rows have not
 * necessarily been delivered yet. Releasing here would drop the overlay before
 * the synced row exists — a visible flicker — so instead it arms a bounded
 * fallback. If the authoritative frame lands first the fallback is cancelled;
 * if it never lands, the overlay is released after `fallbackMs` and the event is
 * reported rather than hanging forever.
 *
 * That pairing is why a lost poke degrades to a late overlay drop instead of a
 * permanently stuck `isPersisted` promise.
 */
export interface CheckpointRegistry {
    /**
     * Record a server-accepted watermark whose rows may not have synced yet: arms
     * the bounded fallback described on {@link CheckpointRegistry}. Safe to call
     * repeatedly; a watermark already passed is a no-op.
     */
    acknowledge: (watermark: CheckpointWatermark) => void;
    /** Resolve once the server has acknowledged the op-log `cursor`. */
    awaitCheckpoint: (cursor: number) => Promise<void>;
    /** Resolve once the server has echoed a `lastMutationId >= id` for this client. */
    awaitMutationId: (id: number) => Promise<void>;

    /**
     * Tear the registry down: `clearTimeout` every armed fallback timer and empty
     * the armed set. Idempotent. A discarded registry (Vite HMR dispose, sign-out)
     * can otherwise hold up to `fallbackMs` of pending `setTimeout`s alive through
     * their closures — keeping a Node/SSR event loop from draining. Distinct from
     * {@link CheckpointRegistry.resolve}: `resolve` settles parked *waiters* (and disarms the timers it
     * subsumes as a side effect); `dispose` guarantees no armed timer survives,
     * independent of any watermark.
     */
    dispose: () => void;
    /** Advance the gates from a sync frame's watermark; later callers past the mark settle immediately. */
    resolve: (watermark: CheckpointWatermark) => void;
    /** Diagnostics counters — notably how often the fallback had to fire. */
    stats: () => CheckpointRegistryStats;
}

/** Default fallback window: long enough that a slow-but-arriving poke wins, short enough that a UI isn't visibly stuck. */
export const CHECKPOINT_FALLBACK_MS = 3000;

/**
 * A standalone checkpoint/mutation-id registry. Prefer {@link getShardCheckpoints}
 * unless you are wiring a bespoke watermark stream — a registry must be shared by
 * every collection on a shard (see that function for why).
 */
export const createCheckpointRegistry = (options: CheckpointRegistryOptions = {}): CheckpointRegistry => {
    const fallbackMs = options.fallbackMs ?? CHECKPOINT_FALLBACK_MS;
    const onFallback = options.onFallback ?? defaultOnFallback;

    const checkpointGate = createGate();
    const mutationGate = createGate();

    let fallbacks = 0;

    /** Armed fallback timers, so an authoritative `resolve` can cancel the ones it subsumes. */
    const armed = new Set<{ handle: ReturnType<typeof setTimeout>; kind: "checkpoint" | "mutationId"; threshold: number }>();

    const disarmUpTo = (kind: "checkpoint" | "mutationId", highest: number): void => {
        for (const entry of armed) {
            if (entry.kind === kind && entry.threshold <= highest) {
                clearTimeout(entry.handle);
                armed.delete(entry);
            }
        }
    };

    const arm = (kind: "checkpoint" | "mutationId", threshold: number): void => {
        if (fallbackMs <= 0) {
            return;
        }

        const gate = kind === "checkpoint" ? checkpointGate : mutationGate;

        // Nothing to wait for: the authoritative frame already passed this mark.
        if (gate.passed(threshold)) {
            return;
        }

        for (const entry of armed) {
            // An earlier-or-equal armed threshold of the same kind already covers
            // this one — when it fires it advances the gate past both.
            if (entry.kind === kind && entry.threshold >= threshold) {
                return;
            }
        }

        const entry = {
            handle: setTimeout(() => {
                armed.delete(entry);

                if (gate.passed(threshold)) {
                    return;
                }

                fallbacks += 1;
                gate.advance(threshold);

                try {
                    onFallback({ kind, waitedMs: fallbackMs, watermark: threshold });
                } catch {
                    // A throwing diagnostics listener must not break the release.
                }
            }, fallbackMs),
            kind,
            threshold,
        };

        armed.add(entry);
    };

    const registry: CheckpointRegistry = {
        acknowledge: ({ checkpoint, mutationId }) => {
            if (checkpoint !== undefined) {
                arm("checkpoint", checkpoint);
            }

            if (mutationId !== undefined) {
                arm("mutationId", mutationId);
            }
        },
        awaitCheckpoint: (cursor) => checkpointGate.await(cursor),
        awaitMutationId: (id) => mutationGate.await(id),
        dispose: () => {
            for (const entry of armed) {
                clearTimeout(entry.handle);
            }

            armed.clear();
        },
        resolve: ({ checkpoint, mutationId }) => {
            if (checkpoint !== undefined) {
                checkpointGate.advance(checkpoint);
                disarmUpTo("checkpoint", checkpoint);
            }

            if (mutationId !== undefined) {
                mutationGate.advance(mutationId);
                disarmUpTo("mutationId", mutationId);
            }
        },
        stats: () => {
            return {
                fallbacks,
                pendingCheckpointWaiters: checkpointGate.waiting(),
                pendingMutationWaiters: mutationGate.waiting(),
            };
        },
    };

    // Identity-switch rewind (see `registryResets`): drop armed timers, settle
    // the previous identity's parked waiters, and empty both watermark spaces —
    // all without replacing the object every consumer captured.
    registryResets.set(registry, () => {
        registry.dispose();
        checkpointGate.reset();
        mutationGate.reset();
    });

    return registry;
};

/**
 * Release every pending overlay gate for `client` and drop its shard registries.
 *
 * The hot-reload / teardown escape hatch. When a module that owns collections and
 * mutators is replaced — a Vite HMR update, a sign-out that rebuilds the data layer
 * — the *old* bindings may still have transactions parked in `awaitMutationId`. The
 * subscriptions that would have resolved them are gone with the old module, so
 * without this those promises never settle and every one of their
 * `transaction.isPersisted` waiters hangs forever.
 *
 * Resolving to `Infinity` settles the parked waiters (the writes were already sent;
 * the server is authoritative regardless), and dropping the registries means the
 * replacement module's bindings start from a clean per-shard gate.
 *
 * ```ts
 * // In the module that owns the data layer:
 * import.meta.hot?.dispose(() => releaseShardCheckpoints(client));
 * ```
 */
export const releaseShardCheckpoints = (client: LunoraClient): void => {
    const byShard = registriesByClient.get(client);

    if (!byShard) {
        return;
    }

    for (const registry of byShard.values()) {
        // Settle every parked waiter (the writes were already sent; the server is
        // authoritative), then guarantee no armed fallback timer outlives the
        // discarded registry — `resolve` disarms the timers it subsumes, but
        // `dispose` makes the teardown explicit and independent of that side effect.
        registry.resolve({ checkpoint: Number.POSITIVE_INFINITY, mutationId: Number.POSITIVE_INFINITY });
        registry.dispose();
    }

    registriesByClient.delete(client);
};

/**
 * Rewind `client`'s shard registries if the signed-in identity has moved since
 * they last advanced. Idempotent and cheap (one `currentIdentity()` read on the
 * no-change path), so every entry point into the watermark protocol can call it.
 *
 * Called from {@link getShardCheckpoints} (the collections' side) AND from
 * `bindMutators`' `resetCounterForIdentity` (the write side). Both are needed:
 * a mutator bound with an EXPLICIT registry — which is what the documented
 * wiring and codegen's `<shape>Collection()` produce, since they capture
 * `checkpoints` once and pass it down — never re-derives through
 * `getShardCheckpoints`, so the collections' entry point alone would leave the
 * first post-switch write gated on the previous identity's watermark. Pairing it
 * with the `clientSeq` reset keeps the two halves of the protocol rewinding on
 * one signal: a registry left ahead of a freshly-zeroed sequence space answers
 * every later `awaitMutationId` immediately.
 *
 * Registries the caller built themselves ({@link createCheckpointRegistry}) are
 * not in the derived map and are never touched — the caller owns their lifecycle.
 *
 * Package-internal: deliberately not re-exported from `index.ts`.
 */
export const syncShardCheckpointIdentity = (client: LunoraClient): void => {
    const identity = client.currentIdentity();

    if (registriesByClient.has(client) && identityByClient.get(client) !== identity) {
        // The registries' watermarks belong to the PREVIOUS identity. Rewind each
        // in place — settling its parked waiters and emptying its gates — rather
        // than dropping the map: every consumer that captured this shard's
        // registry keeps pointing at the object being reset, and the shard stays
        // marked attached, so the first write under the new identity is still gated.
        for (const registry of registriesByClient.get(client)?.values() ?? []) {
            registryResets.get(registry)?.();
        }
    }

    identityByClient.set(client, identity);
};

/**
 * The shared checkpoint registry for `client` + `shardKey` — created on first use.
 * This is the registry {@link lunoraCollectionOptions} and
 * {@link import("./define-mutators").bindMutators} default to, which is what makes
 * a multi-collection shard work without the caller relaying pokes between
 * registries by hand.
 *
 * `options` applies **only when the registry is created**. Because the point is that
 * every collection and mutator on a shard shares one gate, a later call cannot
 * retune an existing registry — it returns the existing one and `options` is ignored.
 * To control `fallbackMs` / `onFallback`, build the registry yourself with
 * {@link createCheckpointRegistry} and pass it explicitly to every
 * `lunoraCollectionOptions` and `bindMutators` call for that shard.
 */
export const getShardCheckpoints = (client: LunoraClient, shardKey?: string, options?: CheckpointRegistryOptions): CheckpointRegistry => {
    syncShardCheckpointIdentity(client);

    let byShard = registriesByClient.get(client);

    if (!byShard) {
        byShard = new Map<string, CheckpointRegistry>();
        registriesByClient.set(client, byShard);
    }

    const key = shardKey ?? "";
    const existing = byShard.get(key);

    if (existing) {
        return existing;
    }

    const registry = createCheckpointRegistry(options);

    byShard.set(key, registry);

    return registry;
};

/** Mark `registry` as fed by a live sync source. */
export const markCheckpointsAttached = (registry: CheckpointRegistry): void => {
    attachedRegistries.add(registry);
};

/** Whether any sync source will advance `registry`'s watermarks. */
export const hasCheckpointsAttached = (registry: CheckpointRegistry): boolean => attachedRegistries.has(registry);

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
    /**
     * The registry optimistic overlays are gated on. Defaults to the shared
     * per-shard registry ({@link getShardCheckpoints}), which is what a
     * multi-collection shard needs — pass one explicitly only to isolate a
     * collection's gate (tests) or to supply custom {@link CheckpointRegistryOptions}.
     */
    checkpoints?: CheckpointRegistry;
    /** The Lunora client to subscribe through. */
    client: LunoraClient;
    /** Row key extractor — defaults to `row._id`. */
    getKey?: (row: TRow) => string;
    /** Collection id (TanStack identity) — defaults to the `list` function path (or `shape:` + the shape name). */
    id?: string;
    /** The Lunora query that lists the rows (the full-table sync source). Mutually exclusive with {@link LunoraCollectionConfig.shape}. */
    list?: FunctionReference;

    /**
     * When the collection starts syncing. `"lazy"` (default) starts on the first
     * `useLiveQuery` subscriber; `"eager"` starts at creation (TanStack's
     * `startSync`) — for small "instant" reference data you want warm at boot.
     * No effect on a `scopeBy` collection, which has nothing to sync until scoped.
     * (Even eager, TanStack pauses sync while there are no subscribers, per its
     * `gcTime` lifecycle — "warm while referenced", not pinned forever.)
     */
    load?: "eager" | "lazy";
    /** Notified when the underlying subscription errors; the collection always leaves `loading` regardless. */
    onError?: (error: SubscriptionError) => void;
    /** When set, the collection stays empty until {@link LunoraCollectionOptions.scope} points it at args (sharded). */
    scopeBy?: string;

    /** A replication shape as the sync source (partial replication). Mutually exclusive with {@link LunoraCollectionConfig.list}. */
    shape?: ShapeSource;

    /**
     * Routes the `list` subscription — and the confirmed-mutation watermark its
     * data/`settled` frames advance the checkpoint gate from — to a specific
     * shard's DO. Applies to the `list` source; a `shape` carries its own
     * {@link ShapeSource.shardKey}. Without it the list path falls back to the
     * default ("") watermark bucket, which must not be compared against a
     * per-shard mutator's sequence line (it would drop a sharded overlay early or
     * hang it forever).
     */
    shardKey?: string;
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
        throw new LunoraError("INTERNAL", "lunoraCollectionOptions: pass exactly one of `list` or `shape`");
    }

    const getKey = options.getKey ?? ((row: TRow) => row._id);
    // Shared per-shard by default — a per-collection registry hangs any shard with
    // more than one collection (see `getShardCheckpoints`). A `shape` carries its
    // own shard key; the `list` path uses the top-level one. The sync callbacks
    // re-resolve rather than close over the capture below, because
    // {@link disposeShardCheckpoints} drops the whole per-client map: a
    // collection still mounted across that teardown must advance the registry a
    // later {@link getShardCheckpoints} mints, not the disposed one it was built
    // with (whose gates resolve to `Infinity`, so every overlay drops ungated).
    // An identity switch is NOT such a case — {@link syncShardCheckpointIdentity}
    // rewinds each registry IN PLACE precisely so captures stay valid; see
    // {@link registryResets}.
    const resolveCheckpoints = (): CheckpointRegistry => {
        const registry = options.checkpoints ?? getShardCheckpoints(options.client, options.shape?.shardKey ?? options.shardKey);

        // This collection's subscription is what advances the registry — record
        // that so `bindMutators` knows gating an overlay on it will actually
        // settle. Re-marked on every resolve so a post-teardown replacement
        // registry is covered too (a WeakSet add is idempotent).
        markCheckpointsAttached(registry);

        return registry;
    };

    const checkpoints = resolveCheckpoints();
    // JSON-serialized form of each last-synced row, keyed by row id — the
    // `makeDiffEmit` base for one sync session. Owned outside `sync.sync` only so
    // `scope(...)` can reach the live `emit`; it is CLEARED in the sync cleanup
    // (below), because TanStack drops its own synced store on gc cleanup, so a
    // sync restart begins from an empty store and must re-insert the full
    // snapshot. A stale cache here would diff the re-delivered snapshot down to
    // zero writes and leave the collection permanently empty.
    const syncedJson = new Map<string, string>();

    // Mutable sync handles, populated when TanStack calls the `sync` closure and
    // driven by `scope(...)` from outside it.
    let emit: ((next: Map<string, TRow>) => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    let onErrorHandler: ((error: SubscriptionError) => void) | undefined;
    // The last scope args a `scopeBy` collection was pointed at. Remembered here
    // (outside `sync.sync`) so a sync restart after gc cleanup re-opens the same
    // scope instead of remounting empty, and so a `scope(...)` issued before sync
    // starts (while `emit` is undefined) is applied once sync begins.
    let scopedArgs: Record<string, unknown> | undefined;

    // The watermark from the MOST RECENT `onCheckpoint` call, for the `list`
    // path — consumed (read, then cleared) by the very next `onRows` call,
    // never accumulated or left sticky. Two failure modes a sticky/`Math.max`
    // design hits, both closed by "consume once, per frame":
    //
    //  1. A frame-carried watermark of exactly `0` (every socket announces a
    //     `clientId` unconditionally, and a fresh `__client_watermark` row
    //     reads back `0`, not "no row" — see `readClientWatermark`/
    //     `socketClientWatermark`) is a legitimately DEFINED number. `0 ?? X`
    //     never evaluates `X` — a sticky `frameWatermark` pinned at `0` by the
    //     very first frame would disable the compensator fallback FOREVER,
    //     for every later write, because `0` reads as "already have an
    //     authoritative answer" instead of "nothing confirmed yet".
    //  2. A demoted leader's follower-mirror `onRows` (fed by the leader's
    //     `subscription-data` cross-tab broadcast, which deliberately omits
    //     `lastMutationId` — plan 266 S3's clientId-scoping) would otherwise
    //     keep resolving against a STALE value left over from before
    //     demotion, silently wrong, instead of falling back to this
    //     follower's own `confirmedMutationWatermark` for its own
    //     HTTP-RPC-issued writes.
    //
    // Both are fixed by scoping the watermark to the ONE `onRows` call it was
    // reported for: `onCheckpoint` sets it, the matching `onRows` reads
    // (falling back only when nothing arrived for THIS frame) and clears it,
    // so a frame with no watermark of its own (an unstamped delta from an
    // un-upgraded server, or a follower's data broadcast) always sees
    // `undefined` and defers to the compensator — never a leftover value from
    // an unrelated earlier frame.
    let pendingFrameWatermark: number | undefined;

    // Open the underlying sync source — a full-table `list` query subscription or
    // a replication-`shape` poke subscription — with one uniform callback shape.
    // `onReady` is invoked on the first rowset so the collection leaves `loading`.
    const openSubscription = (args: Record<string, unknown>, onReady: (() => void) | undefined): (() => void) => {
        // Typed `unknown` so the one callback satisfies both sync sources: a `list`
        // query's `(data: ReturnOf<F>)` and a shape's `(rows: Record<string, unknown>[])`.
        const onRows = (data: unknown): void => {
            emit?.(toMap(data as TRow[], getKey));
            onReady?.();

            // The shape path resolves the registry from the poke `checkpoint`
            // (wired below). The list path prefers `pendingFrameWatermark` —
            // set by the `onCheckpoint` call THIS SAME frame fired
            // immediately beforehand (a `settled` frame, or a `data`/`delta`
            // frame's own `lastMutationId`; `onCheckpoint` always fires
            // before `onRows` for a frame that carries both — see
            // `handleDataMessage`) — reflecting what THIS frame's rows
            // actually are. Only when nothing arrived for THIS frame (an
            // un-upgraded server's unstamped frame, or a follower's
            // cross-tab data broadcast, which never carries one) does it
            // fall back to the client's provisional server-confirmed
            // custom-mutator watermark (the push-ack stream) — a
            // `bindMutators` optimistic overlay then drops once its
            // threshold is reached instead of `awaitMutationId` hanging
            // forever after the write is accepted.
            if (options.shape === undefined) {
                resolveCheckpoints().resolve({ mutationId: pendingFrameWatermark ?? options.client.confirmedMutationWatermark(options.shardKey) });
                pendingFrameWatermark = undefined;
            }
        };
        const onError = (error: SubscriptionError): void => onErrorHandler?.(error);

        // Advance the registry as the source syncs, so a mutator runtime can drop
        // optimistic overlays once the server's rows (or a `settled` no-change
        // acknowledgement) have landed. Both paths forward the same watermark
        // shape, so the handler is identical. Also records the watermark
        // `onRows`'s list-path compensator above consumes.
        const onCheckpoint = (watermark: { checkpoint?: number; mutationId?: number }): void => {
            if (watermark.mutationId !== undefined) {
                pendingFrameWatermark = watermark.mutationId;
            }

            resolveCheckpoints().resolve(watermark);
        };

        if (options.shape !== undefined) {
            return options.client.subscribeShape({ args, name: options.shape.name }, onRows, {
                onCheckpoint,
                onError,
                shardKey: options.shape.shardKey,
            });
        }

        return options.client.subscribe(options.list as FunctionReference, args, onRows, { onCheckpoint, onError, shardKey: options.shardKey });
    };

    const config: CollectionConfig<TRow, string> = {
        // Auto-build ordered (B-tree) indexes for whatever the app's live queries
        // join / filter / sort on, so they stay fast as the dataset grows.
        autoIndex: "eager",
        defaultIndexType: BTreeIndex,
        getKey,
        id: options.id ?? options.list?.__lunoraRef ?? `shape:${options.shape?.name ?? ""}`,
        // `"eager"` syncs at creation; omitted otherwise so the wire stays
        // byte-identical to the lazy default (sync on first subscriber).
        ...(options.load === "eager" ? { startSync: true } : {}),
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

                    // Re-open the last scope on a sync (re)start — e.g. after gc
                    // cleanup tore the previous session down, or when `scope(...)`
                    // ran before sync first started. `emit` was assigned just
                    // above, so the source's initial frame syncs in instead of
                    // being dropped; without this a gc'd scoped collection would
                    // remount permanently empty.
                    if (scopedArgs !== undefined) {
                        unsubscribe = openSubscription(scopedArgs, undefined);
                    }
                }

                return () => {
                    emit = undefined;
                    onErrorHandler = undefined;
                    unsubscribe?.();
                    unsubscribe = undefined;
                    // Reset the diff base: TanStack drops its synced store on gc
                    // cleanup, so the next sync restart must re-insert the full
                    // snapshot rather than diff it against a stale cache (which
                    // would leave the restarted collection empty).
                    syncedJson.clear();
                };
            },
        },
    };

    const scope = (args?: Record<string, unknown>): void => {
        if (options.scopeBy === undefined) {
            return;
        }

        // Remember the target so a later sync (re)start re-opens it.
        scopedArgs = args;

        unsubscribe?.();
        unsubscribe = undefined;
        // Clear the previous scope's rows from the synced view.
        emit?.(new Map());

        if (args === undefined) {
            return;
        }

        // Only open now if sync is live (`emit` assigned). When `scope(...)` runs
        // before TanStack first invokes `sync.sync` — or after a gc cleanup — the
        // subscription is deferred to the sync (re)start, where `emit` exists, so
        // the source's initial frame is emitted instead of dropped by `emit?.()`.
        if (emit !== undefined) {
            unsubscribe = openSubscription(args, undefined);
        }
    };

    return { checkpoints, config, scope };
};
