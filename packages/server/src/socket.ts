/**
 * `defineWebSocket` — typed, user-declared WebSocket endpoints at a custom path.
 *
 * A `defineWebSocket` route is a TYPED LAYER over the shard's existing socket
 * transport. The worker recognises the declared `path`, upgrades the connection
 * there, and forwards it to the shard's Durable Object — the SAME DO every
 * subscription, whisper, and room already runs on, so no new Durable Object, no
 * new token scheme, and no second socket registry are introduced. Every socket
 * that lands on the same path forms one channel: an inbound frame is decoded and
 * dispatched to the route's server-side `onMessage` under the socket's verified
 * identity, and the handler replies with `socket.send` (one socket) or
 * `socket.broadcast` (every socket on the path, across Durable Objects).
 *
 * ```ts
 * // lunora/sockets.ts
 * import { defineWebSocket, v } from "@lunora/server";
 *
 * export const chatSocket = defineWebSocket({
 *     path: "/chat",
 *     message: v.object({ text: v.string() }),
 *     onOpen: async (ctx, socket) => {
 *         socket.broadcast({ text: `${socket.userId ?? "someone"} joined` });
 *     },
 *     onMessage: (ctx, message, socket) => {
 *         socket.broadcast({ text: message.text });
 *     },
 * });
 *
 * // lunch.ts — re-export the routes you want codegen to wire.
 * export { chatSocket } from "./sockets";
 * ```
 *
 * The client opens the SAME path with `client.connectWebSocket("/chat", { … })`.
 *
 * # It is a mutation, and it is dispatched like a lifecycle hook
 *
 * `onOpen`/`onMessage`/`onClose` run as an internal **mutation** — so they get
 * `ctx.db` on the shard's SQLite, a BEGIN/COMMIT span, and the
 * deferred-schedule/deferred-delete guarantees any mutation has. The shard
 * dispatches them under the socket's verified identity (`ctx.auth` is the
 * connecting user, `ctx.db` is RLS-scoped to them) via a trusted system
 * dispatch, exactly as `onConnect`/`onWhisper`/`defineRoom` handlers are. A
 * handler that throws is logged and swallowed — a broken socket handler must not
 * take the connection down.
 *
 * # Authorization reuses the identity resolved at upgrade
 *
 * There is no separate token scheme: the worker resolves the caller's session
 * (`resolveIdentity`) before the upgrade is forwarded, and the shard stamps the
 * verified `userId`/identity onto the socket exactly as it does for a
 * subscription or room socket. With `auth: true` the shard refuses an anonymous
 * upgrade outright, so a route meant only for signed-in users never opens for
 * anyone else; the default allows anonymous sockets, matching every other
 * socket surface.
 *
 * # Hibernation
 *
 * The route's function path is persisted on the socket's
 * `SocketAttachment`, so a hibernated socket that wakes on a frame still
 * resolves its handler and its broadcast channel without a per-connection
 * registry. An idle socket costs nothing.
 */

import type { Infer, Validator } from "@lunora/values";
import { parseValidatorMap } from "@lunora/values";

import type { MutationCtx as MutationContext, RegisteredFunction } from "./types";

/**
 * The per-socket handle a `defineWebSocket` handler receives. Mirrors the
 * identity fields of a connection-lifecycle event and adds the route's own send
 * and broadcast helpers.
 */
interface WebSocketHandle {
    /**
     * Broadcast a typed `message` to EVERY socket on this route — the sender
     * included, since the server handler is authoritative and its payload (not
     * the client's raw frame) is what members should see. The value is
     * wire-encoded before it leaves the DO, so `bigint` / bytes survive.
     *
     * Synchronous and best-effort: local delivery happens inline and the
     * cross-DO relay hop is fire-and-forget, matching `broadcastWhisper`.
     */
    broadcast: (message: unknown) => void;
    /** Stable per-socket id, the same one `onConnect` saw. */
    readonly connectionId: string;
    /** The declared route path this socket was opened on. */
    readonly path: string;

    /**
     * Send a typed `message` to THIS socket only. Wire-encoded like
     * {@link WebSocketHandle.broadcast}.
     */
    send: (message: unknown) => void;
    /** The shard this socket is bound to. */
    readonly shardKey: string;
    /** Verified user id resolved at upgrade, or `null` for an anonymous socket. */
    readonly userId: null | string;
}

/** Handler fired once per socket, right after a successful upgrade. */
type WebSocketOpenHandler = (context: MutationContext, socket: WebSocketHandle) => Promise<void> | void;

/** Handler fired once per socket, when it closes. */
type WebSocketCloseHandler = (context: MutationContext, socket: WebSocketHandle) => Promise<void> | void;

/** Handler for one typed message on a route; `message` is validated against the route's validator. */
type WebSocketMessageHandler<Message> = (context: MutationContext, message: Message, socket: WebSocketHandle) => Promise<void> | void;

/** Options for {@link defineWebSocket}. */
interface DefineWebSocketOptions<Message extends Validator> {
    /**
     * Require a verified session to open the socket. When `true` the shard
     * refuses an anonymous upgrade; the default (`false`) allows anonymous
     * sockets, exactly like every other socket surface.
     */
    auth?: boolean;
    /** The route's message validator. Every inbound frame is parsed against it before `onMessage`. */
    message: Message;
    /** Fired when a socket closes, with the identity it opened under. */
    onClose?: WebSocketCloseHandler;
    /** Fired for each inbound frame, with the message parsed against `message`. */
    onMessage: WebSocketMessageHandler<Infer<Message>>;
    /** Fired once after a socket's upgrade is accepted and recorded. */
    onOpen?: WebSocketOpenHandler;
    /** The URL path the route serves, e.g. `"/chat"`. Must be non-empty and start with `/`. */
    path: string;
}

/**
 * The dispatch payload the shard hands a socket registration. `kind`
 * discriminates the three moments; `socket` is the per-socket handle (its
 * `send`/`broadcast` close over the DO side).
 */
interface WebSocketDispatchEvent {
    kind: "close" | "message" | "open";
    message?: unknown;
    socket: WebSocketHandle;
}

/**
 * A registered WebSocket route — an internal mutation tagged `lifecycle:
 * "socket"` with its `socketPath` and `auth` requirement, so codegen derives the
 * generated `LUNORA_SOCKETS` path→registration map the shard resolves an
 * upgraded socket through.
 */
type RegisteredWebSocket = RegisteredFunction<Record<string, never>, void, "mutation"> & {
    /** `true` when the route refuses anonymous upgrades. */
    readonly auth: boolean;
    readonly lifecycle: "socket";
    readonly socketPath: string;
};

/**
 * Declare a typed WebSocket endpoint. See the module docblock for the transport
 * it rides, the dispatch model, and the authorization path.
 * @throws {TypeError} when `path` is empty or does not start with `/` — an
 * empty or relative path would be unroutable and could shadow an app route.
 */
const defineWebSocket = <Message extends Validator>(options: DefineWebSocketOptions<Message>): RegisteredWebSocket => {
    const { auth = false, message, onClose, onMessage, onOpen, path } = options;

    // The worker matches the declared string against the request's parsed pathname, so a
    // path that parsing would change (a query or fragment, `..` segments, unencoded
    // characters) could never match. Require the path to be its own pathname.
    if (typeof path !== "string" || !path.startsWith("/") || new URL(path, "https://lunora.invalid").pathname !== path) {
        throw new TypeError("defineWebSocket: `path` must be a plain URL path starting with `/` (no `?`, `#`, `..` or unencoded characters)");
    }

    return {
        args: {},
        auth,
        // The dispatch payload is framework-built (the shard supplies the socket
        // handle, which is not serializable and never crosses a validator), so
        // the handler takes `unknown` and narrows — mirroring `wrapLifecycle`.
        handler: async (context: unknown, event: unknown): Promise<void> => {
            const { kind, message: raw, socket } = event as WebSocketDispatchEvent;

            if (kind === "open") {
                await onOpen?.(context as MutationContext, socket);

                return;
            }

            if (kind === "close") {
                await onClose?.(context as MutationContext, socket);

                return;
            }

            // Parse the message with the shared field-parser so the route gets the
            // same `ValidationError` shape (and the same optional-skip semantics)
            // every procedure arg validation gets. The framework-fixed dispatch
            // wrapper is bypassed here, so this is the ONE validation site.
            const { message: parsed } = parseValidatorMap({ message }, { message: raw }, "message");

            await onMessage(context as MutationContext, parsed as Infer<Message>, socket);
        },
        kind: "mutation",
        lifecycle: "socket",
        socketPath: path,
        visibility: "internal",
    };
};

export type { DefineWebSocketOptions, RegisteredWebSocket, WebSocketCloseHandler, WebSocketHandle, WebSocketMessageHandler, WebSocketOpenHandler };
export { defineWebSocket };
