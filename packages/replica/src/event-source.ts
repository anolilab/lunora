import { EventEmitter } from "./event-emitter";
import type { AppendOptions, EventLogEntry } from "./event-log";
import { EventLog } from "./event-log";
import type { InputEvent } from "./seq";

// ── Unknown event handling ────────────────────────────────────────────────

/**
 * Strategy for handling events whose `type` the reducer does not recognise.
 *
 * - `"warn"` _(default)_ — log a warning and skip the event (state unchanged).
 * - `"ignore"` — skip silently (no warning, no error).
 * - `"fail"` — throw an error, halting the apply / replay cycle.
 * - A **callback** — invoked with the entry; return truthy to mark it as
 * handled (no warning), falsy to fall through to the configured fallback.
 * @experimental
 */
export type UnknownEventHandling = "warn" | "ignore" | "fail" | ((entry: EventLogEntry) => boolean);

// ── EventSource ────────────────────────────────────────────────────────────

/**
 * Events emitted by the {@link EventSource} runtime.
 *
 * A `type` (not `interface`) so it satisfies `EventEmitter`'s
 * `Record<string, unknown>` constraint — interfaces have no implicit index
 * signature and aren't assignable to `Record<string, unknown>`.
 * @experimental
 */
export type EventSourceEvents = {
    /** Fired (once) after the initial replay completes. */
    ready: { entryCount: number };
    /** Fired when a replay error occurs — the runtime will skip the bad entry. */
    "replay-error": { entry: EventLogEntry; error: Error };
    /** Fired after an event has been applied and the state updated. */
    "state-changed": { entry: EventLogEntry; state: Record<string, unknown> };
};

/**
 * Sentinel a reducer can return to EXPLICITLY signal it does not handle a
 * given event's `type` — as opposed to returning the current `state`
 * reference unchanged to represent a legitimate, idempotent no-op for a type
 * it DOES recognise.
 *
 * Reference equality alone can't tell these two cases apart (REPLICA-07): a
 * reducer that intentionally returns `state` for a type it fully understands
 * (e.g. "already applied this event, nothing to do") would otherwise be
 * misclassified as "unhandled" and trigger {@link UnknownEventHandling} — a
 * spurious warning, or worse, a thrown error under `"fail"`. Return `UNHANDLED`
 * only for a `type` your reducer truly does not recognise; every other return
 * (including a `state` returned by reference) is treated as handled.
 *
 * Reducers that always recognise every event they're given (a single
 * always-matching type, or a catch-all) can ignore this entirely.
 * @experimental
 */
export const UNHANDLED: unique symbol = Symbol("lunora.replica.event-source.unhandled");

/**
 * A function that reduces an event into a state mutation.
 *
 * Pure functions are strongly encouraged: given the same event payload
 * and state, they must produce the same next state. Return {@link UNHANDLED}
 * to explicitly mark an event `type` this reducer does not process — see
 * {@link UNHANDLED} for why reference equality against the input `state`
 * cannot be used for this instead.
 * @experimental
 */
export type EventReducer<S> = (state: S, entry: EventLogEntry) => S | typeof UNHANDLED;

/**
 * Options for constructing an {@link EventSource}.
 * @experimental
 */
export interface EventSourceOptions {
    /**
     * Cap this runtime's internal `log` to this many entries (REPLICA-06).
     * `replayFromLog` copies every entry it replays from the source log into
     * `this.log` too — a second, uncapped copy of the same history — so a
     * long-lived `EventSource` fed by repeated replay accumulates entries in
     * both places forever without a cap.
     *
     * `undefined` (the default) preserves unbounded retention.
     */
    maxLogEntries?: number;

    /**
     * How to handle events whose `type` is not recognised by the reducer.
     * @default "warn"
     */
    unknownEventHandling?: UnknownEventHandling;
}

/**
 * Event-sourcing runtime that maintains a derived state by replaying an
 * append-only {@link EventLog}.
 *
 * Usage:
 * ```ts
 * const source = new EventSource(initialState, myReducer);
 * await source.replayFromLog(existingLog);
 *
 * // Later, when a new event arrives:
 * const entry = source.applyEvent("user-created", { id: "1", name: "alice" });
 * console.log(source.state); // updated state
 * ```
 * @experimental
 */
export class EventSource<S extends Record<string, unknown> = Record<string, unknown>> {
    // eslint-disable-next-line unicorn/prefer-event-target -- EventEmitter is the library's typed public API
    public readonly emitter: EventEmitter<EventSourceEvents> = new EventEmitter<EventSourceEvents>();
    public readonly log: EventLog;

    #state: S;
    #reducer: EventReducer<S>;
    #replayed = false;
    #unknownEventHandling: UnknownEventHandling;

    /**
     * Watermark over the EXTERNAL source log: the highest source `seq` already
     * applied by {@link EventSource.replayFromLog}, or `-1` when nothing has been applied.
     * Tracked separately from `this.log.nextSeq` (the destination log, which
     * `applyEvent` and each replay append advance independently) so a repeated
     * `replayFromLog` neither skips unseen source entries nor reprocesses
     * already-applied ones.
     */
    #lastAppliedSeq = -1;

    public constructor(initialState: S, reducer: EventReducer<S>, options?: EventSourceOptions) {
        this.#state = { ...initialState };
        this.#reducer = reducer;
        this.#unknownEventHandling = options?.unknownEventHandling ?? "warn";
        this.log = new EventLog({ maxEntries: options?.maxLogEntries });
    }

    // ── Public API ────────────────────────────────────────────────────

    /**
     * The current derived state. Read-only snapshot; mutate through events.
     */
    public get state(): Readonly<S> {
        return this.#state;
    }

    /**
     * Whether the initial replay from an existing log has completed.
     */
    public get replayed(): boolean {
        return this.#replayed;
    }

    /**
     * Append a new event to the log and apply it to the current state.
     *
     * Accepts either an {@link InputEvent} (e.g. from a `defineEvents` factory)
     * or the traditional `(type, payload)` pair.
     * @returns The newly created log entry (with its assigned `seq`).
     */
    public applyEvent(event: InputEvent, options?: AppendOptions): EventLogEntry;
    public applyEvent(type: string, payload: unknown, options?: AppendOptions): EventLogEntry;
    public applyEvent(typeOrEvent: string | InputEvent, payload?: unknown, options?: AppendOptions): EventLogEntry {
        let type: string;
        let pl: unknown;
        let resolvedOptions: AppendOptions | undefined;

        if (typeof typeOrEvent === "string") {
            type = typeOrEvent;
            pl = payload;
            resolvedOptions = options;
        } else {
            type = typeOrEvent.type;
            pl = typeOrEvent.payload;
            resolvedOptions = payload as AppendOptions | undefined;
        }

        // Build the entry the reducer will see WITHOUT committing it to the
        // log yet (REPLICA-07): `seq`/`parentSeqNum` are derived exactly the
        // way `EventLog#append` derives them, so — since nothing else can
        // touch `this.log` synchronously between this peek and the real
        // append below — the entry committed on success is identical.
        const candidate: EventLogEntry = {
            seq: this.log.nextSeq,
            type,
            payload: pl,
            timestamp: Date.now(),
            clientId: resolvedOptions?.clientId,
            sessionId: resolvedOptions?.sessionId,
            parentSeqNum: resolvedOptions?.parentSeqNum ?? this.log.headSeq ?? undefined,
        };

        let reduced: S | typeof UNHANDLED;

        try {
            reduced = this.#reducer(this.#state, candidate);
        } catch (error) {
            const normalizedError = error instanceof Error ? error : new Error(String(error));

            this.emitter.emit("replay-error", {
                entry: candidate,
                error: normalizedError,
            });

            // A throwing reducer must not leave a logged entry that state
            // never reflected — do NOT commit to the log, and do NOT report
            // the uncommitted candidate as a successful (persisted) entry:
            // its `seq` is free to be reused by the next event.
            throw normalizedError;
        }

        // Preflight UNHANDLED handling against the UNCOMMITTED candidate
        // BEFORE appending to the log: the "fail" strategy (or a throwing
        // callback) must abort here, or a retry after the thrown error would
        // duplicate the logical event against an already-advanced log.
        let handledByCallback = true;

        if (reduced === UNHANDLED) {
            handledByCallback = this.#handleUnknown(candidate);
        }

        // The reducer succeeded (whether it handled the event or returned
        // UNHANDLED, and unknown-event handling didn't throw) — commit to
        // the log now. `timestamp` is pinned to the candidate's so the
        // reducer and the persisted entry are byte-for-byte identical
        // (REPLICA-07): a second, independently-drawn `Date.now()` here
        // would make a timestamp-dependent reducer's output unreproducible
        // on replay.
        const entry = this.log.append(type, pl, undefined, { ...resolvedOptions, timestamp: candidate.timestamp });

        if (reduced === UNHANDLED) {
            if (handledByCallback) {
                // The callback returned true ("handled"), but state didn't
                // change. Emit state-changed anyway (consumer may still want
                // to know the entry was processed).
                this.emitter.emit("state-changed", { state: this.#state, entry });
            }

            return entry;
        }

        this.#state = reduced;
        this.emitter.emit("state-changed", { state: this.#state, entry });

        return entry;
    }

    /**
     * Replay all entries from an existing {@link EventLog} to bootstrap
     * the current state.
     *
     * Idempotent across calls: only source entries past the `#lastAppliedSeq`
     * watermark are applied, so re-invoking picks up just the new entries.
     * @param log The external log to replay from.
     */
    public replayFromLog(log: EventLog): void {
        // Fetch by the SOURCE watermark (`seq > #lastAppliedSeq`), not
        // `this.log.nextSeq` — the two logs have independent seq spaces.
        const entries = log.getSince(this.#lastAppliedSeq + 1);

        for (const entry of entries) {
            try {
                const reduced = this.#reducer(this.#state, entry);

                // Replay doesn't run the unknown-event strategy (there's no
                // live caller to notify) — UNHANDLED here just means "no
                // state change", same as it always meant.
                if (reduced !== UNHANDLED) {
                    this.#state = reduced;
                }

                // `timestamp` is pinned to the source entry's, for the same
                // reason `applyEvent` pins it to the candidate's (REPLICA-07):
                // without it `EventLog#append` stamps `Date.now()`, so a replay
                // rewrote history to the moment it ran and a timestamp-dependent
                // reducer could never be re-derived from the replayed log.
                const appended = this.log.append(entry.type, entry.payload, entry.tableDiffs, {
                    clientId: entry.clientId,
                    sessionId: entry.sessionId,
                    parentSeqNum: entry.parentSeqNum,
                    timestamp: entry.timestamp,
                });

                // Same notification `applyEvent` emits, for the same entries:
                // `events()` streams off this event, so without it every entry a
                // replay appended was invisible to a live generator — which the
                // method contract promises to yield.
                this.emitter.emit("state-changed", { state: this.#state, entry: appended });
            } catch (error) {
                this.emitter.emit("replay-error", {
                    entry,
                    error: error instanceof Error ? error : new Error(String(error)),
                });
                // Continue replaying — skip the bad entry.
            } finally {
                // Advance the source watermark for every entry (applied or
                // skipped) so a later replay never reprocesses it.
                this.#lastAppliedSeq = entry.seq;
            }
        }

        this.#replayed = true;
        this.emitter.emit("ready", { entryCount: this.log.size });
    }

    /**
     * Reset the runtime to a base state, optionally resuming from a watermark.
     *
     * Useful after loading a snapshot from the DO: pass the snapshot's state as
     * `initialState` and its highest applied source `seq` as `resumeFromSeq`, so
     * the next {@link replayFromLog} applies ONLY the events after the snapshot
     * (`getSince(resumeFromSeq + 1)`) rather than replaying the whole log on top
     * of the snapshot — which would double-apply non-idempotent reducers.
     *
     * Omit `resumeFromSeq` (default `-1`) for a full reset that replays from the
     * beginning.
     * @param initialState The base state to reset to (e.g. a loaded snapshot).
     * @param resumeFromSeq Highest source `seq` already baked into `initialState`, or `-1` to replay all.
     */
    public reset(initialState: S, resumeFromSeq = -1): void {
        this.#state = { ...initialState };
        this.#lastAppliedSeq = resumeFromSeq;
        this.#replayed = resumeFromSeq >= 0;
    }

    /**
     * Return an async generator that yields every event as it is applied,
     * starting from the events currently in the log and continuing with
     * every future `applyEvent` / `replayFromLog` call.
     *
     * The generator runs indefinitely unless given a `signal` — callers
     * should break out of the `for await` loop or pass an `AbortSignal` to
     * stop it (an abort settles the generator, `done: true`, on its next
     * iteration step; it does not throw).
     * @example
     * ```ts
     * for await (const entry of source.events()) {
     *   console.log("event applied:", entry);
     * }
     * ```
     */
    public async *events(signal?: AbortSignal): AsyncGenerator<EventLogEntry> {
        // Subscribe to state-changed BEFORE yielding past entries so that any
        // event applied while we iterate the past log lands in the buffer and
        // is not lost.
        const buffer: EventLogEntry[] = [];
        let wake: (() => void) | undefined;

        const unsub = this.emitter.on("state-changed", ({ entry }) => {
            buffer.push(entry);

            wake?.();
        });

        // Abort must also settle the phase-2 park below: the promise is
        // otherwise resolved only by the state-changed listener, so an abort
        // while idle would never re-evaluate the loop condition — the
        // documented cancellation path would hang and leak the listener +
        // buffer forever. `once` since the generator only ever needs to wake
        // once per abort; removed in `finally` for a signal that outlives
        // this generator (a shared/long-lived signal must not accumulate
        // dead listeners across many `events()` calls).
        const onAbort = (): void => {
            wake?.();
        };

        signal?.addEventListener("abort", onAbort, { once: true });

        try {
            // ── Phase 1 — yield past entries ────────────────────────
            let watermark = 0;

            while (watermark < this.log.size) {
                if (signal?.aborted) {
                    return;
                }

                for (const entry of this.log.getSince(watermark)) {
                    yield entry;
                }

                watermark = this.log.nextSeq;
            }

            // ── Phase 2 — stream future entries ─────────────────────
            while (!signal?.aborted) {
                while (buffer.length > 0) {
                    const nextEntry = buffer.shift();

                    if (nextEntry) {
                        yield nextEntry;
                    }
                }

                if (buffer.length === 0) {
                    // eslint-disable-next-line no-await-in-loop -- intentional sequential wait for the next event
                    await new Promise<void>((resolve) => {
                        wake = resolve;
                    });
                }
            }
        } finally {
            unsub();
            signal?.removeEventListener("abort", onAbort);
        }
    }

    // ── Internal ──────────────────────────────────────────────────────

    /**
     * Explicit-sentinel detection (not `state === stateBefore` reference
     * equality) is what lets a reducer legitimately return `state` unchanged
     * for a type it DOES recognise without being misclassified as unhandled
     * (REPLICA-07).
     */
    #handleUnknown(entry: EventLogEntry): boolean {
        const strategy = this.#unknownEventHandling;

        if (typeof strategy === "function") {
            return strategy(entry);
        }

        switch (strategy) {
            case "ignore": {
                return false;
            }
            case "fail": {
                throw new Error(
                    `EventSource: unhandled event type "${entry.type}" (seq ${String(entry.seq)}). ` +
                        "Configure `unknownEventHandling` to handle this event or change the strategy.",
                );
            }
            default: {
                // eslint-disable-next-line no-console -- the `warn` strategy's whole contract is to report the skipped event; the source has no logger binding
                console.warn(
                    `[EventSource] unhandled event type "${entry.type}" (seq ${String(entry.seq)}). ` +
                        "The event was skipped. Configure `unknownEventHandling` if this is expected.",
                );

                return false;
            }
        }
    }
}
