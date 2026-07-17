/**
 * `defineMaterializer` — declare how event types reduce into materialized state.
 *
 * A materializer is a named reducer that processes events from an append-only
 * log and produces a derived state. It mirrors the {@link EventReducer} pattern
 * from `EventSource` but adds a name, typed event map awareness, and lifecycle
 * hooks for snapshot persistence.
 * @example
 * ```ts
 * const events = defineEvents({
 *   chat: { messageSent: v.object({ channelId: v.string() }) },
 * });
 *
 * const messageCounts = defineMaterializer({
 *   name: "messageCounts",
 *   initial: (): Record<string, number> => ({}),
 *   handle: (state, entry) => {
 *     if (entry.type === "chat.messageSent") {
 *       const channelId = (entry.payload as { channelId: string }).channelId;
 *       return { ...state, [channelId]: (state[channelId] ?? 0) + 1 };
 *     }
 *     return state;
 *   },
 * });
 * ```
 */

import type { EventLogEntry } from "./event-log";
import type { AppendEventInput, EventLogDOClient } from "./event-log-do-client";
import type { EventReducer, UnknownEventHandling } from "./event-source";
import type { SnapshotStore } from "./snapshot-store";

// ── Types ────────────────────────────────────────────────────────────────

/**
 * A function that reduces an event entry into a state mutation.
 *
 * Pure functions are strongly encouraged: given the same event and state,
 * they must produce the same next state for deterministic replay.
 * @experimental
 */
type MaterializerReducer<S> = (state: S, entry: EventLogEntry) => S;

/**
 * Options for defining a single materializer.
 * @experimental
 */
// eslint-disable-next-line unicorn/prevent-abbreviations -- public API type name
interface MaterializerDef<S> {
    /**
     * Reducer invoked for every event in the log.
     *
     * Return the current state unchanged to skip the event.
     */
    handle: MaterializerReducer<S>;

    /** Factory for the initial (empty) state. */
    initial: () => S;

    /** Unique name (used as the snapshot storage key). */
    readonly name: string;
}

/**
 * A constructed materializer ready to be used with a {@link MaterializerRuntime}.
 * @experimental
 */
interface Materializer<S> {
    /** Apply a single event entry through the reducer. */
    apply: (entry: EventLogEntry) => void;
    readonly def: MaterializerDef<S>;
    /** Reset to the initial state. */
    reset: () => void;
    /** Replace the runtime state (used on snapshot restore / replay). */
    setState: (state: S) => void;
    /** Current (runtime) derived state. */
    readonly state: Readonly<S>;
}

// ─── Implementation ──────────────────────────────────────────────────────

/**
 * Declare a materializer — a named reducer that derives state from events.
 *
 * The returned {@link Materializer} object can be used standalone or passed
 * to a {@link MaterializerRuntime} for automatic log subscription.
 * @experimental
 */
const defineMaterializer = <S>(definition: MaterializerDef<S>): Materializer<S> => {
    let state = definition.initial();

    return {
        def: definition,
        get state(): Readonly<S> {
            return Object.freeze(state as Readonly<S>);
        },
        setState(newState: S): void {
            state = newState;
        },
        apply(entry: EventLogEntry): void {
            state = definition.handle(state, entry);
        },
        reset(): void {
            state = definition.initial();
        },
    };
};

/**
 * A materializer of any state shape. The {@link MaterializerRuntime} holds a
 * heterogeneous collection and only ever calls `apply(entry)` / `setState(...)`
 * (with cast values) / reads `def.name` — it never needs the concrete state
 * type. `Materializer&lt;unknown>` won't do: `setState(state: S)` makes
 * `Materializer&lt;S>` invariant in `S`, so `Materializer&lt;number>` isn't assignable
 * to `Materializer&lt;unknown>`. Erasing the type param is the idiomatic fix.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional type erasure for a heterogeneous store; see above.
type AnyMaterializer = Materializer<any>;

// ── Runtime ──────────────────────────────────────────────────────────────

/**
 * Options for constructing a {@link MaterializerRuntime}.
 * @experimental
 */
interface MaterializerRuntimeOptions {
    /**
     * Optional EventLogDO client for persistent event log integration.
     *
     * When provided, the runtime can bootstrap from the DO on startup
     * (recover from snapshots → catch up via `getSince`) and append
     * new events through the DO automatically.
     */
    doClient?: EventLogDOClient;
    /** Optional snapshot store for persisting/recovering materialized state. */
    snapshotStore?: SnapshotStore;

    /**
     * How to handle events whose type no materializer handles.
     * @default "warn"
     */
    unknownEventHandling?: UnknownEventHandling;
}

/**
 * Runtime that drives one or more materializers from an event log.
 *
 * Handles:
 * - Replaying the full log on startup
 * - Applying new events as they arrive
 * - Periodic snapshot persistence
 * - Recovery from snapshots (replay only what's missing)
 * @experimental
 */
class MaterializerRuntime {
    readonly #materializers: AnyMaterializer[];
    readonly #snapshotStore: SnapshotStore | undefined;
    readonly #doClient: EventLogDOClient | undefined;
    readonly #unknownEventHandling: UnknownEventHandling;

    /**
     * The highest event seq that has been applied to all materializers.
     * Starts at `0` and advances monotonically.
     */
    #appliedSeq = 0;

    public constructor(materializers: AnyMaterializer[], options: MaterializerRuntimeOptions = {}) {
        this.#materializers = [...materializers];
        this.#snapshotStore = options.snapshotStore;
        this.#doClient = options.doClient;
        this.#unknownEventHandling = options.unknownEventHandling ?? "warn";
    }

    // ── Public API ──────────────────────────────────────────────────────

    /**
     * The sequence number of the last event applied to all materializers.
     */
    public get appliedSeq(): number {
        return this.#appliedSeq;
    }

    /**
     * Replay a batch of entries through all materializers.
     *
     * Entries with `seq < this.appliedSeq` are silently skipped (idempotent).
     * @returns The number of entries actually applied.
     */
    public applyEntries(entries: ReadonlyArray<EventLogEntry>): number {
        let count = 0;

        for (const entry of entries) {
            if (entry.seq < this.#appliedSeq) {
                continue;
            }

            const statesBefore = this.#materializers.map((m) => m.state);

            let stateChanged = false;

            for (const m of this.#materializers) {
                m.apply(entry);
            }

            for (let i = 0; i < this.#materializers.length; i += 1) {
                if (this.#materializers[i]?.state !== statesBefore[i]) {
                    stateChanged = true;
                    break;
                }
            }

            if (!stateChanged) {
                this.#handleUnknownEvent(entry);
            }

            this.#appliedSeq = entry.seq + 1;
            count += 1;
        }

        return count;
    }

    /**
     * Apply the configured {@link UnknownEventHandling} strategy for an event
     * that no materializer handled.
     */
    #handleUnknownEvent(entry: EventLogEntry): void {
        const strategy = this.#unknownEventHandling;

        if (typeof strategy === "function") {
            strategy(entry);

            return;
        }

        switch (strategy) {
            case "ignore": {
                return;
            }
            case "fail": {
                throw new Error(
                    `MaterializerRuntime: unhandled event type "${entry.type}" (seq ${String(entry.seq)}). ` +
                        "Configure `unknownEventHandling` to handle this event or change the strategy.",
                );
            }
            default: {
                console.warn(
                    `[MaterializerRuntime] unhandled event type "${entry.type}" (seq ${String(entry.seq)}). ` +
                        "The event was skipped. Configure `unknownEventHandling` if this is expected.",
                );
            }
        }
    }

    /**
     * Attempt to recover materialized state from a snapshot store.
     *
     * When a snapshot is found for a materializer, its state is restored
     * and the snapshot's watermark (`appliedSeq`) is returned so the caller
     * can skip replaying entries up to that point.
     * @returns The highest `appliedSeq` across all recovered snapshots, or `0`.
     */
    public async recoverFromSnapshots(): Promise<number> {
        if (!this.#snapshotStore) {
            return 0;
        }

        let maxSeq = 0;

        for (const m of this.#materializers) {
            // eslint-disable-next-line no-await-in-loop -- sequential snapshot loads are intentional
            const raw = await this.#snapshotStore.load(m.def.name);

            if (raw !== null && typeof raw === "object") {
                const snapshot = raw as { appliedSeq: number; state: unknown };

                if (snapshot.state !== undefined) {
                    m.setState(snapshot.state);
                }

                if (snapshot.appliedSeq > maxSeq) {
                    maxSeq = snapshot.appliedSeq;
                }
            }
        }

        // Set the watermark so subsequent applyEntries skips already-applied events
        if (maxSeq > this.#appliedSeq) {
            this.#appliedSeq = maxSeq;
        }

        return maxSeq;
    }

    /**
     * Persist the current state of all materializers as snapshots.
     */
    public async persistSnapshots(): Promise<void> {
        if (!this.#snapshotStore) {
            return;
        }

        for (const m of this.#materializers) {
            // eslint-disable-next-line no-await-in-loop -- sequential snapshot saves are intentional
            await this.#snapshotStore.save(m.def.name, {
                appliedSeq: this.#appliedSeq,
                state: m.state,
            });
        }
    }

    // ── DO-backed lifecycle (when a doClient is provided) ──────────────

    /**
     * Bootstrap the runtime from the EventLogDO.
     *
     * 1. Recover materialized state from snapshots (if a snapshotStore is
     * configured).
     * 2. Fetch all entries since the recovered watermark from the DO.
     * 3. Apply them through the materializers.
     *
     * Call this once on startup / after the DO binding is available.
     * @returns The number of entries applied during catch-up.
     */
    public async initialize(): Promise<number> {
        if (!this.#doClient) {
            return 0;
        }

        // 1. Recover from snapshots to get a watermark
        const snapshotSeq = await this.recoverFromSnapshots();

        // 2. Fetch entries since watermark
        const entries = await this.#doClient.getSince(snapshotSeq);

        if (entries.length === 0) {
            return 0;
        }

        // 3. Apply through materializers
        return this.applyEntries(entries);
    }

    /**
     * Append an event to the EventLogDO and apply it through all
     * materializers.
     *
     * This is a convenience over calling `doClient.append(...)` +
     * `runtime.applyEntries(...)` yourself — it persists the event
     * **then** applies the returned entry (with its assigned seq).
     * @returns The persisted entry with its DO-assigned `seq`.
     */
    public async appendEvent(input: AppendEventInput): Promise<EventLogEntry> {
        if (!this.#doClient) {
            throw new Error("MaterializerRuntime.appendEvent requires a doClient — pass one in the constructor options.");
        }

        const persisted = await this.#doClient.append([input]);
        const entry = persisted[0];

        if (!entry) {
            throw new Error("MaterializerRuntime.appendEvent: DO returned empty result");
        }

        this.applyEntries([entry]);

        return entry;
    }

    /**
     * Reset all materializers to their initial state and clear snapshots.
     */
    public reset(): void {
        this.#appliedSeq = 0;

        for (const m of this.#materializers) {
            m.reset();
        }
    }

    /**
     * The list of registered materializers.
     */
    public get materializers(): ReadonlyArray<Materializer<unknown>> {
        return this.#materializers;
    }
}

export { defineMaterializer, MaterializerRuntime };
export type { Materializer, MaterializerDef, MaterializerReducer, MaterializerRuntimeOptions };
