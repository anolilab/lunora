/**
 * Cloudflare adapter: turn a `DurableObjectState` into the provider-neutral
 * `@lunora/platform` host contracts (`ShardHost`, `SocketHost`).
 *
 * This lets `@lunora/do`'s `ShardDO` consume the same host-neutral engine
 * (`@lunora/shard-engine`) that other platforms will mount. The adapter is
 * intentionally thin: it forwards to Cloudflare's DO primitives and keeps any
 * state in the runtime-provided objects.
 *
 * It is also defensive about which primitives exist. `ShardDO`'s unit suite
 * drives the class with plain-object `DurableObjectState` doubles that carry
 * only `storage.sql`, `acceptWebSocket`, and `getWebSockets`; production
 * workerd carries the full surface. Every optional primitive is probed at call
 * time and degrades to the same behavior the DO had before the seam existed.
 */

import type { DurableObjectNamespace, DurableObjectState, DurableObjectStub, WebSocket } from "@cloudflare/workers-types";
import type {
    ShardAlarms,
    ShardDirectory,
    ShardHost,
    ShardJurisdiction,
    ShardKvStore,
    ShardSqlExec,
    ShardStub,
    SocketHandle,
    SocketHost,
} from "@lunora/platform";

/**
 * Raw cursor returned by Cloudflare's `SqlStorage.exec` — already iterable with
 * `one()` and `toArray()`, which is exactly the contract's cursor, so the
 * adapter passes it straight through rather than re-wrapping.
 */
type SqlStorageCursor = Iterable<Record<string, unknown>> & {
    readonly one: () => Record<string, unknown>;
    readonly toArray: () => Record<string, unknown>[];
};

/**
 * Resolve `state.storage.sql.exec` at call time rather than at construction:
 * the adapter is built in the `ShardDO` constructor, before a test double is
 * necessarily complete, and a missing handle must surface as a failing SQL
 * call rather than a failing constructor.
 */
const execSql = (state: DurableObjectState, query: string, bindings: ReadonlyArray<unknown>): SqlStorageCursor => {
    const sql = state.storage.sql as undefined | { exec?: (query: string, ...bindings: unknown[]) => SqlStorageCursor };

    if (typeof sql?.exec !== "function") {
        throw new TypeError("storage.sql.exec is not available on this DurableObjectState");
    }

    return sql.exec(query, ...bindings);
};

/** The alarm subset of `state.storage`, structurally (shared by shard + session hosts). */
interface AlarmStorageLike {
    deleteAlarm?: () => Promise<void>;
    getAlarm?: () => Promise<number | null>;
    setAlarm?: (scheduledTime: number | Date) => Promise<void>;
}

/**
 * Turn a DO's `state.storage` alarm surface into {@link ShardAlarms}. Each
 * primitive is probed at call time so a test double lacking the alarm API
 * degrades to a no-op (and a missing alarm reads as `null`) rather than
 * throwing — the pre-contract behavior on those doubles.
 */
const createShardAlarms = (storage: AlarmStorageLike): ShardAlarms => {
    return {
        delete: () => {
            if (typeof storage.deleteAlarm === "function") {
                return storage.deleteAlarm();
            }

            return Promise.resolve();
        },
        get: () => {
            if (typeof storage.getAlarm === "function") {
                return storage.getAlarm();
            }

            // The contract explicitly returns `number | null` for a missing alarm.
            // eslint-disable-next-line unicorn/no-null -- platform contract uses null
            return null;
        },
        set: (timestamp) => {
            if (typeof storage.setAlarm === "function") {
                return storage.setAlarm(timestamp);
            }

            return Promise.resolve();
        },
    };
};

const createShardHost = (state: DurableObjectState): ShardHost => {
    const { storage } = state;

    const sql: ShardSqlExec = {
        // A live getter: workerd recomputes the size on each read, so caching it
        // here would report a stale number for the life of the shard.
        get databaseSize(): number | undefined {
            return (state.storage.sql as undefined | { databaseSize?: number })?.databaseSize;
        },
        exec: (query, ...bindings) => execSql(state, query, bindings) as never,
    };

    const alarms = createShardAlarms(storage);

    /**
     * Single-writer gate. `blockConcurrencyWhile` delays the next dispatch
     * until the closure settles, which is exactly the contract's
     * "no two closures run at once for this shard key".
     */
    const runSerialized: ShardHost["runSerialized"] = async (function_) => {
        if (typeof state.blockConcurrencyWhile === "function") {
            return state.blockConcurrencyWhile(function_);
        }

        // Test doubles may not supply the gate. Running bare keeps them working;
        // production state always carries it.
        return function_();
    };

    /**
     * Durable transaction. workerd FORBIDS raw `BEGIN`/`COMMIT`/`SAVEPOINT` SQL
     * inside a Durable Object — issuing them throws and fails the mutation — so
     * there is deliberately no raw-SQL fallback here. `storage.transaction` is
     * the platform primitive: atomic, auto-rolling-back when the closure throws.
     * Doubles whose storage lacks it fall through to a bare call; their fakes
     * carry no transactional semantics to preserve anyway.
     */
    const transaction: ShardHost["transaction"] = async (function_) => {
        const transactional = storage as undefined | { transaction?: <R>(closure: () => Promise<R>) => Promise<R> };

        if (typeof transactional?.transaction === "function") {
            return transactional.transaction(async () => function_());
        }

        return function_();
    };

    return {
        alarms,
        runSerialized,
        // `state.id.name` is populated only for objects addressed by name
        // (`idFromName`); a `newUniqueId()` object has none, which is exactly
        // the `undefined` the contract allows.
        shardKey: (state as { id?: { name?: string } }).id?.name,
        sql,
        transaction,
        waitUntil:
            typeof state.waitUntil === "function"
                ? (promise) => {
                      state.waitUntil(promise);
                  }
                : undefined,
    };
};

/**
 * The `state.storage` key-value surface, structurally. Declared here rather
 * than taking a full `DurableObjectState` so the adapter also accepts the
 * plain-object doubles `SessionDO`'s unit tests pass — they carry exactly this
 * shape and nothing else.
 */
interface KvStorageLike {
    delete: (key: string) => Promise<boolean | number>;
    get: <T = unknown>(key: string) => Promise<T | undefined>;
    list?: <T = unknown>(options?: { prefix?: string }) => Promise<Map<string, T>>;
    put: (key: string, value: unknown) => Promise<void>;
}

/**
 * Turn a Durable Object's `state.storage` into the provider-neutral
 * {@link ShardKvStore}. The DO's KV surface already matches the contract
 * method-for-method; this adapter only normalizes the return of `delete`
 * (workerd resolves a boolean, some doubles a number) and fails closed on a
 * `list` the underlying storage does not provide.
 */
const createShardKvStore = (storage: KvStorageLike): ShardKvStore => {
    return {
        delete: async (key) => Boolean(await storage.delete(key)),
        get: (key) => storage.get(key),
        list: (options) => {
            if (typeof storage.list !== "function") {
                throw new TypeError("storage.list is not available on this DurableObjectStorage");
            }

            return storage.list(options);
        },
        put: (key, value) => storage.put(key, value),
    };
};

/**
 * Tag prefix carrying a socket's stable identity.
 *
 * Cloudflare has no built-in socket identifier that survives hibernation, but
 * it does persist the tags passed to `acceptWebSocket`. Minting an id tag at
 * accept therefore buys the `SocketHandle.id` stability the contract requires:
 * after a recycle, `state.getTags(ws)` hands the same id back.
 */
const ID_TAG_PREFIX = "lunora-socket:";

/** Fallback ids for doubles without `getTags`, stable only within one wake. */
const fallbackIds = new WeakMap<WebSocket, string>();

let fallbackCounter = 0;

const readSocketId = (state: DurableObjectState, ws: WebSocket): string => {
    const { getTags } = state as { getTags?: (ws: WebSocket) => string[] };

    if (typeof getTags === "function") {
        const idTag = getTags.call(state, ws).find((tag) => tag.startsWith(ID_TAG_PREFIX));

        if (idTag !== undefined) {
            return idTag.slice(ID_TAG_PREFIX.length);
        }
    }

    const existing = fallbackIds.get(ws);

    if (existing !== undefined) {
        return existing;
    }

    fallbackCounter += 1;
    const id = `cf-socket-${String(fallbackCounter)}`;
    fallbackIds.set(ws, id);

    return id;
};

/**
 * A `SocketHandle` backed by a Cloudflare hibernatable `WebSocket`.
 *
 * Attachments are read/written through the WebSocket's own
 * `serializeAttachment` / `deserializeAttachment` methods, which the runtime
 * persists across hibernation.
 */
class CloudflareSocketHandle implements SocketHandle {
    public readonly id: string;

    private readonly ws: WebSocket;

    /** Live outbound queue depth, read through to the runtime socket. */
    public get bufferedAmount(): number | undefined {
        const { bufferedAmount } = this.ws as { bufferedAmount?: unknown };

        return typeof bufferedAmount === "number" ? bufferedAmount : undefined;
    }

    public constructor(ws: WebSocket, id: string) {
        this.ws = ws;
        this.id = id;
    }

    public close(code?: number, reason?: string): void {
        this.ws.close(code, reason);
    }

    public deserializeAttachment(): unknown {
        return (this.ws as { deserializeAttachment?: () => unknown }).deserializeAttachment?.();
    }

    public send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        this.ws.send(data as ArrayBuffer | string);
    }

    public serializeAttachment(value: unknown): void {
        (this.ws as { serializeAttachment?: (value: unknown) => void }).serializeAttachment?.(value);
    }
}

/**
 * Build the socket host for a DO.
 *
 * Note what is deliberately absent: `setTag` / `removeTag`. Cloudflare freezes
 * a socket's tags at `acceptWebSocket`, so declaring mutable tagging would be a
 * lie the engine could route on. Per the `SocketHost` contract, omitting both
 * tells callers to re-accept instead.
 */
const createSocketHost = (state: DurableObjectState): SocketHost => {
    /** Handle cache so one WebSocket maps to one handle within a wake. */
    const liveHandles = new WeakMap<WebSocket, CloudflareSocketHandle>();

    const getHandle = (ws: WebSocket): CloudflareSocketHandle => {
        const existing = liveHandles.get(ws);

        if (existing !== undefined) {
            return existing;
        }

        const handle = new CloudflareSocketHandle(ws, readSocketId(state, ws));
        liveHandles.set(ws, handle);

        return handle;
    };

    return {
        accept: (socket, attachment, tags) => {
            const ws = socket as WebSocket;
            const id = crypto.randomUUID();

            // Accept first, then stamp: the runtime only tracks attachments for
            // sockets it has accepted, and the two calls are adjacent and
            // synchronous so no frame can arrive against an unstamped socket.
            state.acceptWebSocket(ws, [`${ID_TAG_PREFIX}${id}`, ...(tags ?? [])]);
            fallbackIds.set(ws, id);

            const handle = new CloudflareSocketHandle(ws, id);
            liveHandles.set(ws, handle);

            if (attachment !== undefined) {
                handle.serializeAttachment(attachment);
            }

            return handle;
        },
        // `state.getWebSockets(tag)` filters natively and exactly, which is the
        // contract's requirement — a superset would fan updates out across
        // subscriptions that never asked for them.
        getSockets: (tag) => state.getWebSockets(tag).map((ws) => getHandle(ws)),
        handleFor: (socket) => {
            const ws = socket as WebSocket;

            // A socket the runtime hands to `webSocketMessage`/`webSocketClose`
            // may predate this wake, so there may be no cached handle: rebuild
            // it from the durable id tag. `readSocketId` only falls back to a
            // wake-local id when the runtime has no tags at all (test doubles),
            // and an unaccepted socket has none either way.
            return liveHandles.get(ws) ?? (state.getWebSockets().includes(ws) ? getHandle(ws) : undefined);
        },
    };
};

/**
 * Turn a Durable Object namespace binding into a {@link ShardDirectory}.
 *
 * Cloudflare populates the whole direct branch: `idFromName` is the
 * deterministic placement function, `get` materializes the stub, and
 * `jurisdiction` narrows placement for data-residency regimes. A jurisdiction
 * the runtime doesn't recognize throws rather than silently placing the shard
 * anywhere — the contract requires callers to fail closed.
 */
const createShardDirectory = (namespace: DurableObjectNamespace): ShardDirectory => {
    /**
     * `DurableObjectStub.fetch` is declared over workers-types' own `Request` /
     * `RequestInfo`, while the zero-dependency `ShardStub` is declared over the
     * ambient `Request`. The two are the same object at runtime — this Worker
     * has exactly one `Request` — but TypeScript sees two nominally distinct
     * declarations, so the bridge is cast here, once, at the adapter boundary
     * rather than pushed onto every caller.
     */
    const toStub = (stub: DurableObjectStub): ShardStub => {
        return {
            fetch: (request) => stub.fetch(request as unknown as Parameters<DurableObjectStub["fetch"]>[0]) as unknown as Promise<Response>,
        };
    };

    const directory: ShardDirectory = {
        get: (id) => toStub(namespace.get(id as ReturnType<DurableObjectNamespace["idFromName"]>)),
        getByName: (name) => toStub(namespace.get(namespace.idFromName(name))),
        idForName: (name) => namespace.idFromName(name),
        jurisdiction: (jurisdiction: ShardJurisdiction) =>
            createShardDirectory(namespace.jurisdiction(jurisdiction as Parameters<DurableObjectNamespace["jurisdiction"]>[0])),
    };

    return directory;
};

export { createShardAlarms, createShardDirectory, createShardHost, createShardKvStore, createSocketHost };
export type { SqlStorageCursor };
