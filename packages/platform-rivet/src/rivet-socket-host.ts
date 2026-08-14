/**
 * Rivet adapter: the provider-neutral `@lunora/platform` `SocketHost` over the
 * WebSockets Rivet hands to `onWebSocket`.
 *
 * Rivet is the only non-Cloudflare target so far that can honour the
 * hibernation* half of this contract rather than merely the durability half.
 * With `options.canHibernateWebSocket: true` an actor sleeps with its sockets
 * still open and Rivet wakes it on the next frame or on close — the same
 * bargain Durable Object hibernation makes, and something a Node process cannot
 * do at all (a TCP socket cannot outlive the process holding it).
 *
 * That still leaves this file with a job, because Rivet hibernates the
 * connection*, not Lunora's *subscription state*:
 *
 * - **Runtime state** — the live `WebSocket`, its in-memory tag set — lives in
 * a `Map` for the current wake.
 * - **Durable state** — the attachment and tags, keyed by socket id — lives in
 * `_lunora_sockets` inside the shard's synchronous working copy (see
 * `./rivet-shard-state`), so it is captured by the same snapshot as the rest
 * of the shard and comes back on the next wake.
 *
 * The working copy is used rather than Rivet's `c.db` for one reason:
 * `SocketHandle.serializeAttachment` is **synchronous**, and every entry point
 * into Rivet's SQLite is a promise. An adapter that ignored that would have to
 * fire-and-forget the durable write, which is how an attachment goes missing
 * exactly when it matters — after an unplanned sleep.
 *
 * Tags are mutable here (`setTag`/`removeTag` are implemented), which
 * Cloudflare's host cannot offer: DO tags freeze at `acceptWebSocket`. Rivet
 * has no tagging concept of its own, so the tag set is entirely this host's
 * and there is no reason to freeze it.
 */

import { deserialize, serialize } from "node:v8";

import { LunoraError } from "@lunora/errors";
import type { SocketHandle, SocketHost } from "@lunora/platform";

import type { RivetWebSocketLike } from "./rivet-context";
import type { RivetShardState } from "./rivet-shard-state";

/** Internal record for one accepted (or restored) socket. */
interface RivetSocket {
    attachment: unknown;
    handle: SocketHandle;
    id: string;
    /** The transport socket `accept` was handed, for `handleFor` lookups. */
    raw: unknown;
    tags: Set<string>;
}

/** Row shape of `_lunora_sockets`. */
interface SocketRow {
    attachment: Buffer | null;
    tags: string;
}

/** The socket host plus the hooks the conformance TCK needs to drive a recycle. */
interface RivetSocketHost {
    /**
     * Re-create a runtime socket from durable state — what a wake does for a
     * hibernated connection.
     *
     * `attachment` is a fallback for an id this host never durably tracked (a
     * synthetic id a test constructs); a real wake restores what was persisted.
     */
    restoreSocket: (id: string, attachment: unknown) => SocketHandle;
    /** Drop the runtime socket map while keeping durable attachments and tags. */
    simulateRecycle: () => void;
    /** The `SocketHost` contract implementation. */
    socket: SocketHost;
}

/**
 * Narrow the opaque `unknown` `SocketHost.accept` takes to the transport
 * members this host uses, or `undefined` when it is not a socket at all.
 *
 * The contract types the accepted socket as `unknown` because what a socket
 * actually is differs per host, and the conformance suite accepts plain objects. So
 * this checks rather than casts: a restored-but-not-reconnected socket and a
 * test's opaque stand-in both land here, and neither should make `send` throw.
 *
 * The narrowed type is {@link RivetWebSocketLike} — the projection of Rivet's
 * `UniversalWebSocket` in `./rivet-context` — rather than a second interface
 * declared here. A `*Like` projection with no consumer is exactly what drifts
 * from the real type unnoticed (CLAUDE.md's platform-parity note says so, and
 * this one had no consumer until it became this function's return type).
 */
const asTransport = (raw: unknown): RivetWebSocketLike | undefined => {
    if (typeof raw !== "object" || raw === null) {
        return undefined;
    }

    const candidate = raw as Partial<RivetWebSocketLike>;

    return typeof candidate.send === "function" && typeof candidate.close === "function" ? (candidate as RivetWebSocketLike) : undefined;
};

/**
 * Build the socket registry over the shard's working copy.
 *
 * `send` and `close` go straight to the transport socket Rivet supplied, so a
 * host that is handed a real `WebSocket` really does deliver. Frames are not
 * mirrored anywhere — unlike `@lunora/platform-node`, which records them so its
 * conformance host can prove delivery, this one has a genuine transport to
 * prove it against and recording would only duplicate the send queue in memory.
 */
const createRivetSocketHost = (state: RivetShardState): RivetSocketHost => {
    const { database } = state;

    database.exec("CREATE TABLE IF NOT EXISTS _lunora_sockets (id TEXT PRIMARY KEY, attachment BLOB, tags TEXT NOT NULL DEFAULT '[]')");

    const upsertRow = database.prepare<[string, Buffer | null, string]>(
        `INSERT INTO _lunora_sockets (id, attachment, tags) VALUES (?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET attachment = excluded.attachment, tags = excluded.tags`,
    );
    const updateAttachment = database.prepare<[Buffer | null, string]>("UPDATE _lunora_sockets SET attachment = ? WHERE id = ?");
    const updateTags = database.prepare<[string, string]>("UPDATE _lunora_sockets SET tags = ? WHERE id = ?");
    const selectRow = database.prepare<[string], SocketRow>("SELECT attachment, tags FROM _lunora_sockets WHERE id = ?");
    const deleteRow = database.prepare<[string]>("DELETE FROM _lunora_sockets WHERE id = ?");

    const runtimeSockets = new Map<string, RivetSocket>();
    const handleIds = new WeakMap<SocketHandle, string>();

    const persistAttachment = (id: string, value: unknown): void => {
        // eslint-disable-next-line unicorn/no-null -- writing SQL NULL into a nullable BLOB column; better-sqlite3 has no other spelling for it
        updateAttachment.run(value === undefined ? null : serialize(value), id);
        state.markDirty();
    };

    const persistTags = (id: string, tags: Set<string>): void => {
        updateTags.run(JSON.stringify([...tags]), id);
        state.markDirty();
    };

    /**
     * Wrap the transport socket in a handle.
     *
     * Unlike `SocketHandle`'s "not a wrapper" preference, this host does wrap —
     * and pays the per-socket cost itself, as that note allows. It has to:
     * `deserializeAttachment`/`serializeAttachment` are Lunora concepts a
     * standard WinterTC `WebSocket` has no member for, so a bare transport
     * socket cannot satisfy the interface. Identity therefore lives in a
     * `WeakMap` keyed by handle, and `handleFor` maps the other way from the
     * transport object Rivet hands back to `onWebSocket` callbacks.
     */
    const createHandle = (socketState: RivetSocket, transport: RivetWebSocketLike | undefined): SocketHandle => {
        const socket = socketState;
        const handle: SocketHandle = {
            get bufferedAmount(): number | undefined {
                return transport?.bufferedAmount;
            },
            close: (code, reason) => {
                runtimeSockets.delete(socket.id);

                // A closed socket is never restored, so its durable row is
                // garbage the moment it closes — and leaving it would fan
                // updates at a dead subscriber on the next wake.
                deleteRow.run(socket.id);
                state.markDirty();

                transport?.close(code, reason);
            },
            deserializeAttachment: () => socket.attachment,
            send: (data) => {
                transport?.send(data);
            },
            serializeAttachment: (value) => {
                socket.attachment = value;
                persistAttachment(socket.id, value);
            },
        };

        socket.handle = handle;
        handleIds.set(handle, socket.id);

        return handle;
    };

    const socket: SocketHost = {
        accept: (raw, attachment, tags) => {
            // Ids are random rather than sequential: a counter restarts at 1 on
            // every wake and would collide with ids already in the table,
            // silently handing a reconnecting client someone else's attachment.
            const id = crypto.randomUUID();
            const tagSet = new Set(tags);
            const record: RivetSocket = {
                attachment,
                handle: undefined as unknown as SocketHandle,
                id,
                raw,
                tags: tagSet,
            };

            runtimeSockets.set(id, record);
            // eslint-disable-next-line unicorn/no-null -- see `persistAttachment`: SQL NULL for an absent attachment
            upsertRow.run(id, attachment === undefined ? null : serialize(attachment), JSON.stringify([...tagSet]));
            state.markDirty();

            return createHandle(record, asTransport(raw));
        },
        getSockets: (tag) => {
            const sockets = [...runtimeSockets.values()];

            return (tag === undefined ? sockets : sockets.filter((record) => record.tags.has(tag))).map((record) => record.handle);
        },
        handleFor: (raw) => [...runtimeSockets.values()].find((record) => record.raw === raw)?.handle,
        idFor: (handle) => {
            const id = handleIds.get(handle);

            if (id === undefined) {
                // This host mints its own opaque handles (see `createHandle`),
                // so a handle it does not recognize can only have crossed from
                // another host instance — caller error. That is the first of
                // the two choices `SocketHost.idFor` documents; the
                // mint-a-fallback branch is for hosts whose handle IS the
                // transport socket, which this one's is not.
                throw new LunoraError("INTERNAL_ERROR", "@lunora/platform-rivet: idFor called with a handle this host never issued");
            }

            return id;
        },
        removeTag: (handle, tag) => {
            const record = runtimeSockets.get(handleIds.get(handle) ?? "");

            if (record === undefined) {
                return;
            }

            if (tag === undefined) {
                record.tags.clear();
            } else {
                record.tags.delete(tag);
            }

            persistTags(record.id, record.tags);
        },
        setTag: (handle, tag) => {
            const record = runtimeSockets.get(handleIds.get(handle) ?? "");

            if (record === undefined) {
                return;
            }

            record.tags.add(tag);
            persistTags(record.id, record.tags);
        },
    };

    return {
        restoreSocket: (id, attachment) => {
            const row = selectRow.get(id);
            const persisted = row?.attachment ?? undefined;
            const record: RivetSocket = {
                attachment: persisted === undefined ? attachment : deserialize(persisted),
                handle: undefined as unknown as SocketHandle,
                id,
                raw: undefined,
                tags: new Set(row === undefined ? [] : (JSON.parse(row.tags) as string[])),
            };

            runtimeSockets.set(id, record);

            return createHandle(record, undefined);
        },
        simulateRecycle: () => {
            runtimeSockets.clear();
        },
        socket,
    };
};

export type { RivetSocketHost };
export { createRivetSocketHost };
