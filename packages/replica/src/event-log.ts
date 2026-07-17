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
    #nextSeq = 0;
    // eslint-disable-next-line unicorn/no-null -- public contract uses `null` for an empty log head
    #headSeq: GlobalSeq | null = null;

    // ── Mutators ──────────────────────────────────────────────────────

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
            timestamp: Date.now(),
            tableDiffs: diffs,
            clientId: resolvedOptions?.clientId,
            sessionId: resolvedOptions?.sessionId,
            parentSeqNum: parentSeqNumber,
        };

        this.#entries.push(entry);
        this.#headSeq = entry.seq;

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

        return entries;
    }

    /**
     * Replace the log contents with a previously captured snapshot.
     * This is the restore counterpart of {@link EventLog#snapshot}.
     * Restores `headSeq` from the snapshot so auto-parenting continues
     * after restore.
     */
    public load(snapshot: EventLogSnapshot): void {
        this.#entries = [...snapshot.entries];
        this.#nextSeq = snapshot.nextSeq;
        this.#headSeq = snapshot.headSeq;
    }

    // ── Queries ───────────────────────────────────────────────────────

    /**
     * Return **all** entries whose `seq >= sinceSeq`.
     * Useful for catch-up: "give me everything since my last watermark".
     */
    public getSince(sinceSeq: number): ReadonlyArray<EventLogEntry> {
        if (sinceSeq <= 0) {
            return [...this.#entries];
        }

        const first = this.#entries.findIndex((entry) => entry.seq >= sinceSeq);

        return first === -1 ? [] : this.#entries.slice(first);
    }

    /**
     * Paginated read starting at `fromSeq`.
     * @returns `{ entries, hasMore }` where `hasMore` is `true` when more
     * entries exist beyond the requested page.
     */
    public getFrom(fromSeq: number, limit: number = 50): { entries: ReadonlyArray<EventLogEntry>; hasMore: boolean } {
        const first = this.#entries.findIndex((entry) => entry.seq >= fromSeq);

        if (first === -1) {
            return { entries: [], hasMore: false };
        }

        const slice = this.#entries.slice(first, first + limit);

        return {
            entries: slice,
            hasMore: first + limit < this.#entries.length,
        };
    }

    /**
     * Return all entries as a snapshot suitable for serialisation.
     */
    public snapshot(): EventLogSnapshot {
        return {
            entries: [...this.#entries],
            nextSeq: this.#nextSeq,
            headSeq: this.#headSeq,
        };
    }

    /** Number of entries currently in the log. */
    public get size(): number {
        return this.#entries.length;
    }

    /** The next sequence number that will be assigned. */
    public get nextSeq(): number {
        return this.#nextSeq;
    }

    /** Return `true` when there are no entries. */
    public get isEmpty(): boolean {
        return this.#entries.length === 0;
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
        this.#nextSeq = 0;
        // eslint-disable-next-line unicorn/no-null -- null is the public contract for empty log
        this.#headSeq = null;
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
