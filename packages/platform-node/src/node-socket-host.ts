/**
 * Node adapter: an in-process socket registry satisfying the provider-neutral
 * `@lunora/platform` `SocketHost` contract.
 *
 * Cloudflare's `SocketHost` is backed by the DO WebSocket hibernation API —
 * sockets survive eviction because the *runtime* owns them. A plain Node
 * process has no hibernation primitive to borrow: every socket this host
 * tracks lives only as long as the process does, and "recycle" only ever
 * means "the caller told us to forget the runtime half and rehydrate it" —
 * there is no involuntary eviction to model. That is a real asymmetry, not a
 * simplification made for the spike: see `plans/234-node-host-findings.md`.
 *
 * Unlike Cloudflare — whose tags freeze at `acceptWebSocket` — a Node
 * in-process registry has no reason a live socket's tags can't change, so
 * `setTag`/`removeTag` are implemented here. That is the mutable-tag tier
 * `SocketHost` documents as optional, and this host is the first one in the
 * repo to actually declare it.
 */

import type { SocketHandle, SocketHost } from "@lunora/platform";

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

const toArrayBuffer = (data: string | ArrayBufferLike | Blob | ArrayBufferView): ArrayBuffer => {
    if (typeof data === "string") {
        return new TextEncoder().encode(data).buffer;
    }

    if (data instanceof ArrayBuffer) {
        return data;
    }

    if (ArrayBuffer.isView(data)) {
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    }

    // Blob is not supported by this host — same limitation the reference host
    // carries, and the engine never sends one (every Lunora wire frame is JSON
    // text).
    return new ArrayBuffer(0);
};

/**
 * The socket-host half of a Node platform instance, plus the test-only hooks
 * `@lunora/platform/conformance`'s `ConformanceHost` needs to drive a recycle
 * from inside a test.
 */
export interface NodeSocketHost {
    /** Read back the frames sent to a socket, oldest first, text frames only. */
    readFrames: (handle: SocketHandle) => string[];
    /** Re-create a runtime socket from durable state (post-"recycle"). */
    restoreSocket: (id: string, attachment: unknown) => SocketHandle;
    /** Drop the runtime socket map while keeping durable attachments/tags. */
    simulateRecycle: () => void;
    /** The `SocketHost` contract implementation. */
    socket: SocketHost;
}

/** Build the in-process socket registry. */
export const createNodeSocketHost = (): NodeSocketHost => {
    const runtimeSockets = new Map<string, NodeSocket>();
    const durableAttachments = new Map<string, unknown>();
    const durableTags = new Map<string, Set<string>>();
    const handleIds = new WeakMap<SocketHandle, string>();

    const createHandle = (socketState: NodeSocket): SocketHandle => {
        // Alias so the mutation is on a local binding, not the parameter
        // (no-param-reassign) — same pattern as `@lunora/shard-engine`'s
        // `createGeoBuilder`.
        const state = socketState;
        const handle: SocketHandle = {
            bufferedAmount: state.bufferedAmount,
            close: (_code, _reason) => {
                state.closed = true;
            },
            deserializeAttachment: () => state.attachment,
            send: (data) => {
                state.received.push(typeof data === "string" ? data : toArrayBuffer(data));
            },
            serializeAttachment: (value) => {
                state.attachment = value;
                durableAttachments.set(state.id, value);
            },
        };

        state.handle = handle;
        handleIds.set(handle, state.id);

        return handle;
    };

    let counter = 0;
    const nextId = (): string => {
        counter += 1;

        return `node-socket-${String(counter)}`;
    };

    const socket: SocketHost = {
        accept: (raw, attachment, tags) => {
            const id = nextId();
            const state: NodeSocket = {
                attachment,
                bufferedAmount: 0,
                closed: false,
                handle: undefined as unknown as SocketHandle,
                id,
                raw,
                received: [],
                tags: new Set(tags),
            };

            runtimeSockets.set(id, state);
            durableTags.set(id, new Set(tags));

            if (attachment !== undefined) {
                durableAttachments.set(id, attachment);
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
            const id = handleIds.get(handle);
            const state = id === undefined ? undefined : runtimeSockets.get(id);

            if (state === undefined || id === undefined) {
                return;
            }

            if (tag === undefined) {
                state.tags.clear();
            } else {
                state.tags.delete(tag);
            }

            durableTags.set(id, new Set(state.tags));
        },
        setTag: (handle, tag) => {
            const id = handleIds.get(handle);
            const state = id === undefined ? undefined : runtimeSockets.get(id);

            if (state === undefined || id === undefined) {
                return;
            }

            state.tags.add(tag);
            durableTags.set(id, new Set(state.tags));
        },
    };

    return {
        readFrames: (handle) => (runtimeSockets.get(handleIds.get(handle) ?? "")?.received ?? []).filter((frame): frame is string => typeof frame === "string"),
        restoreSocket: (id, attachment) => {
            const state: NodeSocket = {
                // Prefer this host's OWN durable record over the caller-supplied
                // `attachment` — a real host restores from what it persisted, not
                // from a copy the caller happens to still be holding. Falling back
                // to the argument only covers an id this host never durably
                // tracked (a synthetic id a test constructs directly).
                attachment: durableAttachments.has(id) ? durableAttachments.get(id) : attachment,
                bufferedAmount: 0,
                closed: false,
                handle: undefined as unknown as SocketHandle,
                id,
                raw: undefined,
                received: [],
                tags: new Set(durableTags.get(id)),
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
