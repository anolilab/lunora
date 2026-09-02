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
 * **Argument shapes, never argument payloads.** An entry records the function
 * path, the shard, a per-function SUMMARY of the arguments (table name, filter
 * count, limit), the duration, and the outcome. The summariser map below is
 * explicit per function, and the fallback records argument KEYS only — a blanket
 * `JSON.stringify(args)` is exactly how row data would leak in.
 *
 * The one thing stored verbatim is a rejection's `message`, which the server
 * writes and which CAN echo user data (SQLite's `near "<token>": syntax error`
 * quotes the statement; a constraint violation can quote a value). That is a
 * deliberate trade — the message is the diagnosis, it is already on screen in the
 * error alert, and the tape is memory-only, never persisted or transmitted. The
 * ⧉ Copy action deliberately copies only path + summary + shard, not the error.
 */

import type { ADMIN_FUNCTIONS } from "./admin";

/** How many operations the tape keeps before evicting the oldest. */
const OPERATION_LOG_LIMIT = 300;

/**
 * Whether an entry is a one-shot request/response, or a live WS subscription
 * that stays open and receives pushes. The distinction matters for reading the
 * tape: a `call` that never leaves `pending` is a hung request, whereas a
 * `subscription` that sits at `live` is working exactly as intended.
 */
type OperationKind = "call" | "subscription";

/** One recorded Studio operation. */
interface OperationEntry {
    /**
     * Millisecond round trip for a `call`; for a `subscription`, how long the
     * channel stayed open (set when it closes).
     */
    durationMs?: number;
    /** Error message when the call rejected or the subscription failed. */
    error?: string;
    /** The `__lunora_admin__:*` path called. */
    functionPath: string;
    kind: OperationKind;

    /**
     * Server pushes received on a `subscription`. ONE entry counts them all — an
     * entry per push would evict everything else on the tape within seconds of
     * opening a live data-browser view. Mutated in place by {@link
     * OperationLog.recordPush} while nothing is subscribed to the tape.
     */
    pushes?: number;
    /** Rows (or entries) the reply carried, when the shape is countable. */
    resultCount?: number;
    /** Issue order — assigned at DISPATCH, so the tape reflects what was sent, not what landed first. */
    seq: number;
    /** Shard key the call targeted; `""` is the root shard. */
    shardKey: string;
    /** Epoch millis the call was issued. */
    startedAt: number;
    /** Lifecycle: `pending`/`ok`/`error` for a call, `live`/`closed`/`error` for a subscription. */
    status: "closed" | "error" | "live" | "ok" | "pending";
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
 * Describe the predicate a bulk write ran against — the filter count and whether
 * a search term was present, or an explicit `no predicate` when there was
 * neither.
 *
 * The explicit form matters: a predicate-free `deleteRows`/`patchRows` hits every
 * row in the table, and rendering that as an absent count (the previous
 * behaviour) made it indistinguishable on the tape from a targeted one. The
 * search TERM is operator-typed data and is never recorded — only that one
 * existed, matching `readTablePage`.
 */
const describePredicate = (args: Record<string, unknown>): string => {
    const filterCount = Array.isArray(args.filters) ? args.filters.length : 0;
    const searched = typeof args.search === "string" && args.search !== "";

    if (filterCount === 0 && !searched) {
        return "no predicate";
    }

    return joinParts([filterCount === 0 ? undefined : `${String(filterCount)} filters`, searched ? "search" : undefined]);
};

/**
 * Per-function argument summarisers, keyed by the bare function name (the part
 * after `__lunora_admin__:`). Anything not listed falls back to argument KEYS
 * only — deliberately lossy, because the default must never be able to leak a
 * value it was not designed for.
 *
 * Keyed against `ADMIN_FUNCTIONS` rather than plain `string` so a typo is a
 * compile error instead of an entry that silently never matches, and so the
 * covered set is discoverable from the type.
 */
const SUMMARISERS: Readonly<Partial<Record<keyof typeof ADMIN_FUNCTIONS, ArgumentSummariser>>> = {
    // Whole-table truncate. Without an entry its tape line read "table" — the
    // argument KEY, not which table — for the second-most destructive action here.
    clearTable: (args) => joinParts([scalar(args.table), "whole table"]),
    // "no predicate" is the load-bearing part: a `deleteRows` with neither filters
    // nor a search term deletes every row, exactly like `clearTable`, and a count
    // of `0 filters` renders as nothing at all — so the tape could not tell a
    // targeted delete from a truncate.
    deleteRows: (args) => joinParts([scalar(args.table), describePredicate(args)]),
    facetColumn: (args) => joinParts([scalar(args.table), scalar(args.column)]),
    // The ROWS are operator-supplied data and are not recorded — only how many,
    // and which tables (schema, not data) they land in.
    importShard: (args) => {
        if (!Array.isArray(args.rows)) {
            return "";
        }

        // `operationLog.start` runs BEFORE dispatch, so a malformed row never
        // reaches server validation: reading `.table` off a `null` entry threw
        // here and took the whole operation down with a TypeError instead of the
        // RPC's own error. Narrow to real objects first.
        const tables = [
            ...new Set(
                args.rows
                    .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
                    .map((row) => row["table"])
                    .filter((table) => typeof table === "string"),
            ),
        ].toSorted((a, b) => a.localeCompare(b));

        return joinParts([`${String(args.rows.length)} rows`, tables.length === 0 ? undefined : `into ${tables.join(", ")}`]);
    },
    lintSql: () => "sql",
    // The patched VALUES are operator-supplied data and are not recorded — only
    // the field NAMES (schema, not data) and the size of the predicate.
    patchRows: (args) =>
        joinParts([
            scalar(args.table),
            typeof args.doc === "object" && args.doc !== null ? `set ${Object.keys(args.doc).join(", ")}` : undefined,
            describePredicate(args),
        ]),
    // The restore TARGET is the whole point of the entry — an operation tape that
    // records a point-in-time restore as "time" (the argument key) cannot answer
    // the only question anyone asks it afterwards. The bookmark is an opaque,
    // long DO token, so only its presence is recorded.
    pitrRestore: (args) =>
        joinParts([
            scalar(args.time) === undefined ? undefined : `to ${String(args.time)}`,
            typeof args.bookmark === "string" && args.bookmark !== "" ? "from bookmark" : undefined,
            args.restart === true ? "restart now" : undefined,
        ]),
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
    const summariser = SUMMARISERS[name as keyof typeof ADMIN_FUNCTIONS];

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
        return this.append(functionPath, args, shardKey, "call", "pending");
    }

    /** Record an opening live subscription. See {@link OperationEntry.pushes} for why one entry per channel. */
    public startSubscription(functionPath: string, args: Record<string, unknown>, shardKey: string): number {
        return this.append(functionPath, args, shardKey, "subscription", "live");
    }

    /**
     * Count one server push on an open subscription. Updates the existing entry's
     * counter — deliberately the only thing a push does to the tape.
     */
    public recordPush(seq: number): void {
        // The one genuinely hot path: this fires on every push of every live
        // admin subscription (logs, traces, metrics, the data browser…), which is
        // once per DO write-flush. `patch` costs a `findIndex` plus a full
        // OPERATION_LOG_LIMIT-element array copy, and the console is closed
        // almost always — so when nothing is subscribed, bump the counter in
        // place and skip both. The immutable-snapshot contract that
        // `useSyncExternalStore` relies on only matters while a listener exists.
        if (this.listeners.size === 0) {
            const entry = this.entries.find((candidate) => candidate.seq === seq);

            if (entry !== undefined) {
                entry.pushes = (entry.pushes ?? 0) + 1;
            }

            return;
        }

        this.patch(seq, (entry) => {
            return { ...entry, pushes: (entry.pushes ?? 0) + 1 };
        });
    }

    /** Mark an open subscription as failed (the channel rejected, e.g. no admin token). */
    public failSubscription(seq: number, error: string): void {
        this.patch(seq, (entry) => {
            return { ...entry, error, status: "error" };
        });
    }

    /** Close an open subscription, stamping how long it stayed open. */
    public endSubscription(seq: number): void {
        // A channel that already failed keeps its error status; closing it is just
        // the teardown of something already reported broken.
        this.patch(seq, (entry) => (entry.status === "error" ? entry : { ...entry, durationMs: Date.now() - entry.startedAt, status: "closed" }));
    }

    /** The most recent entry that failed, for "show me what just broke". */
    public lastErrorSeq(): number | undefined {
        return this.entries.findLast((entry) => entry.status === "error")?.seq;
    }

    /** Close out a dispatch with its outcome. A `seq` no longer in the buffer is ignored. */
    public settle(seq: number, outcome: { error?: string; result?: unknown }): void {
        this.patch(seq, (entry) => {
            return {
                ...entry,
                durationMs: Date.now() - entry.startedAt,
                ...(outcome.error === undefined
                    ? { resultCount: countResult(outcome.result), status: "ok" as const }
                    : { error: outcome.error, status: "error" as const }),
            };
        });
    }

    public clear(): void {
        this.entries = [];
        this.emit();
    }

    /** Append a new entry, bounding the tape. Shared by calls and subscriptions. */
    private append(functionPath: string, args: Record<string, unknown>, shardKey: string, kind: OperationKind, status: OperationEntry["status"]): number {
        const seq = this.nextSeq;

        this.nextSeq += 1;

        const entry: OperationEntry = {
            functionPath,
            kind,
            seq,
            shardKey,
            startedAt: Date.now(),
            status,
            summary: summariseArgs(functionPath, args),
            ...(kind === "subscription" ? { pushes: 0 } : {}),
        };
        const appended: OperationEntry[] = [...this.entries, entry];

        // Bound by dropping from the head: a busy session evicts the oldest
        // operations, never the ones the operator is currently looking at.
        this.entries = appended.length > OPERATION_LOG_LIMIT ? appended.slice(appended.length - OPERATION_LOG_LIMIT) : appended;
        this.emit();

        return seq;
    }

    /** Replace one entry in place. A `seq` no longer in the buffer is ignored. */
    private patch(seq: number, update: (entry: OperationEntry) => OperationEntry): void {
        const index = this.entries.findIndex((entry) => entry.seq === seq);

        if (index === -1) {
            return;
        }

        this.entries = this.entries.with(index, update(this.entries[index] as OperationEntry));
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
export type { OperationEntry, OperationKind };
