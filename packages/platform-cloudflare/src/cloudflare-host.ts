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
import { LunoraError } from "@lunora/errors";
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

/**
 * Record `platformError` as the cause of the error a closure threw, when both
 * failed.
 *
 * Best-effort by construction: the write can itself throw, because a frozen or
 * sealed error — a module-level `Object.freeze(new Error(…))` sentinel is a real
 * pattern — rejects it with a `TypeError`. Unguarded, that `TypeError` would
 * replace the error the handler threw, which is the exact loss the caller of
 * this helper exists to prevent. Attaching a cause is a courtesy; delivering the
 * handler's own error is the contract, so the courtesy loses.
 */
const attachCause = (thrown: unknown, platformError: unknown): void => {
    // `thrown === platformError` would make the error its own cause.
    if (!(thrown instanceof Error) || thrown === platformError || thrown.cause !== undefined) {
        return;
    }

    try {
        // `defineProperty` rather than assignment: it states the intent (add an
        // own property to this instance) and keeps the lint rule about mutating
        // a parameter honest, since the mutation is the whole point here.
        Object.defineProperty(thrown, "cause", { configurable: true, value: platformError, writable: true });
    } catch {
        // Non-writable `cause`; drop the platform error rather than mask the closure's.
    }
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
     *
     * workerd treats a *rejecting* `blockConcurrencyWhile` closure as
     * unrecoverable: it aborts the Durable Object — discarding in-memory state
     * and every hibernating WebSocket subscription on it — and flattens the
     * error to a plain `Error`. That is the right default for the
     * initialization work the API was designed for, and the wrong one for a
     * gate wrapping every mutation, where a rejection is an ordinary
     * application error and the transaction inside has already rolled the
     * writes back. So the closure settles to an outcome here and is re-raised
     * outside the gate, which the contract requires
     * ({@link ShardHost.runSerialized}). The gate is still held for the whole
     * closure — it resolves instead of rejecting.
     */
    const runSerialized: ShardHost["runSerialized"] = async (function_) => {
        if (typeof state.blockConcurrencyWhile === "function") {
            // `as const` on the discriminant lets `T` infer through, so the
            // success value needs no cast on the way out.
            const settled = await state.blockConcurrencyWhile(async () => {
                try {
                    return { ok: true as const, value: await function_() };
                } catch (error) {
                    return { error, ok: false as const };
                }
            });

            if (!settled.ok) {
                throw settled.error;
            }

            return settled.value;
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
     *
     * workerd rolls back correctly but propagates a FLATTENED copy of the
     * closure's error: a plain `Error` whose message is the original's
     * `name: message`, carrying none of its own properties. `isLunoraError` is
     * structural (`type`/`code`/`status`), so a copy is indistinguishable from
     * an unrecognized throw and is redacted to an internal fault. The original
     * instance is therefore saved on the way past and re-raised, which the
     * contract requires ({@link ShardHost.transaction}). Rollback ordering is
     * unchanged: the closure still throws into `storage.transaction` first.
     */
    const transaction: ShardHost["transaction"] = async (function_) => {
        const transactional = storage as undefined | { transaction?: <R>(closure: () => Promise<R>) => Promise<R> };

        if (typeof transactional?.transaction === "function") {
            // Boxed so a closure that legitimately throws `undefined` is still
            // distinguishable from "the closure never threw".
            let thrown: { value: unknown } | undefined;

            try {
                return await transactional.transaction(async () => {
                    try {
                        return await function_();
                    } catch (error) {
                        thrown = { value: error };

                        throw error;
                    }
                });
            } catch (error) {
                // `thrown` unset means the platform itself failed the commit or
                // rollback — genuinely its error, surfaced unchanged.
                if (!thrown) {
                    throw error;
                }

                // Both failed. The handler's error is the one the caller acted
                // on, so it stays the thrown value; the platform's rides along.
                attachCause(thrown.value, error);

                throw thrown.value;
            }
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
 * accept therefore buys the `SocketHost.idFor` stability the contract requires:
 * after a recycle, `state.getTags(ws)` hands the same id back.
 */
const ID_TAG_PREFIX = "lunora-socket:";

/** Fallback ids for doubles without `getTags`, stable only within one wake. */
const fallbackIds = new WeakMap<WebSocket, string>();

/**
 * Read-only fallback ids for a socket this host never accepted (or a double
 * with no `getTags`, once `fallbackIds` has already been checked).
 *
 * A separate map from `fallbackIds` on purpose: `fallbackIds` is ownership
 * evidence written only by `accept`, and `handleFor` trusts membership in it
 * to mean "ours". `idFor` must answer *some* caller holding a socket this
 * host never saw (a whisper sender in another pool, a relay-tier peer) — the
 * contract requires a stable answer, not a thrown error, per `SocketHost.idFor`
 * — but that answer must never be able to promote the socket into `fallbackIds`
 * and launder it into ownership. Keeping the two maps distinct is what makes
 * that impossible: this one is consulted only by `idFor`, never by `handleFor`.
 */
const readOnlyIds = new WeakMap<WebSocket, string>();

let fallbackCounter = 0;

/**
 * The socket's accept-time id tag, or `undefined` when it carries none (or the
 * state has no `getTags`). Guarded because `getTags` rejects a socket the
 * runtime does not know, and both callers (`handleFor`'s ownership test and
 * `idFor`) are contract surface documented not to throw at such a socket.
 */
const idTagOf = (state: DurableObjectState, ws: WebSocket): string | undefined => {
    const { getTags } = state as { getTags?: (ws: WebSocket) => string[] };

    if (typeof getTags !== "function") {
        return undefined;
    }

    try {
        return getTags.call(state, ws).find((tag) => tag.startsWith(ID_TAG_PREFIX));
    } catch {
        // An unaccepted socket: not ours.
        return undefined;
    }
};

const readSocketId = (state: DurableObjectState, ws: WebSocket): string => {
    const idTag = idTagOf(state, ws);

    if (idTag !== undefined) {
        return idTag.slice(ID_TAG_PREFIX.length);
    }

    const existing = fallbackIds.get(ws);

    if (existing !== undefined) {
        return existing;
    }

    // A socket with no id tag and no fallback-id entry: either a test double
    // with no `getTags` and no accept-time record, or a socket this host never
    // accepted at all. `idFor` still has to answer, and it has to answer the
    // SAME string every time for the SAME socket object — a fresh mint per call
    // was the bug (PLATCF-01): three different callers holding the same
    // unowned socket would get three different "ids" for what the engine has
    // to treat as one identity. Cache into `readOnlyIds` — NOT `fallbackIds`,
    // see that map's docstring for why the two must stay separate.
    const cached = readOnlyIds.get(ws);

    if (cached !== undefined) {
        return cached;
    }

    fallbackCounter += 1;

    const minted = `cf-socket-${String(fallbackCounter)}`;

    readOnlyIds.set(ws, minted);

    return minted;
};

/**
 * Cloudflare's `acceptWebSocket` tag budget: at most 10 tags per socket, each
 * at most 256 characters, for the socket's whole lifetime (tags are frozen at
 * accept — there is no per-call vs. per-lifetime distinction because there is
 * only ever one accept call per socket). Verified against
 * https://developers.cloudflare.com/durable-objects/api/state/ (2026-08-01);
 * update these two constants and the comment's date if that page's numbers
 * ever change.
 */
const MAX_ACCEPT_TAGS = 10;
const MAX_TAG_LENGTH = 256;

/**
 * `accept` always prepends one identity tag ({@link ID_TAG_PREFIX}) before
 * calling `state.acceptWebSocket`, which is what turns Cloudflare's
 * {@link MAX_ACCEPT_TAGS}-tag provider cap into a caller-visible budget one
 * smaller — the reservation the guard below enforces.
 */
const RESERVED_ID_TAG_COUNT = 1;

/**
 * Reject an over-budget `tags` argument before it ever reaches
 * `state.acceptWebSocket` — the provider throws about the combined list
 * (including the host's own reserved id tag), which blames the caller for a
 * count or tag it never supplied. The adapter knows whose fault it is and
 * says so.
 */
const assertWithinTagBudget = (tags: ReadonlyArray<string> | undefined): void => {
    if (!tags || tags.length === 0) {
        return;
    }

    const usableBudget = MAX_ACCEPT_TAGS - RESERVED_ID_TAG_COUNT;

    if (tags.length > usableBudget) {
        throw new LunoraError(
            "SOCKET_TAG_BUDGET_EXCEEDED",
            `${String(tags.length)} tags supplied; Cloudflare allows ${String(MAX_ACCEPT_TAGS)} per socket and 1 is reserved for the host's identity tag — pass at most ${String(usableBudget)}.`,
        );
    }

    const overLength = tags.find((tag) => tag.length > MAX_TAG_LENGTH);

    if (overLength !== undefined) {
        throw new LunoraError(
            "SOCKET_TAG_BUDGET_EXCEEDED",
            `Tag ${JSON.stringify(overLength)} is ${String(overLength.length)} characters; Cloudflare allows at most ${String(MAX_TAG_LENGTH)} characters per tag.`,
        );
    }
};

/**
 * Build the socket host for a DO.
 *
 * Note what is deliberately absent: `setTag` / `removeTag`. Cloudflare freezes
 * a socket's tags at `acceptWebSocket`, so declaring mutable tagging would be a
 * lie the engine could route on. Per the `SocketHost` contract, omitting both
 * tells callers to re-accept instead.
 */
const createSocketHost = (state: DurableObjectState): SocketHost => {
    /**
     * Sockets this host has already determined are not its own.
     *
     * The last resort in `handleFor` is a linear scan of the runtime's socket
     * array, and a NEGATIVE answer is the expensive case: it scans the whole set
     * to conclude nothing. Without this, a socket the runtime keeps handing us
     * that we never accepted — the `webSocketMessage` sender in a fan-out
     * benchmark, a relay-tier peer — pays that scan on every single frame.
     *
     * Safe to keep forever because it can only become stale in one direction: a
     * socket enters through `accept`, which records a fallback id, and
     * `handleFor` checks ownership before consulting this set. So a later accept
     * always wins over a cached negative.
     */
    const notOurs = new WeakSet<WebSocket>();

    /**
     * Membership set for the last-resort ownership test.
     *
     * The test itself is unavoidable — a test double can seed `getWebSockets()`
     * without ever calling `accept`, so such a socket is genuinely live yet
     * carries neither a tag nor a fallback id. What IS avoidable is re-deriving
     * it: `includes` walked the whole array on every inbound frame, turning a
     * question about one socket into O(live sockets) per message. Invalidated by
     * `accept` (the only way in, which bumps `generation`) or by a length change
     * (the only way out, closing).
     */
    let generation = 0;
    let membership: undefined | { generation: number; length: number; set: WeakSet<WebSocket> };

    const liveSet = (): WeakSet<WebSocket> => {
        const raw = state.getWebSockets();

        if (membership?.generation !== generation || membership.length !== raw.length) {
            membership = { generation, length: raw.length, set: new WeakSet(raw) };
        }

        return membership.set;
    };

    return {
        accept: (socket, attachment, tags) => {
            assertWithinTagBudget(tags);

            const ws = socket as WebSocket;
            const id = crypto.randomUUID();

            // Accept first, then stamp: the runtime only tracks attachments for
            // sockets it has accepted, and the two calls are adjacent and
            // synchronous so no frame can arrive against an unstamped socket.
            state.acceptWebSocket(ws, [`${ID_TAG_PREFIX}${id}`, ...(tags ?? [])]);
            fallbackIds.set(ws, id);
            generation += 1;

            if (attachment !== undefined) {
                (ws as { serializeAttachment?: (value: unknown) => void }).serializeAttachment?.(attachment);
            }

            return ws as SocketHandle;
        },

        // The runtime socket IS the handle, so there is nothing to map and no
        // memo to keep: `state.getWebSockets(tag)` filters natively and exactly,
        // which is the contract's requirement — a superset would fan updates out
        // across subscriptions that never asked for them.
        //
        // This used to map the array to wrapper handles and memoize the result on
        // a (generation, length) pair to avoid re-mapping per fan-out. Both the
        // mapping and the memo guarding it are gone with the wrapper.
        getSockets: (tag) => state.getWebSockets(tag) as SocketHandle[],

        handleFor: (socket) => {
            const ws = socket as WebSocket;

            // An ownership test, not a translation — the socket the runtime hands
            // to `webSocketMessage`/`webSocketClose` is already the handle. All
            // this decides is whether it is one of ours, so a socket we never
            // accepted is not handed back as if it were.
            //
            // Asked in O(1) for the common cases. An accepted socket carries the
            // durable id tag, which survives hibernation; doubles that never
            // implement `getTags` still went through `accept`, which records a
            // fallback id.
            // `fallbackIds` first: it is an O(1) WeakMap hit for every socket this
            // wake accepted, whereas `idTagOf` is a `getTags` host call that
            // allocates an array on every inbound frame. Both are ownership
            // evidence, so the union is unchanged — only the cost order is.
            if (fallbackIds.has(ws) || idTagOf(state, ws) !== undefined) {
                return ws as SocketHandle;
            }

            if (notOurs.has(ws)) {
                return undefined;
            }

            // Last resort: ownership by membership, answered from the memo above
            // rather than by walking the socket array per frame. Unreachable on a
            // real runtime, where every live socket was accepted and matched
            // above — it exists for doubles that seed `getWebSockets()` directly.
            if (liveSet().has(ws)) {
                return ws as SocketHandle;
            }

            notOurs.add(ws);

            return undefined;
        },

        idFor: (socket) => readSocketId(state, socket as WebSocket),
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
