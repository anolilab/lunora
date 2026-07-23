// eslint-disable-next-line n/no-unsupported-features/node-builtins -- `node:sqlite` is stable on Node ^22.15 || >=24.10 and is the deliberate in-memory engine for this Node-only reference host
import { DatabaseSync } from "node:sqlite";

import type {
    ScheduleOptions,
    SchedulerHost,
    ShardAsyncSqlExec,
    ShardDirectory,
    ShardHost,
    ShardJurisdiction,
    ShardSqlExec,
    ShardStub,
    SocketHandle,
    SocketHost,
} from "@lunora/platform";

/**
 * A conformance host bundles all four platform contracts so a single factory
 * can stand up a complete, isolated test environment.
 */
interface ConformanceHost {
    /** Optional cleanup hook (close DBs, release timers). */
    cleanup?: () => void;
    /** The shard directory under test. */
    directory: ShardDirectory;
    /** The scheduler host under test. */
    scheduler: SchedulerHost;
    /** The shard execution slot under test. */
    shard: ShardHost;
    /** The socket subscription host under test. */
    socket: SocketHost;
}

/**
 * Factory signature consumed by `defineHostContractSuite`. Must return a
 * fresh, isolated host for each test run.
 */
type ConformanceHostFactory = () => ConformanceHost | Promise<ConformanceHost>;

/** Internal state of a reference socket. */
type ReferenceSocket = {
    attachment: unknown;
    closed: boolean;
    handle: SocketHandle;
    id: string;
    received: (string | ArrayBuffer)[];
    tags: Set<string>;
};

/** Internal state of a reference shard. */
type ReferenceShardState = {
    /** Serialized alarm timestamp, or null if none. */
    alarmAt: number | null;
    /** Pending alarm timeout handle. */
    alarmTimeout: ReturnType<typeof setTimeout> | null;
    /** Queue of serialized closures waiting for the single-writer gate. */
    pending: {
        function_: () => Promise<unknown>;
        reject: (reason: unknown) => void;
        resolve: (value: unknown) => void;
    }[];
    /** True while a serialized closure is running. */
    running: boolean;
};

let socketCounter = 0;
let jobCounter = 0;

const nextSocketId = (): string => {
    socketCounter += 1;

    return `socket-${socketCounter}`;
};

const nextJobId = (): string => {
    jobCounter += 1;

    return `job-${jobCounter}`;
};

const normalizeBinding = (value: unknown): unknown => (value === undefined ? null : value);

const extractArrayBuffer = (data: string | ArrayBufferLike | Blob | ArrayBufferView): ArrayBuffer => {
    if (typeof data === "string") {
        const encoder = new TextEncoder();

        return encoder.encode(data).buffer;
    }

    if (data instanceof ArrayBuffer) {
        return data;
    }

    if (ArrayBuffer.isView(data)) {
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    }

    // Blob is not supported in this reference host.
    return new ArrayBuffer(0);
};

/**
 * Create a reference in-memory conformance host built on `node:sqlite`.
 *
 * This is the cheapest possible host that satisfies the `@lunora/platform`
 * contracts. It is intentionally not production-ready — it exists so the TCK
 * can assert the contract shape without wrangler/miniflare overhead.
 */
const createReferenceHost = (): ReferenceHost => {
    // Each shard gets its own in-memory SQLite database. The TCK uses one shard
    // key per host, so a single DB is sufficient.
    const database = new DatabaseSync(":memory:");

    const shardState: ReferenceShardState = {
        alarmAt: null,
        alarmTimeout: null,
        pending: [],
        running: false,
    };

    // Socket state is split into "runtime" (in-memory handles) and "durable"
    // (serialized attachments). Tests call `simulateRecycle()` to clear runtime
    // state, then `restoreSocket()` to rehydrate from durable attachments.
    const runtimeSockets = new Map<string, ReferenceSocket>();
    const durableAttachments = new Map<string, unknown>();

    const sql: ShardSqlExec = {
        exec: (query, ...bindings) => {
            const statement = database.prepare(query);
            const normalized = bindings.map(normalizeBinding) as import("node:sqlite").SQLInputValue[];
            const trimmed = query.trim().toLowerCase();

            // Cloudflare SqlStorage.exec returns a cursor-like object. For reads
            // `toArray()` returns rows; for writes `rowsAffected` is present.
            if (trimmed.startsWith("select")) {
                return {
                    toArray: () => statement.all(...normalized),
                };
            }

            const result = statement.run(...normalized);

            return { rowsAffected: Number(result.changes) };
        },
    };

    const asyncSql: ShardAsyncSqlExec = {
        all: async (query_, params) => {
            const statement = database.prepare(query_);

            return statement.all(...(params as import("node:sqlite").SQLInputValue[]));
        },
        run: async (query_, params) => {
            const statement = database.prepare(query_);
            const result = statement.run(...(params as import("node:sqlite").SQLInputValue[]));

            return { rowsAffected: Number(result.changes) };
        },
    };

    const drainQueue = (): void => {
        if (shardState.running || shardState.pending.length === 0) {
            return;
        }

        const next = shardState.pending.shift();

        if (next === undefined) {
            return;
        }

        shardState.running = true;
        next.function_()
            .then(next.resolve, next.reject)
            .finally(() => {
                shardState.running = false;
                drainQueue();
            });
    };

    const runSerialized: ShardHost["runSerialized"] = (function_) =>
        new Promise((resolve, reject) => {
            shardState.pending.push({
                function_,
                reject: (reason: unknown) => {
                    reject(reason);
                },
                resolve: (value: unknown) => {
                    resolve(value as never);
                },
            });
            drainQueue();
        });

    const transaction: ShardHost["transaction"] = async (function_) => {
        database.exec("BEGIN");
        try {
            const result = await function_();
            database.exec("COMMIT");

            return result;
        } catch (error) {
            database.exec("ROLLBACK");
            throw error;
        }
    };

    const setAlarm = (timestamp: number | Date): void => {
        const ms = typeof timestamp === "number" ? timestamp : timestamp.getTime();
        shardState.alarmAt = ms;

        if (shardState.alarmTimeout !== null) {
            clearTimeout(shardState.alarmTimeout);
        }

        const delay = Math.max(0, ms - Date.now());
        shardState.alarmTimeout = setTimeout(() => {
            shardState.alarmAt = null;
            shardState.alarmTimeout = null;
        }, delay);
    };

    const alarms: ShardHost["alarms"] = {
        delete: () => {
            shardState.alarmAt = null;
            if (shardState.alarmTimeout !== null) {
                clearTimeout(shardState.alarmTimeout);
                shardState.alarmTimeout = null;
            }
        },
        get: () => shardState.alarmAt,
        set: setAlarm,
    };

    const shard: ShardHost = {
        alarms,
        asyncSql,
        runSerialized,
        sql,
        transaction,
        waitUntil: () => {
            // The reference host does not distinguish request/background
            // lifetimes; fire-and-forget work is left to the caller.
        },
    };

    const createHandle = (socket: ReferenceSocket): SocketHandle => {
        const handle: SocketHandle = {
            close: (_code, _reason) => {
                socket.closed = true;
            },
            deserializeAttachment: () => socket.attachment,
            id: socket.id,
            send: (data) => {
                socket.received.push(extractArrayBuffer(data));
            },
            serializeAttachment: (value) => {
                socket.attachment = value;
                durableAttachments.set(socket.id, value);
            },
        };
        socket.handle = handle;

        return handle;
    };

    const socket: SocketHost = {
        accept: (_socket, attachment) => {
            const id = nextSocketId();
            const socketState: ReferenceSocket = {
                attachment,
                closed: false,
                handle: null as unknown as SocketHandle,
                id,
                received: [],
                tags: new Set(),
            };
            runtimeSockets.set(id, socketState);

            if (attachment !== undefined) {
                durableAttachments.set(id, attachment);
            }

            return createHandle(socketState);
        },
        getSockets: (tag) => {
            const sockets = [...runtimeSockets.values()];
            const filtered = tag === undefined ? sockets : sockets.filter((s) => s.tags.has(tag));

            return filtered.map((s) => s.handle);
        },
        removeTag: (handle, tag) => {
            const socketState = runtimeSockets.get(handle.id);

            if (socketState === undefined) {
                return;
            }

            if (tag === undefined) {
                socketState.tags.clear();
            } else {
                socketState.tags.delete(tag);
            }
        },
        setTag: (handle, tag) => {
            const socketState = runtimeSockets.get(handle.id);

            if (socketState !== undefined) {
                socketState.tags.add(tag);
            }
        },
    };

    const directory: ShardDirectory = {
        get: (id) => {
            const stub: ShardStub = {
                fetch: async () => new Response(String(id)),
            };

            return stub;
        },
        getByName: (name) => {
            const stub: ShardStub = {
                fetch: async () => new Response(name),
            };

            return stub;
        },
        idForName: (name) => `shard:${name}`,
        jurisdiction: (_jurisdiction: ShardJurisdiction) => directory,
    };

    const scheduledJobs = new Map<
        string,
        {
            args: Record<string, unknown>;
            functionPath: string;
            options: ScheduleOptions;
            timer: ReturnType<typeof setTimeout>;
        }
    >();

    const scheduler: SchedulerHost = {
        cancel: async (id) => {
            const job = scheduledJobs.get(id);

            if (job === undefined) {
                return false;
            }

            clearTimeout(job.timer);
            scheduledJobs.delete(id);

            return true;
        },
        cron: async () => {
            // Reference host does not support cron execution; cron is tested by
            // asserting the contract shape, not by running timers.
        },
        schedule: async (functionPath, args, options) => {
            const id = nextJobId();
            let scheduledFor: number;

            if (options?.at === undefined) {
                scheduledFor = Date.now() + (options?.delayMs ?? 0);
            } else {
                scheduledFor = typeof options.at === "number" ? options.at : options.at.getTime();
            }

            const delay = Math.max(0, scheduledFor - Date.now());
            const timer = setTimeout(() => {
                scheduledJobs.delete(id);
            }, delay);

            scheduledJobs.set(id, { args, functionPath, options: options ?? {}, timer });

            return { id, scheduledFor };
        },
    };

    return {
        cleanup: () => {
            database.close();

            if (shardState.alarmTimeout !== null) {
                clearTimeout(shardState.alarmTimeout);
            }

            for (const job of scheduledJobs.values()) {
                clearTimeout(job.timer);
            }
        },
        directory,
        restoreSocket: (id: string, attachment: unknown) => {
            const socketState: ReferenceSocket = {
                attachment,
                closed: false,
                handle: null as unknown as SocketHandle,
                id,
                received: [],
                tags: new Set(),
            };
            runtimeSockets.set(id, socketState);

            return createHandle(socketState);
        },
        scheduler,
        shard,
        simulateRecycle: () => {
            runtimeSockets.clear();
        },
        socket,
    };
};

/**
 * A reference host exposes the public `ConformanceHost` contracts plus
 * reference-host-specific helpers for simulating recycle/rehydrate.
 */
interface ReferenceHost extends ConformanceHost {
    /** Re-create a runtime socket from its durable attachment. */
    restoreSocket: (id: string, attachment: unknown) => SocketHandle;
    /** Drop runtime socket state while keeping durable attachments. */
    simulateRecycle: () => void;
}

export { createReferenceHost };
export type { ConformanceHost, ConformanceHostFactory, ReferenceHost };
