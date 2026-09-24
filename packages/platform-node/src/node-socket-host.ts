/**
 * Node adapter: a socket registry satisfying the provider-neutral
 * `@lunora/platform` `SocketHost` contract, with attachments and tags persisted
 * to SQLite.
 *
 * Cloudflare's `SocketHost` is backed by the DO WebSocket hibernation API — the
 * runtime* owns the sockets, so an attachment and its accept-time tags survive
 * eviction for free. A Node process has no hibernation primitive to borrow, so
 * this host splits the two halves explicitly:
 *
 * - **Runtime state** (the live transport object, its outbound frames, its
 * in-memory tag set) lives in a `Map` and dies with the process. There is no
 * way around that: a TCP socket cannot outlive the process holding it.
 * - **Durable state** (attachment + tags, keyed by socket id) lives in
 * `_lunora_sockets` on the same `better-sqlite3` connection as the rest of the
 * shard, so it survives both a `simulateRecycle()` and a genuine process
 * restart.
 *
 * That second half is what the contract actually asks for. `SocketHost`'s
 * guarantee 2 is "arbitrary JSON state serialized with the socket must survive
 * recycling and be readable on wake" — a guarantee about the *state*, not about
 * the connection. A client that reconnects after a restart and presents its
 * socket id gets its subscription state back, which is the behavior the engine
 * reassociates on.
 *
 * Ids are `crypto.randomUUID()` rather than a counter. A counter restarts at 1
 * on every process start and would collide with ids already in the table —
 * silently handing a reconnecting client someone else's attachment.
 *
 * Unlike Cloudflare — whose tags freeze at `acceptWebSocket` — a Node registry
 * has no reason a live socket's tags can't change, so `setTag`/`removeTag` are
 * implemented. That is the mutable-tag tier `SocketHost` documents as optional,
 * and this host is the first in the repo to declare it.
 */

import { deserialize, serialize } from "node:v8";

import type { SocketHandle, SocketHost } from "@lunora/platform";
import type Database from "better-sqlite3";

import { toArrayBuffer } from "./to-array-buffer";

/** Internal record for one accepted (or restored) socket. */
interface NodeSocket {
    attachment: unknown;
    closed: boolean;
    handle: SocketHandle;
    id: string;
    /** The raw object passed to `accept`, for `handleFor` lookups. */
    raw: unknown;

    /**
     * Frames sent through a socket this host had to give a `send` to — a bare
     * test double with no transport of its own. A real transport keeps its own
     * `send`, so nothing is buffered for it and this stays empty: a per-socket
     * array that grew with every fan-out frame would be an unbounded leak on a
     * long-lived connection.
     */
    received: (string | ArrayBuffer)[];
    tags: Set<string>;
}

/** Row shape of `_lunora_sockets`. */
interface SocketRow {
    attachment: Buffer | null;
    tags: string;
}

/**
 * Whether a value can key a `WeakMap`. `SocketHost.accept` takes `unknown`, so
 * a conformant caller may hand this host a primitive — indexing one throws
 * `TypeError: Invalid value used as weak map key`.
 *
 * A primitive raw is therefore accepted and tracked, but not resolvable
 * through `handleFor` (which answers `undefined` for it, the same as for a
 * socket this host never accepted). Every real transport hands over an object;
 * if a primitive-keyed transport ever appears, pair the WeakMap with a plain
 * `Map` for primitives, cleaned on the same close path.
 */
const isWeakKey = (value: unknown): value is object => (typeof value === "object" && value !== null) || typeof value === "function";

/**
 * The socket-host half of a Node platform instance, plus the test-only hooks
 * `@lunora/platform/conformance`'s `ConformanceHost` needs to drive a recycle
 * from inside a test.
 */
export interface NodeSocketHost {
    /** Read back the frames sent to a socket, oldest first, text frames only. */
    readFrames: (handle: SocketHandle) => string[];

    /**
     * Re-create a runtime socket from durable state.
     *
     * `attachment` is a fallback only: this host restores what it persisted,
     * because that is what a real wake looks like. The argument covers an id
     * this host never durably tracked (a synthetic id a test constructs).
     */
    restoreSocket: (id: string, attachment: unknown) => SocketHandle;
    /** Drop the runtime socket map while keeping durable attachments/tags. */
    simulateRecycle: () => void;
    /** The `SocketHost` contract implementation. */
    socket: SocketHost;
}

/** Build the socket registry, persisting attachments and tags to `database`. */
export const createNodeSocketHost = (database: Database.Database): NodeSocketHost => {
    database.exec("CREATE TABLE IF NOT EXISTS _lunora_sockets (id TEXT PRIMARY KEY, attachment BLOB, tags TEXT NOT NULL DEFAULT '[]')");

    const upsertRow = database.prepare<[string, Buffer | null, string]>(
        `INSERT INTO _lunora_sockets (id, attachment, tags) VALUES (?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET attachment = excluded.attachment, tags = excluded.tags`,
    );
    const updateAttachment = database.prepare<[Buffer | null, string]>("UPDATE _lunora_sockets SET attachment = ? WHERE id = ?");
    const updateTags = database.prepare<[string, string]>("UPDATE _lunora_sockets SET tags = ? WHERE id = ?");
    const selectRow = database.prepare<[string], SocketRow>("SELECT attachment, tags FROM _lunora_sockets WHERE id = ?");
    const deleteRow = database.prepare<[string]>("DELETE FROM _lunora_sockets WHERE id = ?");

    const runtimeSockets = new Map<string, NodeSocket>();
    const handleIds = new WeakMap<SocketHandle, string>();

    // O(1) raw → state for `handleFor`, which the engine calls per inbound
    // frame — a linear scan of `runtimeSockets` here is O(live sockets) per
    // message. Every raw enters via `accept` (no foreign sockets reach this
    // host), so no negative cache is needed. Reassigned on `simulateRecycle`
    // because a WeakMap cannot be cleared.
    let byRaw = new WeakMap<object, NodeSocket>();

    /**
     * Every durable write is guarded on `database.open`. A socket handle can
     * outlive the connection — a caller that closes the platform still holds
     * handles, and `send`/`serializeAttachment` on one must not throw from a
     * closed connection.
     */
    const persistAttachment = (id: string, value: unknown): void => {
        if (database.open) {
            // eslint-disable-next-line unicorn/no-null -- writing SQL NULL into a nullable BLOB column; better-sqlite3 has no other spelling for it
            updateAttachment.run(value === undefined ? null : serialize(value), id);
        }
    };

    const persistTags = (id: string, tags: Set<string>): void => {
        if (database.open) {
            updateTags.run(JSON.stringify([...tags]), id);
        }
    };

    /**
     * Drop a socket from the runtime map and from durable storage.
     *
     * A closed socket is never restored, so its durable row is garbage the
     * moment it closes. Cloudflare drops the socket from `getWebSockets()` on
     * the close event; leaving the row (and the map entry) behind would both
     * leak and fan updates out at a dead subscriber. Idempotent, because an
     * adopted transport's `close` may be called more than once.
     */
    const deregister = (socketState: NodeSocket): void => {
        const state = socketState;

        state.closed = true;
        runtimeSockets.delete(state.id);

        if (isWeakKey(state.raw)) {
            byRaw.delete(state.raw);
        }

        if (database.open) {
            deleteRow.run(state.id);
        }
    };

    /** Bind a state's id to the handle it is reachable through, for `idFor`. */
    const bindHandle = (socketState: NodeSocket, handle: SocketHandle): SocketHandle => {
        const state = socketState;

        state.handle = handle;
        handleIds.set(handle, state.id);

        return handle;
    };

    /**
     * Adopt an object transport AS the handle.
     *
     * `SocketHandle` is deliberately not a wrapper: "a host is expected to
     * return its own transport socket here, unchanged", because the engine keys
     * per-socket memos on whatever `accept` / `handleFor` / `getSockets` hand
     * back, and a host that mints a second object makes those three disagree.
     * This host used to mint one, so every fan-out frame written through
     * `getSockets()` landed in an in-process array instead of on the wire while
     * `handleFor` answered a different object for the same connection.
     *
     * The two attachment methods and the deregistering `close` are stamped onto
     * the transport — the same thing the DO runtime does for Cloudflare's
     * hosts, where the runtime owns hibernation and here this host is the
     * runtime. `send` is left alone whenever the transport has one, so frames
     * go straight out and nothing is buffered; a bare double with no `send`
     * gets a recording one instead, which is what `readFrames` reads back.
     */
    const adoptRaw = (socketState: NodeSocket, raw: object): SocketHandle => {
        const state = socketState;
        const transport = raw as Partial<SocketHandle>;
        const transportClose = typeof transport.close === "function" ? transport.close.bind(raw) : undefined;

        if (typeof transport.send !== "function") {
            transport.send = (data) => {
                state.received.push(typeof data === "string" ? data : toArrayBuffer(data));
            };
        }

        transport.close = (code, reason) => {
            deregister(state);
            transportClose?.(code, reason);
        };
        transport.deserializeAttachment = () => state.attachment;
        transport.serializeAttachment = (value) => {
            state.attachment = value;
            persistAttachment(state.id, value);
        };

        return bindHandle(state, raw as SocketHandle);
    };

    /**
     * Mint a handle for a socket that cannot BE one: a restored socket, whose
     * transport died with the previous process, and a primitive raw, which
     * cannot carry properties. Both are off the fan-out path — a restored
     * socket has no wire to reach — so the identity collapse `adoptRaw` buys
     * does not apply, and `send` here is honestly a buffer rather than a
     * transport.
     */
    const createHandle = (socketState: NodeSocket): SocketHandle => {
        // Alias so the mutation is on a local binding, not the parameter
        // (no-param-reassign) — same pattern as `@lunora/shard-engine`'s
        // `createGeoBuilder`.
        const state = socketState;
        const handle: SocketHandle = {
            // `bufferedAmount` is deliberately ABSENT rather than reported as
            // `0`. The contract reads an absent value as "assume drained" but a
            // present `0` as a positive claim of an empty queue, and this handle
            // has no outbound queue to measure — `send` appends to an in-process
            // array. A frozen `0` would tell the engine backpressure never
            // applies, which is the one answer it cannot detect as missing. An
            // adopted transport reports its own, natively.
            close: (_code, _reason) => {
                deregister(state);
            },
            deserializeAttachment: () => state.attachment,
            send: (data) => {
                state.received.push(typeof data === "string" ? data : toArrayBuffer(data));
            },
            serializeAttachment: (value) => {
                state.attachment = value;
                persistAttachment(state.id, value);
            },
        };

        return bindHandle(state, handle);
    };

    const socket: SocketHost = {
        accept: (raw, attachment, tags) => {
            if (!database.open) {
                throw new Error("platform closed: cannot accept a socket");
            }

            const id = crypto.randomUUID();
            const tagSet = new Set(tags);

            // The durable write goes first, because it is the only fallible
            // step (a rejected INSERT, an attachment `serialize` refuses).
            // Registering the runtime state first would leave a half-accepted
            // socket — enumerable through `getSockets`, with no row behind it —
            // in the maps of a call that threw.
            // eslint-disable-next-line unicorn/no-null -- see `persistAttachment`: SQL NULL for an absent attachment
            upsertRow.run(id, attachment === undefined ? null : serialize(attachment), JSON.stringify([...tagSet]));

            const state: NodeSocket = {
                attachment,
                closed: false,
                handle: undefined as unknown as SocketHandle,
                id,
                raw,
                received: [],
                tags: tagSet,
            };

            runtimeSockets.set(id, state);

            if (isWeakKey(raw)) {
                byRaw.set(raw, state);

                return adoptRaw(state, raw);
            }

            return createHandle(state);
        },
        getSockets: (tag) => {
            const sockets = [...runtimeSockets.values()];
            const filtered = tag === undefined ? sockets : sockets.filter((state) => state.tags.has(tag));

            return filtered.map((state) => state.handle);
        },
        // The `isWeakKey` guard doubles as the `undefined` guard: a restored
        // socket's `raw` is `undefined`, and a `handleFor(undefined)` lookup
        // must never match one.
        handleFor: (raw) => (isWeakKey(raw) ? byRaw.get(raw)?.handle : undefined),
        idFor: (handle) => {
            const id = handleIds.get(handle);

            if (id === undefined) {
                // Same choice the reference host makes, for the same reason: this
                // host's `SocketHandle` is an opaque object it mints itself, so an
                // unrecognized handle means caller error (a handle crossed from a
                // different host instance) — throwing beats minting a plausible but
                // wrong id. See `SocketHost.idFor`'s docstring for the two valid
                // choices and why they diverge by host.
                throw new Error("@lunora/platform-node: idFor called with a handle this host never issued");
            }

            return id;
        },
        removeTag: (handle, tag) => {
            if (!database.open) {
                throw new Error("platform closed: cannot remove a tag");
            }

            const state = runtimeSockets.get(handleIds.get(handle) ?? "");

            if (state === undefined) {
                return;
            }

            if (tag === undefined) {
                state.tags.clear();
            } else {
                state.tags.delete(tag);
            }

            persistTags(state.id, state.tags);
        },
        setTag: (handle, tag) => {
            if (!database.open) {
                throw new Error("platform closed: cannot set a tag");
            }

            const state = runtimeSockets.get(handleIds.get(handle) ?? "");

            if (state === undefined) {
                return;
            }

            state.tags.add(tag);
            persistTags(state.id, state.tags);
        },
    };

    return {
        readFrames: (handle) => (runtimeSockets.get(handleIds.get(handle) ?? "")?.received ?? []).filter((frame): frame is string => typeof frame === "string"),
        restoreSocket: (id, attachment) => {
            const row = database.open ? selectRow.get(id) : undefined;

            const persisted = row?.attachment === null ? undefined : row?.attachment;
            const state: NodeSocket = {
                attachment: persisted === undefined ? attachment : deserialize(persisted),
                closed: false,
                handle: undefined as unknown as SocketHandle,
                id,
                raw: undefined,
                received: [],
                tags: new Set(row === undefined ? [] : (JSON.parse(row.tags) as string[])),
            };

            runtimeSockets.set(id, state);

            // A restored-but-previously-unknown id has no durable row, and
            // `persistAttachment`/`persistTags` are UPDATE-only — without this
            // insert a later `serializeAttachment` on the restored handle would
            // silently write nothing, violating SocketHost guarantee 2.
            //
            // Only when there is no row at all. An existing row whose
            // `attachment` is SQL NULL belongs to a socket this host *did*
            // track, accepted without an attachment — writing the caller's
            // fallback over it would persist state this host never received,
            // and the fallback is documented as covering an untracked id only.
            if (row === undefined && database.open) {
                // eslint-disable-next-line unicorn/no-null -- see `persistAttachment`: SQL NULL for an absent attachment
                upsertRow.run(id, state.attachment === undefined ? null : serialize(state.attachment), JSON.stringify([...state.tags]));
            }

            return createHandle(state);
        },
        simulateRecycle: () => {
            runtimeSockets.clear();
            byRaw = new WeakMap();
        },
        socket,
    };
};
