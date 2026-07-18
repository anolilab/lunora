/**
 * EventsSync — connect an event-sourced state machine to a LocalMirror.
 *
 * This module bridges the gap between an event log (e.g.
 * {@link import("@lunora/replica").EventSource | EventSource} from
 * `@lunora/replica` or a custom reducer) and the
 * {@link LocalMirror | local SQLite mirror}:
 *
 * ```
 * EventLog (server/DO)  ──fetchEventsSince──▶  EventsSync
 *                                                   │
 *                                           ┌───────┴────────┐
 *                                           │  applyEvents()  │  update derived state
 *                                           └───────┬────────┘
 *                                                   │
 *                                           ┌───────┴────────┐
 *                                           │ getTableDiffs()│  state → TableDiff[]
 *                                           └───────┬────────┘
 *                                                   │
 *                                           ┌───────┴────────┐
 *                                           │  mirror.applyDiff()  │
 *                                           └────────────────┘
 * ```
 *
 * ## Usage
 *
 * ```ts
 * import { EventSource } from "@lunora/replica";
 * import { EventsSync } from "@lunora/replica";
 * import type { EventLogEntry } from "@lunora/replica";
 *
 * // Your event-sourced state machine
 * const source = new EventSource(initialState, reducer);
 * let cachedState = source.state;
 *
 * const sync = new EventsSync({
 *   // Transport: fetch events since last known seq
 *   fetchEventsSince: (sinceSeq) => client.getSince(sinceSeq),
 *
 *   // Replay events through the EventSource
 *   applyEvents: (events) => {
 *     source.apply(events.map(e => ({ type: e.type, payload: e.payload })));
 *   },
 *
 *   // Convert updated state to table diffs
 *   getTableDiffs: () => {
 *     const next = source.state;
 *     const diffs = myDiffFn(cachedState, next);
 *     cachedState = next;
 *     return diffs;
 *   },
 *
 *   mirror: myLocalMirror,
 *   pollInterval: 3000,
 * });
 *
 * sync.start();
 * ```
 * @module
 */

import type { EventLogEntry } from "./event-log";
import type { LocalMirror } from "./local-mirror";
import type { TableDiff } from "./table-diff";

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Options for constructing an {@link EventsSync}.
 * @experimental
 */
export interface EventsSyncOptions {
    /**
     * Replay a batch of events through the derived-state machine.
     *
     * Called with every batch of new events fetched from the log. The
     * consumer should feed these events into their state machine
     * (e.g. an {@link import("@lunora/replica").EventSource | EventSource})
     * so that the machine's state reflects the latest log position.
     */
    applyEvents: (events: ReadonlyArray<EventLogEntry>) => void;

    /**
     * Fetch all events whose `seq >= sinceSeq`.
     *
     * In a server-side context, this typically wraps
     * {@link import("@lunora/replica").EventLogDOClient.getSince |
     * EventLogDOClient.getSince()}.
     * In a client context it could call a Lunora action that proxies to the
     * event log, or read from an IndexedDB cache.
     *
     * Return an empty array when there are no new events.
     */
    fetchEventsSince: (sinceSeq: number) => Promise<ReadonlyArray<EventLogEntry>>;

    /**
     * Produce {@link TableDiff | TableDiffs} from the current derived state.
     *
     * Called after every batch of events has been applied. The consumer
     * compares the state _before_ and _after_ the batch and returns the
     * diffs needed to bring the LocalMirror up to date.
     *
     * Return an empty array when there are no changes to push to the mirror.
     */
    getTableDiffs: () => TableDiff[];

    /**
     * The local SQLite mirror to apply diffs to.
     */
    mirror: LocalMirror;

    /**
     * Called when an error occurs during a poll cycle.
     *
     * Defaults to `console.error`. Set to a no-op to suppress error logging.
     */
    onError?: (error: unknown) => void;

    /**
     * How often to poll for new events (in milliseconds).
     * @default 5000
     */
    pollInterval?: number;
}

// ── EventsSync ─────────────────────────────────────────────────────────────

/**
 * Periodically polls an event log, replays events through a state machine,
 * converts the resulting state into {@link TableDiff | TableDiffs}, and
 * applies them to a {@link LocalMirror}.
 *
 * The class is **transport-agnostic** — it accepts a generic
 * `fetchEventsSince` function rather than coupling to a specific source
 * (EventLogDO, WebSocket push, IndexedDB, etc.).
 *
 * ## Lifecycle
 *
 * 1. Call `start()` to begin periodic polling.
 * 2. Call `sync()` to perform an immediate one-shot sync.
 * 3. Call `stop()` to halt polling.
 *
 * The current watermark is exposed via `watermark` and advances
 * monotonically as events are applied.
 * @experimental
 */
export class EventsSync {
    readonly #options: EventsSyncOptions;
    /** The highest `seq + 1` that has been applied. Starts at `0`. */
    #watermark = 0;
    #timer: ReturnType<typeof setInterval> | undefined;

    /**
     * The in-flight poll cycle, or `undefined` when idle. A concurrent
     * `sync()`/timer tick AWAITS this instead of no-op'ing (REPLICA-08) —
     * previously a concurrent call returned `0` immediately without waiting
     * for the in-progress cycle to actually finish.
     */
    #inFlight: Promise<number> | undefined;

    // ── Constructor ─────────────────────────────────────────────────────

    public constructor(options: EventsSyncOptions) {
        this.#options = options;
    }

    // ── Public API ──────────────────────────────────────────────────────

    /**
     * The current watermark — the next `seq` the sync will fetch from.
     *
     * Starts at `0` (fetch everything). Advances to `max(seq) + 1` after
     * each successful poll cycle.
     */
    public get watermark(): number {
        return this.#watermark;
    }

    /**
     * Start polling for new events on the configured interval.
     *
     * Does nothing if polling is already active.
     * Does **not** perform an initial sync — call {@link sync} once if you
     * need to catch up immediately.
     */
    public start(): void {
        if (this.#timer !== undefined) {
            return;
        }

        const ms = this.#options.pollInterval ?? 5000;

        this.#timer = setInterval(() => {
            this.#poll().catch(() => undefined);
        }, ms);
    }

    /**
     * Stop polling for new events.
     *
     * Safe to call when not started.
     */
    public stop(): void {
        if (this.#timer !== undefined) {
            clearInterval(this.#timer);
            this.#timer = undefined;
        }
    }

    /**
     * Perform a one-shot sync: fetch events since the current watermark,
     * apply them through the state machine, and push diffs to the mirror.
     * @returns The number of events that were fetched and applied.
     */
    public async sync(): Promise<number> {
        return this.#poll();
    }

    // ── Internal ────────────────────────────────────────────────────────

    /**
     * Entry point for a poll cycle. A cycle already in flight is AWAITED
     * (not restarted, not no-op'd) so a `sync()` racing a timer tick — or two
     * concurrent `sync()` calls — observes the real outcome of the one cycle
     * that actually runs (REPLICA-08).
     */
    async #poll(): Promise<number> {
        if (this.#inFlight) {
            return this.#inFlight;
        }

        const promise = this.#pollOnce().finally(() => {
            this.#inFlight = undefined;
        });

        this.#inFlight = promise;

        return promise;
    }

    /**
     * One poll cycle: fetch → (apply → diff → mirror) per event.
     *
     * Each event is driven through the FULL pipeline — `applyEvents`,
     * `getTableDiffs`, and `mirror.applyDiff` — atomically before the
     * watermark advances past it (REPLICA-08). Advancing the watermark any
     * earlier (e.g. right after `applyEvents`) would let a later throw from
     * `getTableDiffs`/`mirror.applyDiff` skip mirror delivery for that event
     * PERMANENTLY, since the next poll would never re-fetch it. Keeping the
     * watermark pinned to the last event whose entire pipeline succeeded
     * means the next poll re-fetches exactly the unapplied remainder — never
     * re-applying a fully-succeeded event, never silently dropping one that
     * partially failed.
     */
    async #pollOnce(): Promise<number> {
        try {
            const events = await this.#options.fetchEventsSince(this.#watermark);

            if (events.length === 0) {
                return 0;
            }

            let appliedCount = 0;

            try {
                for (const event of events) {
                    this.#options.applyEvents([event]);

                    const diffs = this.#options.getTableDiffs();

                    for (const diff of diffs) {
                        this.#options.mirror.applyDiff(diff);
                    }

                    // Only advance the watermark once state, diff generation,
                    // AND mirror persistence have all succeeded for this
                    // event — a throw at any stage above leaves the
                    // watermark where it was, so the next poll retries this
                    // event (and only this event) instead of permanently
                    // skipping it.
                    this.#watermark = event.seq + 1;
                    appliedCount += 1;
                }
            } catch (error) {
                const onError = this.#options.onError ?? console.error;

                onError(error);
            }

            return appliedCount;
        } catch (error: unknown) {
            const onError = this.#options.onError ?? console.error;

            onError(error);

            return 0;
        }
    }
}
