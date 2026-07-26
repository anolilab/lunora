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
 *   // Recompute a FULL diff from the current mirror-vs-source state.
 *   // MUST be idempotent: no cursor side-effect — calling it twice without
 *   // new events returns the same diffs, so a failed batch can be retried.
 *   getTableDiffs: () => diffMirrorAgainst(source.state),
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
     * **recomputes a full diff from the current mirror-vs-source state** and
     * returns the diffs needed to bring the LocalMirror up to date.
     *
     * **MUST be idempotent** — it must NOT advance a one-shot cursor as a side
     * effect. A batch that fails partway (a `mirror.applyDiff` throws) is
     * retried on the next poll from the same watermark; if this call consumed a
     * cursor on the first attempt it would return `[]` on the retry and the
     * un-mirrored diffs would be lost forever. Recompute-from-current-state has
     * no such hazard: calling it again with no new events returns the same
     * diffs, and calling it after a partial mirror write returns exactly the
     * diffs still missing from the mirror.
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
     * One poll cycle: fetch the whole batch since the watermark, then drive it
     * through the pipeline as ONE atom — `applyEvents` → `getTableDiffs` →
     * mirror fan-out → advance the watermark.
     *
     * ## Whole batch as one atom
     *
     * A returning-from-offline client with a large backlog drives the WHOLE
     * fetched batch through the pipeline once: a single `applyEvents(events)`,
     * a single `getTableDiffs()`, and a single mirror fan-out. A 500-event
     * catch-up therefore computes ONE aggregate diff and issues ONE mirror
     * round, not 500 of each. The watermark advances past the last event **only
     * after** every diff has been mirrored — it is the LAST statement in the
     * try, reached only on full success.
     *
     * ## Atomicity on failure — retry the whole batch from a clean state
     *
     * If any stage throws (`applyEvents`, `getTableDiffs`, or a
     * `mirror.applyDiff` partway through the fan-out), control falls to the
     * catch: the error is surfaced via `onError` and the watermark is left
     * exactly where it was. The next poll therefore re-fetches the SAME batch
     * from the same watermark and re-derives the still-missing diffs.
     *
     * This is safe — and lossless — precisely because `getTableDiffs` is
     * required to be idempotent (recompute-from-current-mirror-state, no
     * one-shot cursor; see its contract). A partial mirror write on the failed
     * attempt leaves the mirror ahead for the diffs that landed; the retry's
     * `getTableDiffs` returns exactly the diffs still missing, and
     * `mirror.applyDiff` is itself idempotent (deterministic `deriveInsertId`).
     * No un-mirrored diff suffix is ever stranded, and the watermark never
     * advances past a diff the mirror never received.
     */
    async #pollOnce(): Promise<number> {
        try {
            const events = await this.#options.fetchEventsSince(this.#watermark);

            if (events.length === 0) {
                return 0;
            }

            // ── Whole batch as ONE atom ───────────────────────────────────
            // Any throw below skips the watermark advance and lands in the
            // catch: the watermark stays put and the next poll re-fetches and
            // (via the idempotent getTableDiffs) re-derives the missing diffs.
            this.#options.applyEvents(events);

            const diffs = this.#options.getTableDiffs();

            for (const diff of diffs) {
                this.#options.mirror.applyDiff(diff);
            }

            // Every stage succeeded for the whole batch — advance past the last
            // event in one step. This is the last statement, so it is reached
            // only when every diff above has been mirrored.
            const lastEvent = events[events.length - 1] as EventLogEntry;

            this.#watermark = lastEvent.seq + 1;

            return events.length;
        } catch (error: unknown) {
            const onError = this.#options.onError ?? console.error;

            onError(error);

            return 0;
        }
    }
}
