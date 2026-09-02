import { AsyncLocalStorage } from "node:async_hooks";
// eslint-disable-next-line n/no-unsupported-features/node-builtins -- `node:sqlite` is stable on Node ^22.15 || >=24.10 and is the deliberate in-memory engine for this Node-only reference host
import { DatabaseSync } from "node:sqlite";

import type {
    ScheduledJobStatus,
    ScheduleOptions,
    SchedulerHost,
    ShardDirectory,
    ShardHost,
    ShardJurisdiction,
    ShardKvStore,
    ShardSqlExec,
    ShardStub,
    SocketHandle,
    SocketHost,
} from "../index";

/**
 * A conformance host bundles all four platform contracts so a single factory
 * can stand up a complete, isolated test environment.
 */
interface ConformanceHost {
    /**
     * Resolve once a pending alarm has actually fired. Optional: hosts whose
     * alarm delivery is owned by the platform and can't be observed from inside
     * a shard callback (Cloudflare wakes a separate `alarm()` invocation) omit
     * it, and the suite then asserts only the set/read/delete half of the alarm
     * contract — platform delivery is the platform's test, not the adapter's.
     */
    awaitAlarmFired?: (target: number) => Promise<void>;

    /**
     * Resolve once the host has actually dispatched a scheduled job — invoked
     * its delivery path, not merely expired the timer. Optional, but NOT for a
     * host that declares `scheduler.deadLetter`: that member is the
     * at-least-once claim, and a host that cannot show the TCK a dispatch is
     * claiming what the suite cannot check.
     * @returns `true` when the job was dispatched at least once.
     */
    awaitJobDispatched?: (id: string) => Promise<boolean>;
    /** Optional cleanup hook (close DBs, release timers). */
    cleanup?: () => void;

    /**
     * Mint a raw socket for {@link SocketHost.accept}. Optional: what a socket
     * actually _is_ differs per host (Cloudflare needs a live `WebSocketPair` end), and
     * the provider-neutral suite can't know. Defaults to an opaque object for
     * hosts that don't care.
     */
    createSocket?: () => unknown;

    /**
     * How many times this host has dispatched `functionPath` — the cron legs'
     * only window into a schedule that has no job row to list.
     *
     * Optional, and only a host implementing {@link SchedulerHost.cron} needs
     * it: without it the suite cannot tell a cron that ticked from one that was
     * armed and never fired, which is the difference between a working schedule
     * and a `setTimeout` that overflowed its 2^31-1 ms ceiling and fired
     * immediately. Counting by function path rather than by id because a cron
     * has no per-tick identity.
     */
    cronTicks?: (functionPath: string) => number;
    /** The shard directory under test. */
    directory: ShardDirectory;

    /**
     * Terminally dispose this host instance, as opposed to {@link
     * ConformanceHost.cleanup}, which some hosts (Cloudflare's DO-backed
     * `cleanup`) use as a per-test reset rather than a true teardown — the DO's
     * storage has no explicit close a test can drive, so `cleanup` there just
     * disarms the pending alarm and drops socket references for the next run.
     *
     * Optional: only a host with a real terminal dispose implements it. Where
     * it exists, the suite calls it once and then asserts every surface that
     * documents a post-close behaviour (`ShardHost.alarms`,
     * `SchedulerHost.schedule`, `SocketHost.accept`/`setTag`/`removeTag`) fails
     * closed with a `"platform closed: …"` error — the same "report the gap
     * instead of asserting a false close" pattern `scheduler`/`kv` already use
     * for hosts that don't implement a surface at all.
     */
    disposeTerminally?: () => void;

    /**
     * Declare that this host's concurrency boundary is the **dispatch**, not
     * the SQL executor: the runtime refuses to deliver a second event to the
     * shard while a mutation holds it, so two tasks never reach `shard.sql`
     * concurrently in the first place.
     *
     * Cloudflare is the case. `runSerialized` is `blockConcurrencyWhile`, which
     * closes the Durable Object's input gate; every other event — including
     * timer continuations — is queued behind it until the mutation settles. Two
     * consequences the TCK has to respect:
     *
     * - A read issued from inside the *same* event is not "a task outside the
     * mutation" at all. It is the mutation's own task, sharing its
     * `storage.transaction`, and it reads the uncommitted row. Measured
     * against workerd: the row comes back.
     * - A test cannot manufacture a second event either. The gate delivers
     * queued continuations in scheduling order, so an outer `await sleep(n)`
     * armed before the gate closed and due *earlier* than the mutation's own
     * timer head-of-line blocks that timer — the closure never settles, the
     * gate never opens, and the object deadlocks until the test times out.
     *
     * So on such a host the isolation leg asserts the half the adapter owns
     * (nothing uncommitted survives the rollback) and reports the observation
     * half as a gap, the same way {@link ConformanceHost.awaitAlarmFired}'s
     * absence reports platform-owned alarm delivery. Enforcing the gate is
     * workerd's test, not the adapter's.
     */
    isolatesByDispatch?: true;

    /**
     * The durable key-value store under test. Optional: a host that implements
     * only the reactive-engine half (`ShardHost`) has no KV surface to offer,
     * and the suite reports the gap rather than asserting against a stub.
     */
    kv?: ShardKvStore;

    /**
     * Read back the frames a socket has been sent, oldest first.
     *
     * Optional, because not every host can observe its own outbound traffic —
     * but a host that omits it cannot be asserted against for any *delivery*
     * guarantee, only for "send did not throw". Since delivery is most of what
     * the engine does (pokes, deltas, whispers), a host without this is only
     * partially proven, and the suites say so rather than skipping quietly.
     */
    readFrames?: (socket: SocketHandle) => string[];

    /**
     * Re-create a runtime socket from its durable state. Optional: only hosts
     * that can be driven through a recycle from inside a test implement it
     * (see {@link ConformanceHost.simulateRecycle}).
     */
    restoreSocket?: (id: string, attachment: unknown) => SocketHandle;

    /**
     * The scheduler host under test. Optional: a package that implements only
     * the shard/socket half of the platform (`@lunora/do`) has no scheduler to
     * offer, and the suite reports the gap instead of asserting against a stub.
     * A full composition root must supply one.
     */
    scheduler?: SchedulerHost;
    /** The shard execution slot under test. */
    shard: ShardHost;

    /**
     * Drive a pending job to its dead-letter state — however this host gets
     * there — so the suite can assert what a parked job looks like without
     * waiting out a real retry budget.
     *
     * Optional, and the same shape as {@link ConformanceHost.simulateRecycle}:
     * a host that cannot force the transition from inside a test omits it and
     * the suite reports the gap. It exists because the observable *invariants*
     * of dead-lettering — disjoint listings, requeue semantics — are
     * contract-level, while how many failures it takes to get there is host
     * policy the contract deliberately does not fix.
     * @returns `true` if the job was pending and is now parked.
     */
    simulateDeadLetter?: (id: string) => Promise<boolean>;

    /**
     * Drop runtime socket state while keeping durable state, so the suite can
     * assert attachments survive. Optional: a host whose recycle is owned by
     * the platform (Cloudflare hibernation) cannot trigger one on demand, and
     * the suite skips the recycle leg rather than faking it.
     */
    simulateRecycle?: () => void;
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
    /** Bytes "queued" — the reference host flushes instantly, so always 0. */
    bufferedAmount: number;
    closed: boolean;
    handle: SocketHandle;
    id: string;
    /** The raw socket object handed to `accept`, for `handleFor` lookups. */
    raw: unknown;
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

    /**
     * Terminal-teardown state for {@link ConformanceHost.disposeTerminally}.
     * The reference implementation has to satisfy the same fail-closed contract
     * the suite asserts of real hosts, or that leg would only ever be exercised
     * downstream in `platform-node` and the reference host would sit as the one
     * implementation nothing checks.
     */
    let closed = false;

    const assertOpen = (action: string): void => {
        if (closed) {
            throw new Error(`platform closed: cannot ${action}`);
        }
    };

    const shardState: ReferenceShardState = {
        alarmAt: null,
        alarmTimeout: null,
        pending: [],
        running: false,
    };

    // Socket state is split into "runtime" (in-memory handles) and "durable"
    // (serialized attachments plus fan-out tags). Tests call `simulateRecycle()`
    // to clear runtime state, then `restoreSocket()` to rehydrate from the
    // durable side — tags come back with the socket, exactly as they do on a
    // host that persists them alongside the connection.
    const runtimeSockets = new Map<string, ReferenceSocket>();
    const durableAttachments = new Map<string, unknown>();
    const durableTags = new Map<string, Set<string>>();

    /**
     * Whether the caller owns the transaction currently open on this host —
     * how a gateless host keeps guarantee 2 of the {@link ShardHost} contract
     * ("no partial writes are observable") — the full reasoning is there.
     *
     * The refusal is coded `SHARD_UNAVAILABLE`/503, not a bare `Error`: the
     * refused read failed only because it arrived while a mutation was
     * mid-await, and the very next attempt will not, so it has to reach the
     * caller as something retryable. An uncatalogued throw is redacted to an
     * `INTERNAL` 500 by every transport edge (`toErrorBody`), which no client
     * retries. `@lunora/platform` carries no dependencies, so the shape
     * `isLunoraError` recognizes — string `code`, numeric `status`, the
     * `VisulimaError` brand — is set here by hand rather than imported from
     * `@lunora/errors`; `@lunora/platform-node` throws the real class.
     */
    const transactionScope = new AsyncLocalStorage<true>();
    let transactionOpen = false;

    const assertOwnTurn = (): void => {
        if (transactionOpen && transactionScope.getStore() !== true) {
            throw Object.assign(new Error("shard busy: cannot run SQL while another task holds this shard's transaction"), {
                code: "SHARD_UNAVAILABLE",
                status: 503,
                type: "VisulimaError",
            });
        }
    };

    const sql: ShardSqlExec = {
        exec: (query, ...bindings) => {
            assertOwnTurn();

            const statement = database.prepare(query);
            const normalized = bindings.map(normalizeBinding) as import("node:sqlite").SQLInputValue[];
            const trimmed = query.trim().toLowerCase();

            // Reads buffer their rows; writes produce none. Either way the
            // caller gets the same cursor shape — iterable, `toArray`, `one` —
            // because the contract requires all three of every host.
            //
            // `PRAGMA` counts as a read. An introspecting pragma (`table_info`,
            // `index_list`) returns rows exactly like a SELECT, and the engine's
            // idempotent migrations depend on that: they pragma-check for a column
            // before `ALTER TABLE … ADD COLUMN`, so a host that answers the pragma
            // with an empty cursor reports "column missing" for a column that is
            // there and fails the ALTER with "duplicate column name". A
            // setter-pragma (`PRAGMA foreign_keys = ON`) returns no rows, and
            // `.all()` on it is harmless — so one branch covers both forms.
            const rows =
                trimmed.startsWith("select") || trimmed.startsWith("pragma")
                    ? statement.all(...normalized)
                    : ((): unknown[] => {
                          statement.run(...normalized);

                          return [];
                      })();

            return {
                [Symbol.iterator]: () => rows[Symbol.iterator](),
                one: () => {
                    if (rows.length !== 1) {
                        throw new Error(`expected exactly one row, got ${String(rows.length)}`);
                    }

                    return rows[0];
                },
                toArray: () => [...rows],
            } as never;
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

    // A second, private tail chain of the same shape as `runSerialized`'s
    // `shardState.pending`/`drainQueue`, used ONLY by `transaction`. Raw
    // BEGIN/COMMIT/ROLLBACK on a shared connection is not safe under overlap:
    // a second `transaction()` call that starts before the first commits
    // either throws on the second BEGIN, or its COMMIT commits the first's
    // uncommitted writes and the first's ROLLBACK then discards work that
    // already reported success. Routing `transaction` through the same
    // `runSerialized` queue would deadlock (the engine composes
    // `runSerialized(() => transaction(work))`), so this is a dedicated lane
    // — see `@lunora/platform-node`'s `node-shard-host.ts`, which has the
    // identical shape and the identical reasoning (plan 267).
    let transactionTail: Promise<unknown> = Promise.resolve();

    const runTransaction = async <T>(function_: () => Promise<T>): Promise<T> => {
        database.exec("BEGIN");
        transactionOpen = true;

        try {
            const result = await transactionScope.run(true, function_);

            database.exec("COMMIT");
            transactionOpen = false;

            return result;
        } catch (error) {
            transactionOpen = false;

            try {
                database.exec("ROLLBACK");
            } catch {
                // A failed rollback (a handle closed mid-transaction by a teardown
                // racing an in-flight mutation, or inner work that already ended
                // the transaction) must not mask the original throw — the caller
                // needs the real failure, not the cleanup's. `@lunora/testing`'s
                // harness copy of this guards it; the two host copies did not.
            }

            throw error;
        }
    };

    const transaction: ShardHost["transaction"] = <T>(function_: () => Promise<T>): Promise<T> => {
        const started = transactionTail.then(
            () => runTransaction(function_),
            () => runTransaction(function_),
        );

        transactionTail = started.then(
            () => undefined,
            () => undefined,
        );

        return started;
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
            assertOpen("delete an alarm");
            shardState.alarmAt = null;
            if (shardState.alarmTimeout !== null) {
                clearTimeout(shardState.alarmTimeout);
                shardState.alarmTimeout = null;
            }
        },
        // No `assertOpen`: a read has an honest post-close answer, and the suite's
        // terminal-disposal leg does not assert one — see its comment there.
        get: () => shardState.alarmAt,
        set: (ms) => {
            assertOpen("set an alarm");
            setAlarm(ms);
        },
    };

    const shard: ShardHost = {
        alarms,
        runSerialized,
        sql,
        transaction,
        waitUntil: () => {
            // The reference host does not distinguish request/background
            // lifetimes; fire-and-forget work is left to the caller.
        },
    };

    /** `SocketHandle` -> stable id, the reference host's answer for `idFor`. */
    const handleIds = new WeakMap<SocketHandle, string>();

    const createHandle = (socket: ReferenceSocket): SocketHandle => {
        const handle: SocketHandle = {
            bufferedAmount: socket.bufferedAmount,
            close: (_code, _reason) => {
                socket.closed = true;
            },
            deserializeAttachment: () => socket.attachment,
            send: (data) => {
                // Keep text as text. `received` has always been typed
                // `(string | ArrayBuffer)[]`, but encoding unconditionally made
                // the string arm unreachable — which went unnoticed for as long
                // as nothing read the buffer back. `readFrames` reads it now.
                socket.received.push(typeof data === "string" ? data : extractArrayBuffer(data));
            },
            serializeAttachment: (value) => {
                socket.attachment = value;
                durableAttachments.set(socket.id, value);
            },
        };
        socket.handle = handle;
        // Identity out-of-band, exactly as `SocketHost.idFor` requires. The
        // reference host could trivially keep an `id` property here, but then it
        // would not be exercising the contract a real host has to satisfy.
        handleIds.set(handle, socket.id);

        return handle;
    };

    const socket: SocketHost = {
        accept: (rawSocket, attachment, tags) => {
            assertOpen("accept a socket");

            const id = nextSocketId();
            const socketState: ReferenceSocket = {
                attachment,
                bufferedAmount: 0,
                closed: false,
                raw: rawSocket,
                handle: null as unknown as SocketHandle,
                id,
                received: [],
                tags: new Set(tags),
            };
            runtimeSockets.set(id, socketState);
            durableTags.set(id, new Set(tags));

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
        handleFor: (rawSocket) => [...runtimeSockets.values()].find((s) => s.raw === rawSocket)?.handle,
        idFor: (handle) => {
            const id = handleIds.get(handle);

            if (id === undefined) {
                // Loudly, not `?? ""`: the suite now compares tag fan-out BY ID, so
                // a host whose registration silently missed would return [""] vs
                // [""] and pass a crossed-tag check it should fail.
                throw new Error("reference host: idFor called with a handle this host never issued");
            }

            return id;
        },
        removeTag: (handle, tag) => {
            assertOpen("remove a socket tag");

            const id = handleIds.get(handle) ?? "";
            const socketState = runtimeSockets.get(id);

            if (socketState === undefined) {
                return;
            }

            if (tag === undefined) {
                socketState.tags.clear();
            } else {
                socketState.tags.delete(tag);
            }

            durableTags.set(id, new Set(socketState.tags));
        },
        setTag: (handle, tag) => {
            assertOpen("set a socket tag");

            const id = handleIds.get(handle) ?? "";
            const socketState = runtimeSockets.get(id);

            if (socketState !== undefined) {
                socketState.tags.add(tag);
                durableTags.set(id, new Set(socketState.tags));
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

    // Durable key-value store, kept in a plain Map. Structured-clone the value
    // on write so a caller mutating the object it stored cannot reach back into
    // the "durable" copy — the same isolation a real serializing store gives.
    const kvData = new Map<string, unknown>();
    const kv: ShardKvStore = {
        delete: async (key) => kvData.delete(key),
        get: async (key) => kvData.get(key) as never,
        list: async (options) => {
            const prefix = options?.prefix ?? "";
            const result = new Map<string, unknown>();

            for (const [key, value] of kvData) {
                if (key.startsWith(prefix)) {
                    result.set(key, value);
                }
            }

            return result as never;
        },
        put: async (key, value) => {
            kvData.set(key, structuredClone(value));
        },
    };

    type ReferenceJob = {
        args: Record<string, unknown>;
        attempts: number;
        functionPath: string;
        options: ScheduleOptions;
        scheduledFor: number;
        timer: ReturnType<typeof setTimeout> | undefined;
    };

    const scheduledJobs = new Map<string, ReferenceJob>();

    /**
     * Jobs that exhausted their retry budget. Held in a separate map, never in
     * both — the contract requires the two listings to be disjoint, so modelling
     * them as one map with a flag would make the invariant a convention rather
     * than a fact.
     */
    const deadJobs = new Map<string, ReferenceJob>();

    /**
     * Ids the scheduler timer has actually fired for — the difference between
     * "expired" and "dispatched" that `awaitJobDispatched` exists to make
     * checkable. This host declares `scheduler.deadLetter` (the at-least-once
     * claim), so it must hold this half of the claim rather than merely
     * clearing bookkeeping like the pre-267 Node host did.
     */
    const dispatchedJobs = new Set<string>();

    const toStatus = (id: string, job: ReferenceJob): ScheduledJobStatus => {
        return {
            attempts: job.attempts,
            functionPath: job.functionPath,
            id,
            scheduledFor: job.scheduledFor,
        };
    };

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
        deadLetter: {
            list: async () => [...deadJobs].map(([id, job]) => toStatus(id, job)),
            requeue: async (id) => {
                const job = deadJobs.get(id);

                if (job === undefined) {
                    return false;
                }

                deadJobs.delete(id);
                // A fresh budget is the point of a requeue: returning it with
                // its exhausted count parks it again on the next failure without
                // ever retrying.
                scheduledJobs.set(id, { ...job, attempts: 0, timer: undefined });

                return true;
            },
        },
        list: async () => [...scheduledJobs].map(([id, job]) => toStatus(id, job)),
        schedule: async (functionPath, args, options) => {
            assertOpen("schedule a job");

            const id = nextJobId();
            let scheduledFor: number;

            if (options?.at === undefined) {
                scheduledFor = Date.now() + (options?.delayMs ?? 0);
            } else {
                scheduledFor = typeof options.at === "number" ? options.at : options.at.getTime();
            }

            const delay = Math.max(0, scheduledFor - Date.now());
            const timer = setTimeout(() => {
                // Dispatch, not just expiry: record the job as actually fired
                // (bump its attempt count to 1, the same field a real retry
                // loop would advance) before dropping it from the pending set.
                const job = scheduledJobs.get(id);

                if (job !== undefined) {
                    job.attempts += 1;
                }

                dispatchedJobs.add(id);
                scheduledJobs.delete(id);
            }, delay);

            scheduledJobs.set(id, { args, attempts: 0, functionPath, options: options ?? {}, scheduledFor, timer });

            return { id, scheduledFor };
        },
    };

    /**
     * Idempotent: the suite calls `disposeTerminally()` inside a test and
     * `cleanup()` in the `finally` that follows, so a second `database.close()`
     * would throw over whatever the test was actually asserting.
     */
    const teardown = (): void => {
        if (closed) {
            return;
        }

        closed = true;
        database.close();

        if (shardState.alarmTimeout !== null) {
            clearTimeout(shardState.alarmTimeout);
        }

        for (const job of scheduledJobs.values()) {
            clearTimeout(job.timer);
        }
    };

    return {
        awaitAlarmFired: async (target) => {
            // The reference host clears `alarmAt` from a real timer, so waiting
            // past the target (plus a small margin) is enough to observe it.
            await new Promise((resolve) => {
                setTimeout(resolve, Math.max(0, target - Date.now()) + 30);
            });
        },
        awaitJobDispatched: async (id) => {
            // Same wait-past-target strategy as `awaitAlarmFired`: look up the
            // job's own `scheduledFor` while it is still pending and wait
            // slightly past it. If it already fired (or never existed),
            // there is nothing to wait for — answer from `dispatchedJobs`
            // directly.
            const pendingJob = scheduledJobs.get(id);

            if (pendingJob !== undefined) {
                await new Promise((resolve) => {
                    setTimeout(resolve, Math.max(0, pendingJob.scheduledFor - Date.now()) + 30);
                });
            }

            return dispatchedJobs.has(id);
        },
        cleanup: teardown,
        directory,
        disposeTerminally: teardown,
        kv,
        // Text frames only: every Lunora wire frame is JSON, and returning
        // binary as a lossy string would let a corrupted frame read as a
        // delivered one.
        readFrames: (handle: SocketHandle) =>
            (runtimeSockets.get(handleIds.get(handle) ?? "")?.received ?? []).filter((frame): frame is string => typeof frame === "string"),
        restoreSocket: (id: string, attachment: unknown) => {
            const socketState: ReferenceSocket = {
                attachment,
                bufferedAmount: 0,
                closed: false,
                handle: null as unknown as SocketHandle,
                id,
                raw: undefined,
                received: [],
                tags: new Set(durableTags.get(id)),
            };
            runtimeSockets.set(id, socketState);

            return createHandle(socketState);
        },
        scheduler,
        simulateDeadLetter: async (id: string) => {
            const job = scheduledJobs.get(id);

            if (job === undefined) {
                return false;
            }

            clearTimeout(job.timer);
            scheduledJobs.delete(id);
            deadJobs.set(id, { ...job, attempts: (job.options.retry?.maxAttempts ?? 5) + 1, timer: undefined });

            return true;
        },
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
    /** Re-create a runtime socket from its durable attachment and tags. */
    restoreSocket: (id: string, attachment: unknown) => SocketHandle;
    /** Drop runtime socket state while keeping durable attachments and tags. */
    simulateRecycle: () => void;
}

export { createReferenceHost };
export type { ConformanceHost, ConformanceHostFactory, ReferenceHost };
