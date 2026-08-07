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
    bufferedAmount: number;
    closed: boolean;
    handle: SocketHandle;
    id: string;
    /** The raw object passed to `accept`, for `handleFor` lookups. */
    raw: unknown;
    received: (string | ArrayBuffer)[];
    tags: Set<string>;
}

/** Row shape of `_lunora_sockets`. */
interface SocketRow {
    attachment: Buffer | null;
    tags: string;
}

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

    const createHandle = (socketState: NodeSocket): SocketHandle => {
        // Alias so the mutation is on a local binding, not the parameter
        // (no-param-reassign) — same pattern as `@lunora/shard-engine`'s
        // `createGeoBuilder`.
        const state = socketState;
        const handle: SocketHandle = {
            bufferedAmount: state.bufferedAmount,
            close: (_code, _reason) => {
                state.closed = true;
                runtimeSockets.delete(state.id);

                // A closed socket is never restored, so its durable row is
                // garbage the moment it closes. Cloudflare drops the socket from
                // `getWebSockets()` on the close event; leaving the row (and the
                // map entry) behind would both leak and fan updates out at a dead
                // subscriber.
                if (database.open) {
                    deleteRow.run(state.id);
                }
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

        state.handle = handle;
        handleIds.set(handle, state.id);

        return handle;
    };

    const socket: SocketHost = {
        accept: (raw, attachment, tags) => {
            const id = crypto.randomUUID();
            const tagSet = new Set(tags);
            const state: NodeSocket = {
                attachment,
                bufferedAmount: 0,
                closed: false,
                handle: undefined as unknown as SocketHandle,
                id,
                raw,
                received: [],
                tags: tagSet,
            };

            runtimeSockets.set(id, state);

            if (database.open) {
                // eslint-disable-next-line unicorn/no-null -- see `persistAttachment`: SQL NULL for an absent attachment
                upsertRow.run(id, attachment === undefined ? null : serialize(attachment), JSON.stringify([...tagSet]));
            }

            return createHandle(state);
        },
        getSockets: (tag) => {
            const sockets = [...runtimeSockets.values()];
            const filtered = tag === undefined ? sockets : sockets.filter((state) => state.tags.has(tag));

            return filtered.map((state) => state.handle);
        },
        handleFor: (raw) => [...runtimeSockets.values()].find((state) => state.raw === raw)?.handle,
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
                bufferedAmount: 0,
                closed: false,
                handle: undefined as unknown as SocketHandle,
                id,
                raw: undefined,
                received: [],
                tags: new Set(row === undefined ? [] : (JSON.parse(row.tags) as string[])),
            };

            runtimeSockets.set(id, state);

            return createHandle(state);
        },
        simulateRecycle: () => {
            runtimeSockets.clear();
        },
        socket,
    };
};
