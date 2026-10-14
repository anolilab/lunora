import type { ClientSeq, GlobalSeq, InputEvent, Seq } from "./seq";
import type { TableDiff } from "./table-diff";

/**
 * A single entry in the append-only {@link EventLog}.
 *
 * Entries are immutable once appended; the `seq` field is assigned
 * monotonically by the log and doubles as a watermark for catch-up
 * replication between tabs or service-worker instances.
 * @experimental
 */
export interface EventLogEntry {
    /**
     * Globally-unique client identifier that originated this event.
     * Set by clients that support offline / optimistic writes.
     * `undefined` when the event was created server-side.
     */
    readonly clientId?: string;

    /**
     * The sequence number of the causal parent event.
     *
     * A {@link GlobalSeq} for events confirmed by the server (pointing
     * to the previous confirmed event), or a {@link ClientSeq} for
     * optimistic / offline events pointing to the local predecessor.
     * `undefined` for the first event in a log.
     */
    readonly parentSeqNum?: Seq;
    /** Arbitrary JSON-serialisable payload. */
    readonly payload: unknown;
    /** Monotonically increasing sequence number (0-based). A {@link GlobalSeq}. */
    readonly seq: GlobalSeq;

    /**
     * Session identifier from the originating client.
     * Paired with `clientId` to disambiguate concurrent sessions.
     */
    readonly sessionId?: string;

    /**
     * Optional table diffs that this event produced.
     * When present, a consumer can re-play the event by applying the diffs
     * to its local mirror without re-executing the originating mutation.
     */
    readonly tableDiffs?: ReadonlyArray<TableDiff>;
    /** Millisecond timestamp (epoch) when the entry was appended. */
    readonly timestamp: number;
    /** Event type discriminator (e.g. "row-insert", "mutation-apply"). */
    readonly type: string;
}

/**
 * Serialised snapshot of the log — used for persistence and transfer.
 * @experimental
 */
export interface EventLogSnapshot {
    readonly entries: ReadonlyArray<EventLogEntry>;
    /** The sequence number of the last entry (head), or `null` for an empty log. */
    readonly headSeq: GlobalSeq | null;
    readonly nextSeq: number;
}

// ─── EventLog ──────────────────────────────────────────────────────────

/**
 * Optional metadata that can accompany an appended event.
 * @experimental
 */
export interface AppendOptions {
    /** Globally-unique client identifier. */
    readonly clientId?: string;

    /**
     * Causal parent sequence number.
     * Automatically set to the previous entry's seq when omitted.
     */
    readonly parentSeqNum?: Seq;
    /** Session identifier within the client. */
    readonly sessionId?: string;

    /**
     * Override the entry's `timestamp` instead of stamping `Date.now()` at
     * append time.
     *
     * Used by callers (e.g. {@link import("./event-source").EventSource | EventSource})
     * that must commit the EXACT entry a reducer already observed — a
     * second, independently-drawn `Date.now()` at append time could produce
     * a persisted entry a timestamp-dependent reducer cannot reproduce on
     * replay.
     */
    readonly timestamp?: number;
}

/**
 * Options for constructing an {@link EventLog}.
 * @experimental
 */
export interface EventLogOptions {
    /**
     * Cap the number of entries retained in memory (REPLICA-06). When an
     * append would exceed the cap, the OLDEST entries are evicted (ring
     * buffer) — a `getSince`/`getFrom` call for a watermark below the oldest
     * retained `seq` then returns only what's left, silently missing
     * anything evicted.
     *
     * `undefined` (the default) preserves the original unbounded behavior.
     * Set this only when you have another durable source of truth for
     * anything older than the cap (a snapshot, a server-side `EventLogDO`) —
     * see {@link EventLog#truncateBelow} for the caller-driven equivalent
     * tied to snapshot persistence.
     */
    readonly maxEntries?: number;
}

/**
 * An append-only, in-memory event log for local event sourcing.
 *
 * The log is the single source of truth for "what happened" and drives
 * catch-up replication: a new tab or service worker asks for entries
 * since its known `seq` watermark and re-applies them.
 * @remarks This class is intentionally **not** a full SQLite-backed log.
 * Persistence is the caller's responsibility (write the snapshot
 * to IndexedDB / OPFS via {@link EventLog#snapshot}).
 * @experimental
 */
export class EventLog {
    #entries: EventLogEntry[] = [];

    /**
     * Logical index of the first LIVE entry within `#entries` (REPLICA-06
     * perf): entries at `[0, #headOffset)` have already been evicted by the
     * cap but are not yet physically removed from the backing array. Bumping
     * this offset is O(1), so a capped append never pays the O(n) cost of
     * shifting the retained array — see `#enforceCap`.
     */
    #headOffset = 0;
    #nextSeq = 0;
    // eslint-disable-next-line unicorn/no-null -- public contract uses `null` for an empty log head
    #headSeq: GlobalSeq | null = null;
    readonly #maxEntries: number | undefined;

    public constructor(options?: EventLogOptions) {
        this.#maxEntries = EventLog.#validateMaxEntries(options?.maxEntries);
    }

    /**
     * Validate `maxEntries` as an invariant: `undefined` (uncapped) or a
     * non-negative safe integer. Negative values would evict everything,
     * fractional/NaN/Infinity values would leave the log over capacity or
     * effectively disable the cap.
     */
    static #validateMaxEntries(maxEntries: number | undefined): number | undefined {
        if (maxEntries === undefined) {
            return undefined;
        }

        if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) {
            throw new RangeError("maxEntries must be a non-negative safe integer");
        }

        return maxEntries;
    }

    /**
     * Entries currently considered live (excludes the evicted-but-not-yet-
     * compacted prefix). ALWAYS returns a fresh copy — never the internal
     * `#entries` array by reference — so a caller iterating the result (e.g.
     * `EventSource.replayFromLog` replaying a log into itself) can't observe
     * later appends made to `#entries` while iterating.
     */
    #liveEntries(): EventLogEntry[] {
        return this.#entries.slice(this.#headOffset);
    }

    // ── Mutators ──────────────────────────────────────────────────────

    /**
     * Evict the oldest entries so the LIVE entry count never exceeds
     * `#maxEntries`. `headSeq`/`nextSeq` are untouched — they're independent
     * counters, not derived from the entries array — so appends after an
     * eviction continue the same sequence.
     *
     * Eviction itself is O(1) (bump `#headOffset`) rather than an O(n)
     * `splice(0, n)` on every capped append. The dead prefix is compacted
     * away in one pass once it reaches half the backing array, which bounds
     * memory growth while keeping the amortized cost of both append and
     * compaction O(1) per entry.
     */
    #enforceCap(): void {
        if (this.#maxEntries === undefined) {
            return;
        }

        const liveCount = this.#entries.length - this.#headOffset;
        const overflow = liveCount - this.#maxEntries;

        if (overflow > 0) {
            this.#headOffset += overflow;
        }

        if (this.#headOffset > 0 && this.#headOffset >= this.#entries.length - this.#headOffset) {
            this.#entries = this.#entries.slice(this.#headOffset);
            this.#headOffset = 0;
        }
    }

    /**
     * Append a new entry to the log.
     *
     * Accepts either an {@link InputEvent} (e.g. from a `defineEvents` factory)
     * or the traditional `(type, payload, tableDiffs?)` triple.
     * @returns The newly created entry (already written to the log).
     */
    public append(event: InputEvent, options?: AppendOptions): EventLogEntry;
    public append(type: string, payload: unknown, tableDiffs?: ReadonlyArray<TableDiff>, options?: AppendOptions): EventLogEntry;
    public append(
        typeOrEvent: string | InputEvent,
        payload?: unknown,
        tableDiffs?: ReadonlyArray<TableDiff> | AppendOptions,
        options?: AppendOptions,
    ): EventLogEntry {
        const type: string = typeof typeOrEvent === "string" ? typeOrEvent : typeOrEvent.type;
        const pl: unknown = typeof typeOrEvent === "string" ? payload : typeOrEvent.payload;

        // Normalise overloaded args: when called as (InputEvent, AppendOptions)
        let diffs: ReadonlyArray<TableDiff> | undefined;
        let resolvedOptions: AppendOptions | undefined;

        if (typeof typeOrEvent === "string") {
            // (type, payload, tableDiffs?, options?)
            diffs = tableDiffs as ReadonlyArray<TableDiff> | undefined;
            resolvedOptions = options;
        } else {
            // (InputEvent, options?)
            diffs = undefined; // InputEvent carries nothing extra
            resolvedOptions = payload as AppendOptions | undefined;
        }

        const parentSeqNumber = resolvedOptions?.parentSeqNum ?? this.#headSeq ?? undefined;
        const seq = this.#nextSeq;

        this.#nextSeq += 1;

        const entry: EventLogEntry = {
            seq,
            type,
            payload: pl,
            // An `InputEvent` carries its own required `timestamp` — when the
            // event was created, which is not when it reaches the log. Honour it
            // here the way {@link EventLog#commitAll} always has; stamping
            // `Date.now()` over it silently rewrote every such event's time.
            timestamp: resolvedOptions?.timestamp ?? (typeof typeOrEvent === "string" ? undefined : typeOrEvent.timestamp) ?? Date.now(),
            tableDiffs: diffs,
            clientId: resolvedOptions?.clientId,
            sessionId: resolvedOptions?.sessionId,
            parentSeqNum: parentSeqNumber,
        };

        this.#entries.push(entry);
        this.#headSeq = entry.seq;
        this.#enforceCap();

        return entry;
    }

    /**
     * Atomically append multiple events to the log.
     *
     * All events are assigned sequential global sequence numbers and
     * automatically wired as a causal chain (each event's `parentSeqNum`
     * points to the previous event in the batch, or to the log head for
     * the first event).
     * @param events An array of events to commit atomically.
     * @returns The newly created entries in order.
     */
    public commitAll(events: ReadonlyArray<InputEvent | { payload: unknown; type: string }>): EventLogEntry[] {
        if (events.length === 0) {
            return [];
        }

        const entries: EventLogEntry[] = [];

        for (const event of events) {
            const { type } = event;
            const payload = "payload" in event ? event.payload : undefined;
            const ts = "timestamp" in event ? event.timestamp : Date.now();

            const parentSeqNumber = entries.at(-1)?.seq ?? this.#headSeq ?? undefined;
            const seq = this.#nextSeq;

            this.#nextSeq += 1;

            const entry: EventLogEntry = {
                seq,
                type,
                payload,
                timestamp: ts,
                parentSeqNum: parentSeqNumber,
            };

            this.#entries.push(entry);
            entries.push(entry);
        }

        this.#headSeq = entries.at(-1)?.seq ?? this.#headSeq;
        this.#enforceCap();

        return entries;
    }

    /**
     * Replace the log contents with a previously captured snapshot.
     * This is the restore counterpart of {@link EventLog#snapshot}.
     * Restores `headSeq` from the snapshot so auto-parenting continues
     * after restore.
     *
     * Runs `#enforceCap()` after restoring so a snapshot captured under a
     * different (or no) `maxEntries` can never leave this log over its
     * configured capacity.
     */
    public load(snapshot: EventLogSnapshot): void {
        this.#entries = [...snapshot.entries];
        this.#headOffset = 0;
        this.#nextSeq = snapshot.nextSeq;
        this.#headSeq = snapshot.headSeq;
        this.#enforceCap();
    }

    // ── Queries ───────────────────────────────────────────────────────

    /**
     * Return **all** entries whose `seq >= sinceSeq`.
     * Useful for catch-up: "give me everything since my last watermark".
     */
    public getSince(sinceSeq: number): ReadonlyArray<EventLogEntry> {
        const live = this.#liveEntries();

        if (sinceSeq <= 0) {
            return live;
        }

        const first = live.findIndex((entry) => entry.seq >= sinceSeq);

        return first === -1 ? [] : live.slice(first);
    }

    /**
     * Paginated read starting at `fromSeq`.
     *
     * `limit` must be a positive safe integer, validated like
     * {@link EventLog#truncateBelow}'s floor and the constructor's `maxEntries`:
     * a `limit` of `0` returned an empty page with `hasMore: true`, which spins a
     * paginating caller forever on a page it can never advance past.
     * @returns `{ entries, hasMore }` where `hasMore` is `true` when more
     * entries exist beyond the requested page.
     */
    public getFrom(fromSeq: number, limit: number = 50): { entries: ReadonlyArray<EventLogEntry>; hasMore: boolean } {
        if (!Number.isSafeInteger(limit) || limit < 1) {
            throw new RangeError("limit must be a positive safe integer");
        }

        // Locate the first live entry at/after `fromSeq` by scanning the backing
        // array from `#headOffset` — never materialize the whole retained log
        // (an uncapped log would make each page O(total history)); copy only the
        // requested page. The `index >= #headOffset` guard skips already-evicted
        // entries still awaiting compaction.
        const entries = this.#entries;
        const start = this.#headOffset;
        const first = entries.findIndex((entry, index) => index >= start && entry.seq >= fromSeq);

        if (first === -1) {
            return { entries: [], hasMore: false };
        }

        const end = Math.min(first + limit, entries.length);

        return {
            entries: entries.slice(first, end),
            hasMore: end < entries.length,
        };
    }

    /**
     * Return all entries as a snapshot suitable for serialisation.
     */
    public snapshot(): EventLogSnapshot {
        return {
            entries: this.#liveEntries(),
            nextSeq: this.#nextSeq,
            headSeq: this.#headSeq,
        };
    }

    /** Number of entries currently in the log. */
    public get size(): number {
        return this.#entries.length - this.#headOffset;
    }

    /** The next sequence number that will be assigned. */
    public get nextSeq(): number {
        return this.#nextSeq;
    }

    /** Return `true` when there are no entries. */
    public get isEmpty(): boolean {
        return this.size === 0;
    }

    /**
     * The sequence number of the last (most recent) entry, or `null`
     * when the log is empty. Used internally for auto-parenting and
     * exposed for consumers that need the causal head.
     */
    public get headSeq(): GlobalSeq | null {
        return this.#headSeq;
    }

    /** Remove all entries (primarily for testing). */
    public clear(): void {
        this.#entries = [];
        this.#headOffset = 0;
        this.#nextSeq = 0;
        // eslint-disable-next-line unicorn/no-null -- null is the public contract for empty log
        this.#headSeq = null;
    }

    /**
     * Discard all entries with `seq < floorSeq` (REPLICA-06).
     *
     * `headSeq`/`nextSeq` are untouched (they're independent counters), so
     * appends after a truncation continue the same sequence uninterrupted.
     *
     * **Caller-driven, not automatic**: only call this after the truncated
     * range has already been durably captured elsewhere (a snapshot, a
     * server-side `EventLogDO`) — truncating without such a floor makes any
     * future `getSince`/`getFrom`/`EventSource.replayFromLog` call for a
     * watermark below `floorSeq` silently miss the discarded entries. This is
     * the hook the caller ties to snapshot persistence; the log itself has no
     * concept of "already durably persisted".
     *
     * `floorSeq` must be a non-negative safe integer — `NaN` would make
     * every comparison false and silently clear the entire log.
     */
    public truncateBelow(floorSeq: number): void {
        if (!Number.isSafeInteger(floorSeq) || floorSeq < 0) {
            throw new RangeError("floorSeq must be a non-negative safe integer");
        }

        const live = this.#liveEntries();
        const cutoff = live.findIndex((entry) => entry.seq >= floorSeq);

        this.#entries = cutoff === -1 ? [] : live.slice(cutoff);
        this.#headOffset = 0;
    }

    /**
     * Return an async generator that yields every entry starting from
     * `fromSeq` (default `0` = all entries).
     *
     * Because `EventLog` is purely in-memory, the generator yields all
     * matching entries synchronously on first iteration and then completes.
     * For a streaming / push-based variant see {@link EventSource.events}.
     */
    // eslint-disable-next-line @typescript-eslint/require-await -- kept async so callers can uniformly `for await` over any event stream
    public async *events(fromSeq: number = 0): AsyncGenerator<EventLogEntry> {
        const entries = this.getSince(fromSeq);

        for (const entry of entries) {
            yield entry;
        }
    }
}
