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
 *   // Transport: fetch the next batch of events after the last known seq.
 *   // `getSince` answers one bounded page; EventsSync keeps calling until the
 *   // log is exhausted.
 *   fetchEventsSince: async (sinceSeq) => (await client.getSince(sinceSeq)).entries,
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

/**
 * Batches one poll cycle will drive before yielding, however much log is left.
 *
 * A catch-up loop that runs until a fetch comes back empty never terminates
 * against a log being written faster than it is read. Bounding the cycle leaves
 * the remainder to the next one, at the advanced watermark, so progress is
 * unaffected and a busy log cannot pin the cycle open (or its `#inFlight`
 * promise, which every concurrent `sync()` awaits).
 */
const MAX_BATCHES_PER_CYCLE = 1000;

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
     *
     * **Must be atomic across the batch: apply every event, or none.** There is
     * no rollback here and none is possible — the state machine is the
     * consumer's. A call that mutates derived state and then throws partway is
     * re-delivered WHOLE on the next poll (the watermark only advances past a
     * batch that fully succeeded, and a replay that threw is not recorded), so a
     * non-atomic implementation applies the events before the throw twice. A
     * call that RETURNS is never re-delivered: {@link EventsSync} tracks the
     * highest applied `seq` separately from the watermark, so a batch whose
     * replay succeeded and whose mirror fan-out then failed is not replayed.
     */
    applyEvents: (events: ReadonlyArray<EventLogEntry>) => void;

    /**
     * Fetch the next batch of events whose `seq >= sinceSeq`.
     *
     * It does NOT have to return the whole backlog: a bounded batch is
     * preferred and is what the DO-backed transport gives you
     * ({@link import("@lunora/replica").EventLogDOClient.getSince |
     * EventLogDOClient.getSince()} answers one page). {@link EventsSync} keeps
     * calling with the advanced watermark until a call returns nothing, so the
     * whole log is applied either way — one bounded atom at a time.
     * In a client context this could call a Lunora action that proxies to the
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

    /**
     * The highest `seq + 1` already handed to `applyEvents`. Runs AHEAD of
     * `#watermark` between a successful replay and the mirror fan-out that
     * commits it, which is exactly the interval a retry must not replay through
     * the state machine a second time.
     */
    #appliedSeq = 0;
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
     * One poll cycle: drive every batch available since the watermark through
     * the pipeline — `applyEvents` → `getTableDiffs` → mirror fan-out →
     * advance the watermark — one batch at a time until a fetch comes back
     * empty.
     *
     * ## One batch at a time, but a whole batch as one atom
     *
     * `fetchEventsSince` answers with whatever the transport is willing to
     * return in one call — for the DO-backed transport that is ONE bounded page
     * (`EventLogDOClient.getSince`), so a returning-from-offline client with a
     * 10k-event backlog never materialises 10k events, and never asks the
     * server to serialise them into one response. Each batch is driven through
     * the pipeline exactly once: a single `applyEvents(events)`, a single
     * `getTableDiffs()`, and a single mirror fan-out — 500 events per page
     * compute ONE aggregate diff, not 500 of them. The loop then re-fetches
     * from the advanced watermark and repeats; the cycle ends when a fetch
     * returns nothing (or when the batch failed to move the watermark forward,
     * which would otherwise spin).
     *
     * The watermark advances past a batch's last event **only after** every
     * diff for that batch has been mirrored — it is the last statement of the
     * iteration, reached only on full success.
     *
     * ## Atomicity on failure — retry the whole batch from a clean state
     *
     * If any stage throws (`applyEvents`, `getTableDiffs`, or a
     * `mirror.applyDiff` partway through the fan-out), control falls to the
     * catch: the error is surfaced via `onError`, the cycle stops, and the
     * watermark is left exactly where the last fully-mirrored batch put it. The
     * next poll therefore re-fetches the SAME batch from the same watermark and
     * re-derives the still-missing diffs.
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
        let total = 0;

        try {
            for (let batches = 0; batches < MAX_BATCHES_PER_CYCLE; batches += 1) {
                // eslint-disable-next-line no-await-in-loop -- each batch is fetched from the watermark the previous one advanced, so the round-trips are inherently sequential
                const events = await this.#options.fetchEventsSince(this.#watermark);

                if (events.length === 0) {
                    return total;
                }

                // ── Whole batch as ONE atom ───────────────────────────────
                // Any throw below skips the watermark advance and lands in the
                // catch: the watermark stays put and the next poll re-fetches
                // and (via the idempotent getTableDiffs) re-derives the missing
                // diffs.
                //
                // Only the events this sync has not already replayed reach
                // `applyEvents`. A batch whose replay SUCCEEDED and then failed
                // downstream (`getTableDiffs`, or a `mirror.applyDiff` partway
                // through the fan-out) is re-fetched from the unmoved watermark,
                // and handing it to the state machine a second time would apply
                // the same events twice — only `getTableDiffs` is required to be
                // idempotent, `applyEvents` is not, and it has no rollback. A
                // replay that THREW is not recorded, so that batch is still
                // retried whole (the state machine's own atomicity, unchanged).
                const fresh = events.filter((event) => event.seq >= this.#appliedSeq);

                if (fresh.length > 0) {
                    this.#options.applyEvents(fresh);
                    this.#appliedSeq = (fresh[fresh.length - 1] as EventLogEntry).seq + 1;
                }

                const diffs = this.#options.getTableDiffs();

                for (const diff of diffs) {
                    this.#options.mirror.applyDiff(diff);
                }

                total += events.length;

                // Every stage succeeded for this batch — advance past its last
                // event. This is the last statement of the iteration, so it is
                // reached only when every diff above has been mirrored.
                const lastEvent = events[events.length - 1] as EventLogEntry;
                const next = lastEvent.seq + 1;

                if (next <= this.#watermark) {
                    // The transport handed back a batch that ends at or before
                    // the watermark it was given: re-fetching would return the
                    // same batch forever. Stop instead of spinning.
                    return total;
                }

                this.#watermark = next;
            }

            // The page budget ran out. A log with a writer faster than this
            // sync never returns an empty batch, so an unbounded loop would
            // never finish — and `#inFlight` would never settle, hanging every
            // later `sync()` on it. The watermark is where the last completed
            // batch left it, so the next cycle picks up exactly there.
            return total;
        } catch (error: unknown) {
            // eslint-disable-next-line no-console -- fallback for a caller that supplied no `onError`; swallowing the failure silently is the worse default
            const onError = this.#options.onError ?? console.error;

            onError(error);

            // The batches that DID complete before the failure are already
            // mirrored and past the watermark — report them rather than
            // claiming the whole cycle did nothing.
            return total;
        }
    }
}
