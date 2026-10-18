/**
 * `defineLiveStream` — server side of live topic streams.
 *
 * A live stream lets server code publish an arbitrary event to a named topic
 * (`ctx.live.publish`) and lets a browser follow several of them over ONE
 * Server-Sent Events connection. The subscriber registry is the shard Durable
 * Object, and a live event is delivered only to the SSE subscribers that
 * followed its topic through the publishing stream. A WebSocket whisper member
 * receives one only after the same `onSubscribe` admits it for that stream and
 * topic: the subscribe is posted to the control route with the socket's
 * connection id, which the socket learns from its `identity` frame. A whisper
 * join alone never admits a stream's event.
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
 * import { defineLiveStream, v } from "@lunora/server";
 * import { api } from "./_generated/api";
 *
 * export const posts = defineLiveStream({
 *     id: "posts",
 *     topics: {
 *         // a keyed topic: the wire topic is "post:<postId>"
 *         post: { key: { postId: v.id("posts") }, payload: v.object({ event: v.literal("comment_added"), commentId: v.id("comments") }) },
 *         // a keyless topic: the wire topic is just "feed"
 *         feed: { payload: v.object({ postId: v.id("posts") }) },
 *     },
 *     onSubscribe: async ({ ctx, topic, key }) => topic === "post" && (await ctx.runQuery(api.posts.canRead, { postId: key.postId })),
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
 * - A subscribe is parsed against the stream's declared `topics` BEFORE anything
 *   else runs. A name that is not declared, a wrong number of key segments, a
 *   segment its validator rejects, or a non-canonical spelling is denied with the
 *   same 403 as any other denial, and `onSubscribe` is never called for it. This
 *   holds under `allowAnonymousControl` too. Key segments are percent-encoded, so
 *   a key containing `:` cannot read as a second segment or as another topic.
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
 * and subscribers land on the same DO. Cross-shard fan-out is not wired: a
 * publisher that targets the wrong shard reaches no SSE subscriber. Within one
 * shard, the owner's relays do carry live grants and frames to the WebSocket
 * whisper members they hold.
 *
 * # Publish reach
 *
 * `ctx.live.publish` is on the HTTP-action context and on the action context
 * (a scheduled job runs as an action inside its shard). An action publishes
 * in-process to the subscribers of its own shard, so an omitted `shardKey` means
 * the shard the action runs on, and a `shardKey` naming another shard is refused.
 * A queue consumer has no shard, so its `ctx.live.publish` is forwarded to the
 * shard the publish names, like an HTTP action's. Unlike an HTTP action's, that
 * publish is not checked against a caller: a queue consumer is trusted worker
 * code with no client behind it. A consumer must not pass a `shardKey` taken
 * from a client-supplied message body without checking it itself, or any message
 * can publish into any shard.
 *
 * A retried action (an at-least-once scheduler re-fire) publishes again: a
 * subscriber can see the same event twice, so make the payload idempotent on its
 * own id if that matters.
 */

import { isLunoraError, LunoraError } from "@lunora/errors";
import type { Infer, Validator } from "@lunora/values";
import { parseValidatorMap } from "@lunora/values";

import {
    isLiveIdentifier,
    isReservedLiveTopicName,
    LIVE_CONNECT_PATH,
    LIVE_CONTROL_PATH,
    liveConnectPath,
    liveControlPath,
    parseLiveTopic,
} from "../../../shared/live-stream";
import type { HttpActionCtx as HttpActionContext, LunoraRouteHandler } from "./http";
import { httpAction } from "./http";

/** One declared topic: the key that addresses it (string-valued fields, in order) and the payload it carries. */
interface LiveTopicDeclaration {
    /** Absent for a keyless topic, whose wire topic is just its name. Every value is a string on the wire. */
    key?: Readonly<Record<string, Validator<string>>>;
    payload: Validator;
}

/** The `topics` map of a {@link LiveStreamConfig}. */
type LiveTopics = Readonly<Record<string, LiveTopicDeclaration>>;

/** The key a topic is addressed by, as the validators infer it. A keyless topic has an empty key. */
type LiveTopicKey<Topic extends LiveTopicDeclaration> =
    Topic["key"] extends Readonly<Record<string, Validator>>
        ? { readonly [Field in keyof Topic["key"]]: Infer<Topic["key"][Field]> }
        : Readonly<Record<string, never>>;

/** The payload a topic carries, as its validator infers it. */
type LiveTopicPayload<Topic extends LiveTopicDeclaration> = Infer<Topic["payload"]>;

/** What `onSubscribe` receives: the parsed topic, narrowed by declaration so `key` matches `topic`. */
type LiveSubscribeOptions<Topics extends LiveTopics> = {
    [Name in keyof Topics & string]: {
        ctx: HttpActionContext;
        key: LiveTopicKey<Topics[Name]>;
        /** The wire topic exactly as the browser sent it. */
        raw: string;
        topic: Name;
    };
}[keyof Topics & string];

/**
 * Verdict handler for a live-topic subscribe. Return `true` to allow; anything
 * else denies (and a throw denies). It is only called for a topic that parsed
 * against the stream's declaration.
 */
type LiveSubscribeHandler<Topics extends LiveTopics = LiveTopics> = (options: LiveSubscribeOptions<Topics>) => boolean | Promise<boolean>;

/** Config for {@link defineLiveStream}. */
interface LiveStreamConfig<Topics extends LiveTopics = LiveTopics> {
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
    onSubscribe?: LiveSubscribeHandler<Topics>;

    /**
     * The topics this stream carries, by name. A subscribe or publish naming anything
     * else is refused. A topic with a `key` is addressed as `name:<key values>`; one
     * without is addressed by its name alone.
     */
    topics: Topics;
}

/** The two route handlers {@link defineLiveStream} produces, plus the declaration they enforce. */
interface LiveStream<Topics extends LiveTopics = LiveTopics> {
    /** Mount with `app.get(stream.connectPath, stream.connect)`. Returns the SSE response. */
    connect: LunoraRouteHandler;
    /** `GET` path for the SSE connection. */
    connectPath: string;
    /** Mount with `app.post(stream.controlPath, stream.control)`. Returns a JSON ack. */
    control: LunoraRouteHandler;
    /** `POST` path for subscribe / unsubscribe control. */
    controlPath: string;
    id: string;
    readonly topics: Topics;

    /**
     * Check a publish against the declaration: the wire `topic` must be a declared
     * topic in its canonical spelling and `payload` must satisfy its validator.
     * @throws LunoraError `BAD_REQUEST` (400) when either does not
     */
    validatePublish: (topic: string, payload: unknown) => void;
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

const STRING_KEY_KINDS: ReadonlySet<string> = new Set(["id", "literal", "string", "union"]);

/** Reject a declaration whose topics could not be told apart on the wire, or could never be published. */
const assertDeclaration = (id: string, topics: LiveTopics): void => {
    for (const [name, topic] of Object.entries(topics)) {
        if (!isLiveIdentifier(name)) {
            throw new TypeError(`defineLiveStream("${id}"): topic name "${name}" must be a plain identifier (letters, digits and "_", starting with a letter)`);
        }

        // `room:` and the socket prefix are the reserved topic spaces. A publish refuses them with FORBIDDEN_TOPIC, so a
        // topic declared there would fail only at runtime.
        if (isReservedLiveTopicName(name)) {
            throw new TypeError(`defineLiveStream("${id}"): topic name "${name}" would encode into a reserved topic prefix`);
        }

        for (const [field, validator] of Object.entries(topic.key ?? {})) {
            if (!isLiveIdentifier(field)) {
                throw new TypeError(`defineLiveStream("${id}"): key field "${name}.${field}" must be a plain identifier`);
            }

            // A key segment is a string on the wire. A validator of another kind would deny every subscribe, silently.
            if (!STRING_KEY_KINDS.has(validator.kind)) {
                throw new TypeError(`defineLiveStream("${id}"): key field "${name}.${field}" must be a string validator (v.string(), v.id(), v.literal(…))`);
            }
        }
    }
};

const badPayload = (topic: string, error: unknown): LunoraError =>
    new LunoraError("BAD_REQUEST", `publish to "${topic}" was refused: ${error instanceof Error ? error.message : String(error)}`, { status: 400 });

/**
 * Define a live topic stream. See the module docblock for the authorization
 * defaults and the hot-shard ceiling.
 *
 * Two limits to know before you ship. First, a subscription is authorized once,
 * at subscribe, and is not re-checked while the connection stays open: a
 * credential with an expiry ends the stream at that expiry, and a cookie session
 * with no expiry keeps receiving until the client closes the connection or
 * reconnects. Second, live streams are unavailable when delivery authorization is
 * enabled. Codegen refuses an app that declares a live stream and also calls
 * `.deliveryAuthorization(...)`, because the shard answers every `/_lunora/live/*`
 * route with 501 in that mode.
 */
const defineLiveStream = <const Topics extends LiveTopics>(config: LiveStreamConfig<Topics>): LiveStream<Topics> => {
    assertDeclaration(config.id, config.topics);

    const connectPath = liveConnectPath(config.id);
    const controlPath = liveControlPath(config.id);
    const fieldsByTopic: Record<string, ReadonlyArray<string>> = Object.fromEntries(
        Object.entries(config.topics as LiveTopics).map(([name, topic]) => [name, Object.keys(topic.key ?? {})]),
    );

    /** The declared `(name, key)` behind a wire topic, or `undefined` when it is not one this stream carries. */
    const parseTopic = (raw: string): undefined | { declaration: LiveTopicDeclaration; key: Record<string, string>; name: string } => {
        const parsed = parseLiveTopic(raw, fieldsByTopic);
        const declared = parsed === undefined ? undefined : (config.topics as LiveTopics)[parsed.name];

        if (parsed === undefined || declared === undefined) {
            return undefined;
        }

        try {
            // The segments are strings on the wire; each must also satisfy its declared validator (an id of the right table, a literal).
            return { declaration: declared, key: parseValidatorMap(declared.key ?? {}, parsed.key, "key") as Record<string, string>, name: parsed.name };
        } catch {
            return undefined;
        }
    };

    const validatePublish = (topic: string, payload: unknown): void => {
        const parsed = parseTopic(topic);

        if (parsed === undefined) {
            throw new LunoraError("BAD_REQUEST", `"${topic}" is not a topic declared by live stream "${config.id}"`, { status: 400 });
        }

        const { declaration } = parsed;

        try {
            parseValidatorMap({ payload: declaration.payload }, { payload }, "topic");
        } catch (error) {
            throw badPayload(topic, error);
        }
    };

    const authorize = async (context: HttpActionContext, raw: string): Promise<boolean> => {
        // The raw topic is attacker-controlled: nothing, `onSubscribe` included, sees it until it parses as a declared topic.
        const parsed = parseTopic(raw);

        if (parsed === undefined) {
            return false;
        }

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
            const verdict: unknown = await config.onSubscribe({ ctx: context, key: parsed.key, raw, topic: parsed.name } as LiveSubscribeOptions<Topics>);

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
        const forwarded = context.fetchShard(shardKey, LIVE_CONTROL_PATH, { body: JSON.stringify({ ...body, stream: config.id }), method: "POST" });

        if (action !== "subscribe") {
            return forwarded;
        }

        // A subscribe naming a shard the caller may not address is refused by the
        // runtime's shard gate. An `onSubscribe` that swallows that refusal and returns
        // `true` reaches here, so the refusal must read as the same denial a topic gets:
        // the reply must not distinguish a refused shard from a denied topic.
        try {
            return await forwarded;
        } catch (error) {
            if (isLunoraError(error) && error.code === "FORBIDDEN_SHARD") {
                return forbidden(topic);
            }

            throw error;
        }
    });

    return { connect, connectPath, control, controlPath, id: config.id, topics: config.topics, validatePublish };
};

export { defineLiveStream };
export type { LiveStream, LiveStreamConfig, LiveSubscribeHandler, LiveSubscribeOptions, LiveTopicDeclaration, LiveTopicKey, LiveTopicPayload, LiveTopics };

export { type LiveTopicRef } from "../../../shared/live-stream";
