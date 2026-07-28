/**
 * A bounded, in-memory tape of every admin RPC the Studio itself issued.
 *
 * The three existing log surfaces answer different questions: `getLogs` is the
 * application's durable logs, `getAuditLog` is the SERVER's record of privileged
 * writes, and `getRequestLog` is request-level traffic. None of them says which
 * RPC this UI just called, with which shard and arguments, how long the round
 * trip took, whether it failed before reaching the server, and in what order
 * relative to the other calls one click fanned out. That is the tape a red toast
 * needs to become a specific failed call.
 *
 * **Never persisted, never sent anywhere.** It lives for the session only —
 * persisting it would create a new place for operational data to accumulate,
 * which is not a trade a local operator UI should make silently.
 *
 * **Shapes, never payloads.** An entry records the function path, the shard, a
 * per-function SUMMARY of the arguments (table name, filter count, limit), the
 * duration, and the outcome. Row values never enter the buffer. The summariser
 * map below is explicit per function, and the fallback records argument KEYS
 * only — a blanket `JSON.stringify(args)` is exactly how row data would leak in.
 */

/** How many operations the tape keeps before evicting the oldest. */
const OPERATION_LOG_LIMIT = 300;

/** One recorded Studio operation. */
interface OperationEntry {
    /** Millisecond round trip, absent while the call is still in flight. */
    durationMs?: number;
    /** Error message when the call rejected; absent on success. */
    error?: string;
    /** The `__lunora_admin__:*` path called. */
    functionPath: string;
    /** Rows (or entries) the reply carried, when the shape is countable. */
    resultCount?: number;
    /** Issue order — assigned at DISPATCH, so the tape reflects what was sent, not what landed first. */
    seq: number;
    /** Shard key the call targeted; `""` is the root shard. */
    shardKey: string;
    /** Epoch millis the call was issued. */
    startedAt: number;
    /** Lifecycle: in flight, resolved, or rejected. */
    status: "error" | "ok" | "pending";
    /** Redacted argument summary — see the module docblock. */
    summary: string;
}

/** A function that renders one call's arguments as a short, payload-free string. */
type ArgumentSummariser = (args: Record<string, unknown>) => string;

/** Render a scalar argument for a summary, or `undefined` when it is absent/not scalar. */
const scalar = (value: unknown): string | undefined => {
    if (typeof value === "string") {
        return value === "" ? undefined : value;
    }

    return typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;
};

/** Join the defined parts of a summary with spaces. */
const joinParts = (parts: ReadonlyArray<string | undefined>): string => parts.filter((part) => part !== undefined).join(" ");

/**
 * Per-function argument summarisers, keyed by the bare function name (the part
 * after `__lunora_admin__:`). Anything not listed falls back to argument KEYS
 * only — deliberately lossy, because the default must never be able to leak a
 * value it was not designed for.
 */
const SUMMARISERS: Readonly<Record<string, ArgumentSummariser>> = {
    deleteRows: (args) => joinParts([scalar(args.table), Array.isArray(args.ids) ? `${String(args.ids.length)} rows` : undefined]),
    facetColumn: (args) => joinParts([scalar(args.table), scalar(args.column)]),
    lintSql: () => "sql",
    readTablePage: (args) =>
        joinParts([
            scalar(args.table),
            Array.isArray(args.filters) && args.filters.length > 0 ? `${String(args.filters.length)} filters` : undefined,
            // The SEARCH TERM is a user-typed value and is not recorded — only that
            // one was present.
            typeof args.search === "string" && args.search !== "" ? "search" : undefined,
            typeof args.limit === "number" ? `limit ${String(args.limit)}` : undefined,
        ]),
    runMigration: (args) => joinParts([scalar(args.id), scalar(args.direction), args.dryRun === true ? "dry-run" : undefined]),
    // The statement itself is operator-authored SQL that can embed literals, so
    // only its size is recorded.
    runSql: (args) => (typeof args.sql === "string" ? `${String(args.sql.length)} chars` : ""),
    schemaVersion: (args) => (typeof args.hash === "string" ? args.hash.slice(0, 8) : ""),
    writeRow: (args) => joinParts([scalar(args.table), "1 row"]),
};

/** The `__lunora_admin__:` prefix every Studio RPC path carries. */
const ADMIN_PREFIX = "__lunora_admin__:";

/**
 * Summarise a call's arguments without recording any value the summariser was
 * not explicitly written for.
 */
const summariseArgs = (functionPath: string, args: Record<string, unknown>): string => {
    const name = functionPath.startsWith(ADMIN_PREFIX) ? functionPath.slice(ADMIN_PREFIX.length) : functionPath;
    const summariser = SUMMARISERS[name];

    if (summariser !== undefined) {
        return summariser(args);
    }

    const keys = Object.keys(args);

    return keys.length === 0 ? "" : keys.join(", ");
};

/** Count the rows/entries a reply carried, when its shape makes that meaningful. */
const countResult = (result: unknown): number | undefined => {
    if (Array.isArray(result)) {
        return result.length;
    }

    if (typeof result !== "object" || result === null) {
        return undefined;
    }

    for (const value of Object.values(result)) {
        if (Array.isArray(value)) {
            return value.length;
        }
    }

    return undefined;
};

/**
 * The tape itself. A plain observable object rather than a React context value,
 * so `lib/internal.ts` (which has no hooks) can record from the same choke point
 * the hooks use, and a component subscribes with `useSyncExternalStore`.
 */
class OperationLog {
    private entries: OperationEntry[] = [];

    private listeners = new Set<() => void>();

    private nextSeq = 1;

    /** Snapshot for `useSyncExternalStore`. Referentially stable until something changes. */
    public getSnapshot = (): ReadonlyArray<OperationEntry> => this.entries;

    public subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);

        return () => {
            this.listeners.delete(listener);
        };
    };

    /**
     * Record a dispatch and return its sequence number. Assigned here rather than
     * on completion so the tape shows ISSUE order — a slow call that started first
     * must not appear after the fast one it raced.
     */
    public start(functionPath: string, args: Record<string, unknown>, shardKey: string): number {
        const seq = this.nextSeq;

        this.nextSeq += 1;

        const appended: OperationEntry[] = [
            ...this.entries,
            { functionPath, seq, shardKey, startedAt: Date.now(), status: "pending", summary: summariseArgs(functionPath, args) },
        ];

        // Bound by dropping from the head: a busy session evicts the oldest
        // operations, never the ones the operator is currently looking at.
        this.entries = appended.length > OPERATION_LOG_LIMIT ? appended.slice(appended.length - OPERATION_LOG_LIMIT) : appended;
        this.emit();

        return seq;
    }

    /** Close out a dispatch with its outcome. A `seq` no longer in the buffer is ignored. */
    public settle(seq: number, outcome: { error?: string; result?: unknown }): void {
        const index = this.entries.findIndex((entry) => entry.seq === seq);

        if (index === -1) {
            return;
        }

        const entry = this.entries[index] as OperationEntry;
        const settled: OperationEntry = {
            ...entry,
            durationMs: Date.now() - entry.startedAt,
            ...(outcome.error === undefined
                ? { resultCount: countResult(outcome.result), status: "ok" as const }
                : { error: outcome.error, status: "error" as const }),
        };

        this.entries = this.entries.with(index, settled);
        this.emit();
    }

    public clear(): void {
        this.entries = [];
        this.emit();
    }

    private emit(): void {
        for (const listener of this.listeners) {
            listener();
        }
    }
}

/**
 * The session's tape. A module singleton because the recording choke point
 * (`lib/internal.ts`) is not a React component and cannot read a context.
 */
const operationLog = new OperationLog();

export { OPERATION_LOG_LIMIT, OperationLog, operationLog, summariseArgs };
export type { OperationEntry };
