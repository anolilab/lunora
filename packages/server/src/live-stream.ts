/**
 * `defineLiveStream` — server side of live topic streams.
 *
 * A live stream lets server code publish an arbitrary event to a named topic
 * (`ctx.live.publish`) and lets a browser follow several of them over ONE
 * Server-Sent Events connection. The subscriber registry is the shard Durable
 * Object, and a live event is delivered only to the SSE subscribers that
 * followed its topic through the publishing stream. WebSocket whisper members
 * never receive one: a whisper join has no stream scope, so it would bypass the
 * stream's `onSubscribe`.
 *
 * It does NOT replace either existing realtime primitive.
 *
 * **Live queries** push the *result of a query* (rows, masked, RLS-scoped) to a
 * subscriber. A live stream carries an arbitrary ad-hoc event — "a comment was
 * posted", "the build finished" — that is not a row and has no query.
 *
 * **Whispers** (`client.whisper`, `onWhisper`) are the same arbitrary-event idea,
 * but only over the WebSocket transport and only for a *client* sender. A live
 * stream is server-published and reaches a browser over SSE, so a page that
 * already holds an SSE connection can follow topics without opening a WebSocket.
 *
 * ```ts
 * // lunora/live.ts
 * import { defineLiveStream } from "@lunora/server";
 *
 * export const posts = defineLiveStream({
 *     id: "posts",
 *     onSubscribe: async ({ ctx, topic }) => {
 *         const [kind, postId] = topic.split(":");
 *         return kind === "post" && (await ctx.runQuery(api.posts.canRead, { postId }));
 *     },
 * });
 *
 * // mount the two routes on the app's http router
 * app.get(posts.connectPath, posts.connect);
 * app.post(posts.controlPath, posts.control);
 *
 * // publish from any HTTP action, on the stream whose subscribers should see it
 * await ctx.live.publish("post:123", { event: "comment_added", commentId }, { stream: posts.id });
 * ```
 *
 * # Authorization defaults to DENY, loudly
 *
 * A topic name is attacker-controlled, and an SSE subscription is a live tap on
 * it. So:
 *
 * - With `onSubscribe` **omitted**, every subscribe is DENIED (an anonymous
 *   caller is admitted only under `allowAnonymousControl`). There is no
 *   implicit "anyone may follow any topic" — that would make a typo in a route
 *   mount an open event bus.
 * - With `onSubscribe` **provided**, the handler decides per topic. Only a
 *   literal `true` allows; anything else — including a forgotten `return` —
 *   denies, and a handler that **throws** denies.
 * - `allowAnonymousControl: true` never bypasses `onSubscribe`. With a handler,
 *   the handler decides for every caller. Without one, it admits an anonymous
 *   caller (no identity) to any topic, and an authenticated caller is still
 *   denied. Set it only for a genuinely public stream (a status page, a public
 *   feed). It is opt-in for exactly the reason above.
 * - A subscription belongs to the stream that authorized it. A publish names its
 *   stream and reaches only that stream's subscribers, so a public stream cannot
 *   tap a topic a private stream granted.
 *
 * # The subscriber registry is a single hot object
 *
 * Subscriber state lives in ONE shard Durable Object per shard key, so a very
 * busy topic is a hot object — every publish scans that object's subscribers.
 * That is the deliberate ceiling of reusing the shard instead of minting a
 * Durable Object per stream id. When throughput matters, shard by key: connect
 * with `?shard=<key>` and publish with `{ shardKey }` so a topic's publishers
 * and subscribers land on the same DO. Cross-DO fan-out is not wired (the relay
 * hub carries no live events), so a publisher that targets the wrong shard
 * reaches no SSE subscriber.
 *
 * # Publish reach
 *
 * `ctx.live.publish` is on the HTTP-action context today. The scheduler and
 * queue action contexts do not carry it yet, so a cron job or a queue consumer
 * cannot publish without going through a route or an action that does.
 */

import { LIVE_CONNECT_PATH, LIVE_CONTROL_PATH } from "../../../shared/live-stream";
import type { HttpActionCtx as HttpActionContext, LunoraRouteHandler } from "./http";
import { httpAction } from "./http";

/**
 * Verdict handler for a live-topic subscribe. Return `true` to allow; anything
 * else denies (and a throw denies).
 */
type LiveSubscribeHandler = (options: { ctx: HttpActionContext; topic: string }) => boolean | Promise<boolean>;

/** Config for {@link defineLiveStream}. */
interface LiveStreamConfig {
    /**
     * Opt-in for a public stream. It never skips {@link LiveStreamConfig.onSubscribe}:
     * when a handler is present, the handler decides for every caller and this flag
     * changes nothing. When `onSubscribe` is omitted, `true` admits an ANONYMOUS
     * caller (no identity) to any topic, and an authenticated caller is still
     * denied. Defaults to `false`. See the module docblock for why the default is deny.
     */
    allowAnonymousControl?: boolean;
    /** Stable id, used to derive {@link LiveStream.connectPath} / {@link LiveStream.controlPath}. */
    id: string;

    /**
     * Per-topic authorization, consulted for every subscribe from every caller.
     * Omitted ⇒ default-deny (unless `allowAnonymousControl` admits anonymous callers).
     */
    onSubscribe?: LiveSubscribeHandler;
}

/** The two route handlers {@link defineLiveStream} produces. */
interface LiveStream {
    /** Mount with `app.get(stream.connectPath, stream.connect)`. Returns the SSE response. */
    connect: LunoraRouteHandler;
    /** `GET` path for the SSE connection. */
    connectPath: string;
    /** Mount with `app.post(stream.controlPath, stream.control)`. Returns a JSON ack. */
    control: LunoraRouteHandler;
    /** `POST` path for subscribe / unsubscribe control. */
    controlPath: string;
    id: string;
}

/** Read and JSON-parse a request body, returning `undefined` on a malformed payload. */
const readJsonBody = async (request: Request): Promise<Record<string, unknown> | undefined> => {
    try {
        const parsed: unknown = await request.json();

        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
    } catch {
        return undefined;
    }
};

const forbidden = (topic: string): Response => Response.json({ code: "FORBIDDEN_TOPIC", error: `subscribe to "${topic}" was denied` }, { status: 403 });

const badRequest = (message: string): Response => Response.json({ code: "BAD_REQUEST", error: message }, { status: 400 });

/**
 * Define a live topic stream. See the module docblock for the authorization
 * defaults and the hot-shard ceiling.
 */
const defineLiveStream = (config: LiveStreamConfig): LiveStream => {
    const connectPath = `/live/${config.id}/connect`;
    const controlPath = `/live/${config.id}/control`;

    const authorize = async (context: HttpActionContext, topic: string): Promise<boolean> => {
        // No handler: the only thing that can admit a caller is the anonymous opt-in, and only for
        // a caller with no identity. `onSubscribe`, when present, is consulted for every caller.
        if (!config.onSubscribe) {
            return config.allowAnonymousControl === true && context.auth.userId === null;
        }

        try {
            // Strict equality, mirroring `onWhisper`: only a literal `true`
            // allows. A handler returning a row, an object, or `undefined` from a
            // forgotten `return` must not open a topic.
            // Read the verdict as `unknown`: an untyped handler can return anything.
            const verdict: unknown = await config.onSubscribe({ ctx: context, topic });

            return verdict === true;
        } catch (error) {
            // Fail closed, but log it: a throw here is a dependency failure, not an intentional denial.
            // eslint-disable-next-line no-console -- log the authorization failure server-side; the client gets only the 403
            console.error("[lunora] live subscribe authorization threw; denying:", error);

            return false;
        }
    };

    // The SSE stream is served by the shard DO (see the module docblock). Opening
    // the connection grants nothing: each topic is authorized on its own
    // subscribe, so a page that connects and never subscribes receives no events.
    const connect = httpAction(async (context, request) => {
        const shardKey = new URL(request.url).searchParams.get("shard") ?? undefined;

        return context.fetchShard(shardKey, LIVE_CONNECT_PATH, { method: "GET" });
    });

    const control = httpAction(async (context, request) => {
        const body = await readJsonBody(request);

        if (!body) {
            return badRequest("Expected a JSON object body");
        }

        const { action } = body;
        const topic = typeof body.topic === "string" ? body.topic : undefined;

        if (topic === undefined || topic.length === 0) {
            return badRequest("topic is required");
        }

        // Publish is deliberately absent: it has its own internal endpoint that only
        // `ctx.live.publish` reaches. Mounted publicly, this route would let any
        // browser write into any stream's topics.
        if (action !== "subscribe" && action !== "unsubscribe") {
            return badRequest("action must be subscribe or unsubscribe");
        }

        const shardKey = typeof body.shardKey === "string" ? body.shardKey : undefined;

        // The verdict reads data through `ctx.run*`, so it must see the shard the topic
        // is served from. The bare `run*` targets the default shard; overlay the trio for the
        // requested one so an `onSubscribe` on a `.shardBy(...)` app checks the right tenant.
        const authorizing: HttpActionContext = shardKey === undefined ? context : { ...context, ...context.forShard(shardKey) };

        if (action === "subscribe" && !(await authorize(authorizing, topic))) {
            return forbidden(topic);
        }

        // The stream is set here, never taken from the body: a subscription is
        // scoped to the stream whose `onSubscribe` granted it (see the module docblock).
        return context.fetchShard(shardKey, LIVE_CONTROL_PATH, { body: JSON.stringify({ ...body, stream: config.id }), method: "POST" });
    });

    return { connect, connectPath, control, controlPath, id: config.id };
};

export { defineLiveStream };
export type { LiveStream, LiveStreamConfig, LiveSubscribeHandler };
