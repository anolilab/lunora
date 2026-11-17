/**
 * `defineRoom` — typed, stateful real-time rooms over the shard's existing
 * WebSocket transport.
 *
 * A room is a TYPED LAYER over the AnyCable-style whisper channel
 * (`whisper_subscribe` / `whisper_unsubscribe` / `whisper`) that the shard
 * already implements — there is no new Durable Object and no new upgrade route.
 * Membership rides a whisper topic derived from the room name
 * (`room:<name>`), fan-out reuses `broadcastWhisper`'s
 * per-topic delivery (including the multi-DO relay), and authorization reuses
 * the existing `onWhisper` authorizer seam plus the socket identity resolved at
 * upgrade. What this adds is a SERVER-SIDE handler: when a socket joins, leaves,
 * or sends to a room topic, the shard dispatches the room's registered
 * callback under the socket's verified identity, with the message validated
 * against the room's `v` validator.
 *
 * ```ts
 * // lunora/rooms.ts
 * import { defineRoom, v } from "@lunora/server";
 *
 * export const chat = defineRoom({
 *     name: "chat",
 *     message: v.object({ text: v.string(), author: v.string() }),
 *     onJoin: async (ctx, socket) => {
 *         await ctx.db.insert("messages", { text: `${socket.userId ?? "someone"} joined` });
 *     },
 *     onMessage: async (ctx, message, socket) => {
 *         // Persist, then fan the typed message out to every member (including
 *         // the sender) — the room's own broadcast helper.
 *         socket.broadcast({ text: message.text, author: message.author });
 *     },
 * });
 *
 * // lunch.ts — re-export the rooms you want codegen to wire.
 * export { chat } from "./rooms";
 * ```
 *
 * The client joins the SAME topic through `connectRoom(rooms.chat)`, which wraps the
 * ordinary whisper surface.
 *
 * # It is a mutation, and it is dispatched like a lifecycle hook
 *
 * `onJoin`/`onMessage`/`onLeave` run as an internal **mutation** — so they get
 * `ctx.db` on the shard's SQLite (room state lives there, keyed by whatever the
 * handler writes; there is no per-room Durable Object), a BEGIN/COMMIT span, and
 * the deferred-schedule/deferred-delete guarantees any mutation has. The shard
 * dispatches it under the socket's verified identity (`ctx.auth` is the
 * connecting user, `ctx.db` is RLS-scoped to them) via a trusted system
 * dispatch, exactly as `onConnect`/`onDisconnect`/`onWhisper` are. A handler
 * that throws is logged and swallowed — a broken room handler must not take the
 * socket down.
 *
 * # Authorization reuses `onWhisper`
 *
 * There is no separate token or auth scheme. A socket may join a room topic only
 * if the app's `onWhisper` authorizer allows the `subscribe` action on it, and
 * may send only if it allows the `send` action — the same check every other
 * topic gets, running under the connecting user's identity. With no `onWhisper`
 * export the topic keeps today's default-allow behaviour, exactly as for any
 * other whisper topic.
 */

import type { Infer, Validator } from "@lunora/values";
import { parseValidatorMap } from "@lunora/values";

import type { MutationCtx as MutationContext, RegisteredFunction } from "./types";

/**
 * The per-socket handle a room handler receives. Mirrors the identity fields of
 * a connection-lifecycle event and adds the room's own broadcast helper.
 */
interface RoomSocket<Message = unknown> {
    /**
     * Broadcast a typed `message` to EVERY socket in the room — the sender
     * included, since the server handler is authoritative and its payload (not
     * the client's raw send) is what members should see. A broadcast queued by
     * `onJoin` goes to the members already in the room, not to the socket that
     * is joining. The value is
     * wire-encoded before it leaves the DO, so `bigint` / bytes survive.
     *
     * Synchronous and best-effort: local delivery happens inline and the
     * cross-DO relay hop is fire-and-forget, matching `broadcastWhisper`.
     */
    broadcast: (message: Message) => void;
    /** Stable per-socket id, the same one `onConnect` saw. */
    readonly connectionId: string;
    /** App-supplied connection context from the client `connect` envelope. */
    readonly context?: Record<string, unknown>;
    /** The shard this socket is bound to. */
    readonly shardKey: string;
    /** Verified user id resolved at upgrade, or `null` for an anonymous socket. */
    readonly userId: null | string;
}

/** Handler for a socket joining a room. */
type RoomJoinHandler<Message = unknown> = (context: MutationContext, socket: RoomSocket<Message>) => Promise<void> | void;

/** Handler for a socket leaving a room. */
type RoomLeaveHandler<Message = unknown> = (context: MutationContext, socket: RoomSocket<Message>) => Promise<void> | void;

/** Handler for one typed message on a room; `message` is validated against the room's validator. */
type RoomMessageHandler<Message> = (context: MutationContext, message: Message, socket: RoomSocket<Message>) => Promise<void> | void;

/** Options for {@link defineRoom}. */
interface DefineRoomOptions<Message extends Validator> {
    /** The room's message validator. Every inbound message is parsed against it before `onMessage`. */
    message: Message;
    /** Room name; the wire topic is `room:<name>`. Must be non-empty. */
    name: string;
    /** Fired after a socket's join to the room topic is authorized and recorded. */
    onJoin?: RoomJoinHandler<Infer<Message>>;
    /** Fired when a socket leaves the room topic. Never authorization-gated. */
    onLeave?: RoomLeaveHandler<Infer<Message>>;
    /** Fired for each inbound message, with the message parsed against `message`. */
    onMessage: RoomMessageHandler<Infer<Message>>;
}

/**
 * The dispatch payload the shard hands a room registration. `kind`
 * discriminates the three lifecycle moments; `socket` is the per-socket handle
 * (its `broadcast` closes over the room topic on the DO side).
 */
interface RoomDispatchEvent {
    kind: "join" | "leave" | "message";
    message?: unknown;
    socket: RoomSocket;
}

/**
 * A registered room — an internal mutation tagged with its `channel`, so codegen
 * emits it into `LUNORA_FUNCTIONS` (path dispatch) and derives the generated
 * `LUNORA_ROOMS` topic→path map the shard resolves a room topic through.
 *
 * `Message` is the room's message type, carried type-only (`__roomMessage` is
 * never set at runtime). The generated room references read it back through
 * {@link RoomMessageOf}, so a client's `connectRoom` is typed from the room itself.
 */
type RegisteredRoom<Message = unknown> = RegisteredFunction<Record<string, never>, void, "mutation"> & {
    readonly __roomMessage?: Message;
    readonly channel: { readonly kind: "room"; readonly name: string };
};

/** The message type a {@link RegisteredRoom} carries. */
type RoomMessageOf<Room> = Room extends RegisteredRoom<infer Message> ? Message : never;

/**
 * Declare a typed room. See the module docblock for the transport it rides, the
 * dispatch model, and the authorization path.
 * @throws {TypeError} when `name` is empty — an empty override would make the
 * room topic collidable and the `LUNORA_ROOMS` map ambiguous.
 */
const defineRoom = <Message extends Validator>(options: DefineRoomOptions<Message>): RegisteredRoom<Infer<Message>> => {
    const { message, name, onJoin, onLeave, onMessage } = options;

    if (typeof name !== "string" || name.length === 0) {
        throw new TypeError("defineRoom: `name` must be a non-empty string");
    }

    return {
        args: {},
        // The dispatch payload is framework-built (the shard supplies the socket
        // handle, which is not serializable and never crosses a validator), so
        // the handler takes `unknown` and narrows — mirroring `wrapLifecycle`.
        handler: async (context: unknown, event: unknown): Promise<void> => {
            const { kind, message: raw, socket } = event as RoomDispatchEvent;

            if (kind === "join") {
                await onJoin?.(context as MutationContext, socket);

                return;
            }

            if (kind === "leave") {
                await onLeave?.(context as MutationContext, socket);

                return;
            }

            // Parse the message with the shared field-parser so the room gets the
            // same `ValidationError` shape (and the same optional-skip semantics)
            // every procedure arg validation gets. The framework-fixed dispatch
            // wrapper is bypassed here, so this is the ONE validation site.
            const { message: parsed } = parseValidatorMap({ message }, { message: raw }, "message");

            await onMessage(context as MutationContext, parsed as Infer<Message>, socket);
        },
        channel: { kind: "room", name },
        kind: "mutation",
        visibility: "internal",
    };
};

export type { DefineRoomOptions, RegisteredRoom, RoomJoinHandler, RoomLeaveHandler, RoomMessageHandler, RoomMessageOf, RoomSocket };
export { defineRoom };
