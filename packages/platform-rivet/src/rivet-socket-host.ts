/**
 * Rivet adapter: the provider-neutral `@lunora/platform` `SocketHost` over the
 * WebSockets Rivet hands to `onWebSocket`.
 *
 * Rivet is the only non-Cloudflare target so far that can keep the *connection*
 * across a sleep rather than only its durable state. With
 * `options.canHibernateWebSocket: true` an actor sleeps with its sockets still
 * open and Rivet wakes it on the next frame or on close — something a Node
 * process cannot do at all (a TCP socket cannot outlive the process holding
 * it). It is half of what Durable Object hibernation gives, which is why the
 * matrix rates this target's hibernation `emulated`: the other half is below.
 *
 * That still leaves this file with a job, because Rivet hibernates the
 * connection*, not Lunora's *subscription state*:
 *
 * - **Runtime state** — the live `WebSocket`, its in-memory tag set — lives in
 * a `Map` for the current wake.
 * - **Durable state** — the attachment and tags, keyed by socket id — lives in
 * `_lunora_sockets` inside the host registry working copy (see
 * `./rivet-shard-state`), so it is snapshotted alongside the shard and comes
 * back on the next wake.
 *
 * Those two halves are joined by {@link RivetSocketHost.restoreSockets}, which
 * the composition root calls on every wake: without it `runtimeSockets` starts
 * empty, `getSockets(tag)` answers `[]`, and every poke and delta for a
 * connection that outlived a sleep is dropped silently — the durable rows would
 * be write-only. Rebinding the live transport to a restored record is
 * {@link RivetSocketHost.attachSocket}'s job, and it is why the actor's
 * `onWebSocket` handler must rebind by id rather than `accept` a second time:
 * `accept` mints a fresh id, orphaning both the durable row and the engine's
 * subscription state keyed by it.
 *
 * The registry copy is used rather than Rivet's `c.db` for one reason:
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
    id: string;
    tags: string;
}

/** The socket host, plus the wake and recycle hooks around it. */
interface RivetSocketHost {
    /**
     * Bind a live transport socket to an already-restored record.
     *
     * This is the wake half of hibernation. Rivet re-invokes `onWebSocket` for
     * a connection that slept with the actor, and the handler must rebind that
     * socket to the id it was originally accepted under — the id the engine's
     * subscription state is keyed by. Calling `accept` again instead mints a
     * new id, so the durable row is orphaned and the subscription is lost.
     * @returns the rebound handle, or `undefined` for an id this host has no
     * restored record for (a genuinely new connection — `accept` it).
     */
    attachSocket: (id: string, raw: unknown) => SocketHandle | undefined;

    /**
     * Re-create one runtime socket from durable state, by id.
     *
     * `attachment` is a fallback for an id this host never durably tracked (a
     * synthetic id a test constructs); a real wake restores what was persisted,
     * including an attachment the engine deliberately cleared.
     */
    restoreSocket: (id: string, attachment: unknown) => SocketHandle;

    /**
     * Re-create a runtime socket for **every** durable row — what a wake does.
     * Called by the composition root before anything can enumerate sockets.
     * @returns the restored handles, in no particular order.
     */
    restoreSockets: () => SocketHandle[];
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
 * Build the socket registry over the host's registry working copy.
 *
 * `send` and `close` go straight to the transport socket Rivet supplied, so a
 * host that is handed a real `WebSocket` really does deliver. Frames are not
 * mirrored anywhere — unlike `@lunora/platform-node`, which records them so its
 * conformance host can prove delivery, this one has a genuine transport to
 * prove it against and recording would only duplicate the send queue in memory.
 */
const createRivetSocketHost = (state: RivetShardState): RivetSocketHost => {
    const { registry } = state;

    registry.exec("CREATE TABLE IF NOT EXISTS _lunora_sockets (id TEXT PRIMARY KEY, attachment BLOB, tags TEXT NOT NULL DEFAULT '[]')");

    const upsertRow = registry.prepare<[string, Buffer | null, string]>(
        `INSERT INTO _lunora_sockets (id, attachment, tags) VALUES (?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET attachment = excluded.attachment, tags = excluded.tags`,
    );
    const updateAttachment = registry.prepare<[Buffer | null, string]>("UPDATE _lunora_sockets SET attachment = ? WHERE id = ?");
    const updateTags = registry.prepare<[string, string]>("UPDATE _lunora_sockets SET tags = ? WHERE id = ?");
    const selectRow = registry.prepare<[string], SocketRow>("SELECT id, attachment, tags FROM _lunora_sockets WHERE id = ?");
    const selectAll = registry.prepare<[], SocketRow>("SELECT id, attachment, tags FROM _lunora_sockets");
    const deleteRow = registry.prepare<[string]>("DELETE FROM _lunora_sockets WHERE id = ?");

    const runtimeSockets = new Map<string, RivetSocket>();
    const handleIds = new WeakMap<SocketHandle, string>();

    /**
     * Transport socket → record, so `handleFor` is a lookup rather than a scan.
     * `@lunora/shard-engine`'s inbound-frame path calls it once per message; a
     * `[...values()].find()` there allocates an array of every socket on the
     * shard per frame, which is the cost `SocketHandle`'s "not a wrapper" note
     * exists to avoid.
     */
    const socketsByRaw = new Map<unknown, RivetSocket>();

    const persistAttachment = (id: string, value: unknown): void => {
        // eslint-disable-next-line unicorn/no-null -- writing SQL NULL into a nullable BLOB column; better-sqlite3 has no other spelling for it
        updateAttachment.run(value === undefined ? null : serialize(value), id);
        state.markRegistryDirty();
    };

    const persistTags = (id: string, tags: Set<string>): void => {
        updateTags.run(JSON.stringify([...tags]), id);
        state.markRegistryDirty();
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

                if (socket.raw !== undefined) {
                    socketsByRaw.delete(socket.raw);
                }

                // A closed socket is never restored, so its durable row is
                // garbage the moment it closes — and leaving it would fan
                // updates at a dead subscriber on the next wake.
                deleteRow.run(socket.id);
                state.markRegistryDirty();

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

        if (socket.raw !== undefined) {
            socketsByRaw.set(socket.raw, socket);
        }

        return handle;
    };

    /**
     * Rebuild one runtime record from its durable row.
     *
     * `fallbackAttachment` covers an id with no row at all. It deliberately
     * does **not** cover a row whose `attachment` is SQL `NULL`: that is the
     * engine clearing state with `serializeAttachment(undefined)`, and falling
     * back there would resurrect exactly what it dropped.
     */
    const materialize = (id: string, row: SocketRow | undefined, fallbackAttachment: unknown): SocketHandle => {
        let attachment = fallbackAttachment;

        if (row !== undefined) {
            attachment = row.attachment === null ? undefined : deserialize(row.attachment);
        }

        const record: RivetSocket = {
            attachment,
            handle: undefined as unknown as SocketHandle,
            id,
            raw: undefined,
            tags: new Set(row === undefined ? [] : (JSON.parse(row.tags) as string[])),
        };

        runtimeSockets.set(id, record);

        if (row === undefined) {
            // No durable row for this id — the fallback case above. Create one
            // now, the way `accept` does: `persistAttachment` and `persistTags`
            // are both `UPDATE … WHERE id = ?`, so without a row every later
            // `serializeAttachment`/`setTag`/`removeTag` updates zero rows while
            // still marking the registry dirty. The snapshot is rewritten
            // without the values, and the next recycle loses them with no error.
            // eslint-disable-next-line unicorn/no-null -- see `persistAttachment`: SQL NULL for an absent attachment
            upsertRow.run(id, attachment === undefined ? null : serialize(attachment), JSON.stringify([...record.tags]));
            state.markRegistryDirty();
        }

        return createHandle(record, undefined);
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
            state.markRegistryDirty();

            return createHandle(record, asTransport(raw));
        },
        getSockets: (tag) => {
            const sockets = [...runtimeSockets.values()];

            return (tag === undefined ? sockets : sockets.filter((record) => record.tags.has(tag))).map((record) => record.handle);
        },
        handleFor: (raw) => (raw === undefined ? undefined : socketsByRaw.get(raw)?.handle),
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
        attachSocket: (id, raw) => {
            const record = runtimeSockets.get(id);

            if (record === undefined) {
                return undefined;
            }

            if (record.raw !== undefined) {
                socketsByRaw.delete(record.raw);
            }

            record.raw = raw;

            // A fresh handle rather than a mutated one: the transport is
            // captured by `createHandle`'s closure, which is what keeps `send`
            // off a property lookup on the fan-out path.
            return createHandle(record, asTransport(raw));
        },
        restoreSocket: (id, attachment) => materialize(id, selectRow.get(id), attachment),
        restoreSockets: () => selectAll.all().map((row) => materialize(row.id, row, undefined)),
        simulateRecycle: () => {
            runtimeSockets.clear();
            socketsByRaw.clear();
        },
        socket,
    };
};

export type { RivetSocketHost };
export { createRivetSocketHost };
