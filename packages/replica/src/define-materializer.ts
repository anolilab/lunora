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
 *     return UNHANDLED;
 *   },
 * });
 * ```
 */

import type { EventLogEntry } from "./event-log";
import type { AppendEventInput, EventLogDOClient } from "./event-log-do-client";
import type { EventReducer, UnknownEventHandling } from "./event-source";
import { UNHANDLED } from "./event-source";
import type { SnapshotStore } from "./snapshot-store";

/**
 * Pages {@link MaterializerRuntime.initialize} walks before yielding, however
 * much log is left. A live writer keeps `truncated` true forever, so an
 * unbounded walk never returns; the budget leaves the remainder to the next
 * call, at the advanced watermark.
 */
const MAX_CATCHUP_PAGES = 1000;

// ── Types ────────────────────────────────────────────────────────────────

/**
 * A function that reduces an event entry into a state mutation.
 *
 * Pure functions are strongly encouraged: given the same event and state,
 * they must produce the same next state for deterministic replay.
 *
 * Return {@link UNHANDLED} for an event `type` the reducer does not recognise —
 * that, and only that, is what {@link MaterializerRuntimeOptions.unknownEventHandling}
 * reacts to. Returning the current `state` is a legitimate, idempotent no-op for
 * a type the reducer DOES handle; reference equality cannot tell the two apart
 * (REPLICA-07), and reading it as "unhandled" warned about — or, under `"fail"`,
 * threw on — an event type the reducer explicitly recognised.
 * @experimental
 */
type MaterializerReducer<S> = (state: S, entry: EventLogEntry) => S | typeof UNHANDLED;

/**
 * Options for defining a single materializer.
 * @experimental
 */
// eslint-disable-next-line unicorn/prevent-abbreviations -- public API type name
interface MaterializerDef<S> {
    /**
     * Reducer invoked for every event in the log.
     *
     * Return the current state unchanged for a recognised event with nothing to
     * do; return {@link UNHANDLED} for a `type` this reducer does not process.
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
    /**
     * Apply a single event entry through the reducer.
     * @returns `false` when the reducer returned {@link UNHANDLED} (state left
     * untouched), `true` otherwise.
     */
    apply: (entry: EventLogEntry) => boolean;
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
        apply(entry: EventLogEntry): boolean {
            const reduced = definition.handle(state, entry);

            if (reduced === UNHANDLED) {
                return false;
            }

            state = reduced;

            return true;
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
 * type. `Materializer<unknown>` won't do: `setState(state: S)` makes
 * `Materializer<S>` invariant in `S`, so `Materializer<number>` isn't assignable
 * to `Materializer<unknown>`. Erasing the type param is the idiomatic fix.
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
     * How to handle an event that every materializer explicitly DECLINED — one
     * for which each reducer returned {@link UNHANDLED}.
     *
     * A reducer that instead falls through to `return state` for a type it does
     * not recognise has, as far as the runtime can tell, handled the event: it
     * changed nothing, but it did not decline. `"fail"` and `"warn"` are inert
     * for such a reducer, and no option here can make them otherwise — write the
     * reducer's default branch as `return UNHANDLED` if you want to hear about
     * unknown types.
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
     * Per-materializer watermark: the seq of the next event each materializer
     * (by index, parallel to `#materializers`) has NOT yet applied. Starts at
     * `0` for every materializer and advances independently — a materializer
     * with no snapshot stays at `0` even when a sibling has recovered to a
     * much higher watermark, so catch-up never skips events for it (REPLICA-04).
     */
    #watermarks: number[];

    public constructor(materializers: AnyMaterializer[], options: MaterializerRuntimeOptions = {}) {
        this.#materializers = [...materializers];
        this.#watermarks = this.#materializers.map(() => 0);
        this.#snapshotStore = options.snapshotStore;
        this.#doClient = options.doClient;
        this.#unknownEventHandling = options.unknownEventHandling ?? "warn";
    }

    // ── Public API ──────────────────────────────────────────────────────

    /**
     * The lowest per-materializer watermark — the seq of the next event that
     * at least one materializer has not yet applied. `0` when there are no
     * materializers.
     */
    public get appliedSeq(): number {
        return this.#watermarks.length > 0 ? Math.min(...this.#watermarks) : 0;
    }

    /**
     * Replay a batch of entries, applying each entry only to the
     * materializers whose own watermark is behind it — a materializer at or
     * past an entry's seq (e.g. recovered from a snapshot, or already caught
     * up) skips it, so no materializer ever double-applies an event.
     * @returns The number of entries applied to at least one materializer.
     */
    public applyEntries(entries: ReadonlyArray<EventLogEntry>): number {
        let count = 0;

        for (const entry of entries) {
            let appliedToAny = false;
            let anyHandled = false;

            // Stage which materializers advanced; commit their watermarks only
            // AFTER the unknown-event strategy has run without throwing (below).
            // A throwing `"fail"` strategy must leave every watermark where it
            // was, so a catch-and-retry re-surfaces this exact event instead of
            // silently skipping it and under-reporting `count`. Every advance is
            // to the same `entry.seq + 1`, so only the index needs staging.
            const advancedIndices: number[] = [];

            for (const [i, materializer] of this.#materializers.entries()) {
                const watermark = this.#watermarks[i] ?? 0;

                if (entry.seq < watermark) {
                    continue;
                }

                // The reducer's OWN answer, not a state-identity guess: a
                // recognised event whose reduction is a no-op returns the same
                // state and must not be reported as unhandled (REPLICA-07).
                if (materializer.apply(entry)) {
                    anyHandled = true;
                }

                appliedToAny = true;

                advancedIndices.push(i);
            }

            if (!appliedToAny) {
                // Every materializer was already at or past this seq.
                continue;
            }

            if (!anyHandled) {
                // May throw under the `"fail"` strategy — deliberately BEFORE
                // the watermark commit below, so a throw leaves the watermark
                // re-surfaceable.
                this.#handleUnknownEvent(entry);
            }

            for (const index of advancedIndices) {
                this.#watermarks[index] = entry.seq + 1;
            }

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
                // eslint-disable-next-line no-console -- the `warn` strategy's whole contract is to report the skipped event; the runtime has no logger binding
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
     * When a snapshot is found for a materializer, its state AND its own
     * watermark are restored from that snapshot. A materializer with no
     * snapshot keeps its current watermark (`0` for a fresh runtime) — it
     * does NOT inherit another materializer's watermark, so it still catches
     * up from the very beginning (REPLICA-04: previously a shared watermark
     * was bumped to the MAX across snapshots, permanently skipping events 0..N
     * for any un-snapshotted or lagging materializer).
     * @returns The highest snapshot `appliedSeq` across all materializers, or
     * `0` — kept for backward compatibility; callers that need the fetch
     * watermark for catch-up should use the per-materializer minimum instead
     * (see `initialize`).
     */
    public async recoverFromSnapshots(): Promise<number> {
        if (!this.#snapshotStore) {
            return 0;
        }

        let maxSeq = 0;

        for (const [i, materializer] of this.#materializers.entries()) {
            // eslint-disable-next-line no-await-in-loop -- sequential snapshot loads are intentional
            const raw = await this.#snapshotStore.load(materializer.def.name);

            if (raw !== null && typeof raw === "object") {
                const snapshot = raw as { appliedSeq: unknown; state: unknown };

                // Only accept a snapshot as a watermark when it is BOTH a
                // valid non-negative seq AND carries restorable state. A row
                // with a watermark but no `state` (partial write / adapter
                // drift) would otherwise advance the watermark WITHOUT
                // restoring state — permanently skipping events 0..appliedSeq —
                // and a non-numeric `appliedSeq` would write `NaN` into the
                // watermark, so the `Math.min(...)` fetch position feeds
                // `getSince(NaN)` to the DO. On any malformed snapshot, leave
                // the watermark at its current value (0 for a fresh runtime) so
                // the runtime replays from the start — replaying more, never
                // less.
                if (Number.isSafeInteger(snapshot.appliedSeq) && (snapshot.appliedSeq as number) >= 0 && snapshot.state !== undefined) {
                    const appliedSeq = snapshot.appliedSeq as number;

                    materializer.setState(snapshot.state);

                    this.#watermarks[i] = appliedSeq;

                    if (appliedSeq > maxSeq) {
                        maxSeq = appliedSeq;
                    }
                }
            }
        }

        return maxSeq;
    }

    /**
     * Persist the current state of all materializers as snapshots, each
     * tagged with ITS OWN watermark (not a shared one).
     */
    public async persistSnapshots(): Promise<void> {
        if (!this.#snapshotStore) {
            return;
        }

        for (const [i, materializer] of this.#materializers.entries()) {
            // eslint-disable-next-line no-await-in-loop -- sequential snapshot saves are intentional
            await this.#snapshotStore.save(materializer.def.name, {
                appliedSeq: this.#watermarks[i] ?? 0,
                state: materializer.state,
            });
        }
    }

    // ── DO-backed lifecycle (when a doClient is provided) ──────────────

    /**
     * Bootstrap the runtime from the EventLogDO.
     *
     * 1. Recover materialized state from snapshots (if a snapshotStore is
     * configured).
     * 2. Fetch entries since the MINIMUM per-materializer watermark from
     * the DO — not the maximum — so a materializer with no snapshot (or a
     * lower one) still receives every event it hasn't seen (REPLICA-04).
     * 3. Apply them through the materializers; `applyEntries` skips each
     * entry for any materializer already past it, so nothing is double-applied.
     *
     * The DO answers one BOUNDED page per request, so step 2/3 walk pages until
     * the log is exhausted — applying each page as it arrives, rather than
     * holding the whole backlog in memory. Taking only the first page (and
     * dropping `truncated`) would silently leave every materializer short of
     * the log's head whenever the backlog exceeds a page.
     *
     * The walk is bounded by {@link MAX_CATCHUP_PAGES}: against a log written
     * faster than it is read, "until the log is exhausted" never arrives and
     * startup would never finish. Hitting the budget returns what was applied
     * with every materializer's watermark advanced, so a later `initialize()`
     * (or the ordinary append path) picks up exactly where this left off.
     *
     * Call this once on startup / after the DO binding is available.
     * @returns The number of entries applied during catch-up.
     */
    public async initialize(): Promise<number> {
        if (!this.#doClient) {
            return 0;
        }

        // 1. Recover from snapshots — sets each materializer's own watermark.
        await this.recoverFromSnapshots();

        // 2/3. Walk pages from the LOWEST watermark across materializers,
        // applying each page as it arrives.
        return this.#catchUp();
    }

    /**
     * Walk the log from the lowest per-materializer watermark, applying each
     * bounded page as it arrives, until the log is exhausted or
     * {@link MAX_CATCHUP_PAGES} pages have been read.
     *
     * Shared by `initialize()` and `appendEvent()` — the second needs the walk
     * WITHOUT `recoverFromSnapshots()`, which would overwrite the state the
     * runtime has already materialized.
     * @returns The number of entries applied to at least one materializer.
     */
    async #catchUp(): Promise<number> {
        const client = this.#doClient;

        if (!client) {
            return 0;
        }

        let sinceSeq = this.appliedSeq;
        let applied = 0;

        for (let pages = 0; pages < MAX_CATCHUP_PAGES; pages += 1) {
            // eslint-disable-next-line no-await-in-loop -- each page's cursor comes from the previous page, so the round-trips are inherently sequential
            const page = await client.getSince(sinceSeq);

            applied += this.applyEntries(page.entries);

            if (!page.truncated || page.cursor === undefined || page.cursor <= sinceSeq) {
                return applied;
            }

            sinceSeq = page.cursor;
        }

        return applied;
    }

    /**
     * Append an event to the EventLogDO and apply it through all
     * materializers.
     *
     * This is a convenience over calling `doClient.append(...)` +
     * `runtime.applyEntries(...)` yourself — it persists the event
     * **then** applies the returned entry (with its assigned seq).
     * @returns The persisted entry with its DO-assigned `seq` — always, whether
     * or not the entry could be applied to the materializers (see below).
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

        // Close any gap between the runtime and this entry BEFORE applying it.
        // `applyEntries` advances every behind materializer's watermark to
        // `entry.seq + 1`, so applying an appended entry over an unfinished
        // catch-up — `initialize()` stopping at MAX_CATCHUP_PAGES, or a runtime
        // that never initialized at all — steps the watermark past the backlog
        // and skips it permanently: the next `initialize()` starts after the
        // gap and nothing ever reads those entries. The walk re-fetches this
        // entry too; `applyEntries` skips it as already applied, so the call
        // below stays correct either way.
        if (this.#materializers.length > 0 && this.appliedSeq < entry.seq) {
            await this.#catchUp();

            // `#catchUp` is bounded by MAX_CATCHUP_PAGES, so a backlog deeper
            // than the bound leaves the gap OPEN. Applying the entry now would
            // do exactly what the walk above exists to prevent — step every
            // lagging watermark to `entry.seq + 1` over events nothing has read
            // — and the resulting state is not "slightly behind" but
            // permanently derived from a subset of the log, with no record that
            // anything is missing. Leave the entry unapplied instead: it is
            // durably persisted, the watermarks still point INTO the backlog,
            // and the next catch-up (this method's own, or `initialize()`)
            // applies the backlog and this entry in seq order. State converges
            // late rather than settling wrong.
            if (this.appliedSeq < entry.seq) {
                return entry;
            }
        }

        this.applyEntries([entry]);

        return entry;
    }

    /**
     * Reset all materializers to their initial state and clear snapshots.
     */
    public reset(): void {
        for (const [i, materializer] of this.#materializers.entries()) {
            this.#watermarks[i] = 0;
            materializer.reset();
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
