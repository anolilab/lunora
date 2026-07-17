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
 * `Record&lt;string, unknown>` constraint — interfaces have no implicit index
 * signature and aren't assignable to `Record&lt;string, unknown>`.
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
 * A function that reduces an event into a state mutation.
 *
 * Pure functions are strongly encouraged: given the same event payload
 * and state, they must produce the same next state.
 * @experimental
 */
export type EventReducer<S> = (state: S, entry: EventLogEntry) => S;

/**
 * Options for constructing an {@link EventSource}.
 * @experimental
 */
export interface EventSourceOptions {
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
    public readonly log: EventLog = new EventLog();

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

        const entry = this.log.append(type, pl, undefined, resolvedOptions);

        this.#applyEntry(entry);

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
                this.#state = this.#reducer(this.#state, entry);
                this.log.append(entry.type, entry.payload, entry.tableDiffs, {
                    clientId: entry.clientId,
                    sessionId: entry.sessionId,
                    parentSeqNum: entry.parentSeqNum,
                });
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
     * The generator runs indefinitely — it never returns. Callers should
     * break out of the `for await` loop or use an `AbortSignal` to stop.
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
        }
    }

    // ── Internal ──────────────────────────────────────────────────────

    #applyEntry(entry: EventLogEntry): void {
        const stateBefore = this.#state;

        try {
            this.#state = this.#reducer(this.#state, entry);
        } catch (error) {
            this.emitter.emit("replay-error", {
                entry,
                error: error instanceof Error ? error : new Error(String(error)),
            });

            return;
        }

        // If the reducer returned the same reference, it did not handle this
        // event type — invoke the unknown-event strategy.
        if (this.#state === stateBefore && !this.#handleUnknown(entry)) {
            return;
        }

        // The callback returned true ("handled"), but state didn't change.
        // Fall through to emit state-changed anyway (consumer may still
        // want to know the entry was processed).

        this.emitter.emit("state-changed", { state: this.#state, entry });
    }

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
                console.warn(
                    `[EventSource] unhandled event type "${entry.type}" (seq ${String(entry.seq)}). ` +
                        "The event was skipped. Configure `unknownEventHandling` if this is expected.",
                );

                return false;
            }
        }
    }
}
