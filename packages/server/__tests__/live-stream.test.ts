import { LunoraError } from "@lunora/errors";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import type { HttpActionCtx as HttpActionContext, LiveTopicPayload, LiveTopicRef, LunoraRouteHandler, ShardFetch } from "../src/index";
import { defineLiveStream, httpRouter, v } from "../src/index";

interface ShardCall {
    init: { body?: string; method?: string } | undefined;
    path: string;
    shardKey: string | undefined;
}

type ShardRunners = ReturnType<HttpActionContext["forShard"]>;

const makeContext = (calls: ShardCall[], respond?: (path: string) => Response): HttpActionContext => {
    const fetchShard: ShardFetch = (shardKey, path, init) => {
        calls.push({ init, path, shardKey });

        return Promise.resolve(respond ? respond(path) : new Response("forwarded"));
    };

    // Anonymous by default; an authenticated caller is built with `asUser`.
    return { auth: { getIdentity: () => Promise.resolve(null), userId: null }, fetchShard } as unknown as HttpActionContext;
};

const asUser = (context: HttpActionContext, userId: string): HttpActionContext => {
    return { ...context, auth: { getIdentity: () => Promise.resolve({ sub: userId }), userId } };
};

const dispatch = async (route: LunoraRouteHandler, context: HttpActionContext, method: string, path: string, body?: unknown): Promise<Response> => {
    const app = httpRouter();

    // Mount on the pathname; the query string rides the request URL.
    app.on(method, path.split("?")[0] ?? path, route);

    return app.fetch(
        new Request(`https://x${path}`, {
            body: body === undefined ? undefined : JSON.stringify(body),
            headers: body === undefined ? undefined : { "content-type": "application/json" },
            method,
        }),
        { __lunoraCtx: context },
    );
};

const topics = {
    feed: { payload: v.null() },
    post: { key: { postId: v.string() }, payload: v.object({ text: v.string() }) },
    private: { key: { id: v.string() }, payload: v.null() },
};

describe("defineLiveStream", () => {
    it("derives its connect + control paths from the id", () => {
        expect.assertions(2);

        const stream = defineLiveStream({ topics, id: "posts" });

        expect(stream.connectPath).toBe("/live/posts/connect");
        expect(stream.controlPath).toBe("/live/posts/control");
    });

    it("forwards the connect without granting any topic, whatever the query string names", async () => {
        expect.assertions(2);

        const calls: ShardCall[] = [];
        const stream = defineLiveStream({ topics, id: "posts", onSubscribe: () => true });
        const context = makeContext(calls);

        await dispatch(stream.connect, context, "GET", "/live/posts/connect?topics=post:1&shard=s1");

        expect(calls).toHaveLength(1);
        // Authorization is per subscribe; the connect carries no topic list at all.
        expect(calls[0]).toEqual({ init: { method: "GET" }, path: "/_lunora/live/connect", shardKey: "s1" });
    });

    it("returns the shard's SSE response untouched", async () => {
        expect.assertions(1);

        const stream = defineLiveStream({ topics, allowAnonymousControl: true, id: "posts" });
        const context = makeContext([], () => new Response("event: live\n\ndata: 1\n\n", { headers: { "content-type": "text/event-stream" } }));

        const response = await dispatch(stream.connect, context, "GET", "/live/posts/connect");

        await expect(response.text()).resolves.toBe("event: live\n\ndata: 1\n\n");
    });

    it("defaults to DENY when onSubscribe is omitted", async () => {
        expect.assertions(2);

        const calls: ShardCall[] = [];
        const stream = defineLiveStream({ topics, id: "posts" });
        const context = makeContext(calls);

        const response = await dispatch(stream.control, context, "POST", "/live/posts/control", {
            action: "subscribe",
            connectionId: "c1",
            subscriptionId: "s1",
            topic: "post:1",
        });

        expect(response.status).toBe(403);
        // A denied subscribe never reaches the shard.
        expect(calls).toHaveLength(0);
    });

    it("forwards an allowed subscribe to the control endpoint", async () => {
        expect.assertions(2);

        const calls: ShardCall[] = [];
        const stream = defineLiveStream({ topics, id: "posts", onSubscribe: () => true });
        const context = makeContext(calls);

        const response = await dispatch(stream.control, context, "POST", "/live/posts/control", {
            action: "subscribe",
            connectionId: "c1",
            subscriptionId: "s1",
            topic: "post:1",
        });

        expect(response.status).toBe(200);
        expect(calls[0]).toEqual({
            init: { body: JSON.stringify({ action: "subscribe", connectionId: "c1", subscriptionId: "s1", topic: "post:1", stream: "posts" }), method: "POST" },
            path: "/_lunora/live/control",
            shardKey: undefined,
        });
    });

    it("does not authorize an unsubscribe", async () => {
        expect.assertions(1);

        const calls: ShardCall[] = [];
        const onSubscribe = vi.fn<() => boolean>(() => false);
        const stream = defineLiveStream({ topics, id: "posts", onSubscribe });
        const context = makeContext(calls);

        // A revoked member must still be able to leave.
        await dispatch(stream.control, context, "POST", "/live/posts/control", {
            action: "unsubscribe",
            connectionId: "c1",
            subscriptionId: "s1",
            topic: "post:1",
        });

        expect(onSubscribe).not.toHaveBeenCalled();
    });

    it("refuses a subscribe naming a shard the caller may not address with the same body as a denied topic", async () => {
        expect.assertions(4);

        const calls: ShardCall[] = [];
        // The runtime refuses the shard run before the system-trusted read.
        const refused = new LunoraError("FORBIDDEN_SHARD", "Forbidden shard", { status: 403 });
        const runQuery = vi.fn<HttpActionContext["runQuery"]>(() => Promise.reject(refused));
        const forShard = vi.fn<HttpActionContext["forShard"]>(
            () =>
                ({
                    runAction: vi.fn<HttpActionContext["runAction"]>(),
                    runMutation: vi.fn<HttpActionContext["runMutation"]>(),
                    runQuery,
                }) as unknown as ShardRunners,
        );
        const context = { ...makeContext(calls), forShard } as unknown as HttpActionContext;
        const stream = defineLiveStream({
            topics,
            id: "posts",
            onSubscribe: async ({ ctx }) => {
                await ctx.runQuery({ __lunoraRef: "messages:list" } as never, {});

                return true;
            },
        });

        const response = await dispatch(stream.control, context, "POST", "/live/posts/control", {
            action: "subscribe",
            shardKey: "victim-shard",
            topic: "post:1",
        });

        expect(forShard).toHaveBeenCalledWith("victim-shard");
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toEqual({ code: "FORBIDDEN_TOPIC", error: 'subscribe to "post:1" was denied' });
        expect(calls).toHaveLength(0);
    });

    it("answers a shard refusal the onSubscribe swallowed with the same denial as a denied topic", async () => {
        expect.assertions(3);

        const refused = new LunoraError("FORBIDDEN_SHARD", "Forbidden shard", { status: 403 });
        // The app catches the refused read and returns `true` anyway. The shard
        // control call is then refused by `fetchShard`, which must not leak `FORBIDDEN_SHARD`.
        const swallowing = defineLiveStream({ topics, id: "posts", onSubscribe: () => true });
        const denied = defineLiveStream({ topics, id: "posts", onSubscribe: () => false });
        const refusingShard: ShardFetch = () => Promise.reject(refused);
        // The swallowed `onSubscribe` makes no read that refuses, so `forShard` resolves.
        const forShard = vi.fn<HttpActionContext["forShard"]>(
            () =>
                ({
                    runAction: vi.fn<HttpActionContext["runAction"]>(),
                    runMutation: vi.fn<HttpActionContext["runMutation"]>(),
                    runQuery: vi.fn<HttpActionContext["runQuery"]>(),
                }) as unknown as ShardRunners,
        );
        const context = {
            auth: { getIdentity: () => Promise.resolve(null), userId: null },
            fetchShard: refusingShard,
            forShard,
        } as unknown as HttpActionContext;
        const body = { action: "subscribe", shardKey: "victim-shard", topic: "post:1" };

        const swallowed = await dispatch(swallowing.control, context, "POST", "/live/posts/control", body);
        const deniedTopic = await dispatch(denied.control, context, "POST", "/live/posts/control", body);

        expect(swallowed.status).toBe(403);
        expect(deniedTopic.status).toBe(403);
        await expect(swallowed.json()).resolves.toEqual(await deniedTopic.json());
    });

    it("consults onSubscribe for an authenticated caller even when allowAnonymousControl is true", async () => {
        expect.assertions(2);

        const calls: ShardCall[] = [];
        const onSubscribe = vi.fn<() => boolean>(() => false);
        const stream = defineLiveStream({ topics, allowAnonymousControl: true, id: "posts", onSubscribe });

        const response = await dispatch(stream.control, asUser(makeContext(calls), "user-1"), "POST", "/live/posts/control", {
            action: "subscribe",
            connectionId: "c1",
            subscriptionId: "s1",
            topic: "private:1",
        });

        expect(response.status).toBe(403);
        expect(calls).toHaveLength(0);
    });

    it("consults onSubscribe for an anonymous caller even when allowAnonymousControl is true", async () => {
        expect.assertions(2);

        const calls: ShardCall[] = [];
        const onSubscribe = vi.fn<() => boolean>(() => false);
        const stream = defineLiveStream({ topics, allowAnonymousControl: true, id: "posts", onSubscribe });

        const response = await dispatch(stream.control, makeContext(calls), "POST", "/live/posts/control", {
            action: "subscribe",
            connectionId: "c1",
            subscriptionId: "s1",
            topic: "private:1",
        });

        expect(response.status).toBe(403);
        expect(onSubscribe).toHaveBeenCalledTimes(1);
    });

    it("admits only an anonymous caller when allowAnonymousControl is true and onSubscribe is omitted", async () => {
        expect.assertions(2);

        const stream = defineLiveStream({ topics, allowAnonymousControl: true, id: "posts" });
        const body = { action: "subscribe", connectionId: "c1", subscriptionId: "s1", topic: "feed" };

        const anonymous = await dispatch(stream.control, makeContext([]), "POST", "/live/posts/control", body);
        const authenticated = await dispatch(stream.control, asUser(makeContext([]), "user-1"), "POST", "/live/posts/control", body);

        expect(anonymous.status).toBe(200);
        expect(authenticated.status).toBe(403);
    });

    it("denies a handler that returns a truthy value other than a literal true", async () => {
        expect.assertions(1);

        // A row, an object or a truthy string must not open a topic: only `true` allows.
        const stream = defineLiveStream({ topics, id: "posts", onSubscribe: () => ({ id: "post:1" }) as unknown as boolean });
        const context = makeContext([]);

        const response = await dispatch(stream.control, context, "POST", "/live/posts/control", {
            action: "subscribe",
            connectionId: "c1",
            subscriptionId: "s1",
            topic: "post:1",
        });

        expect(response.status).toBe(403);
    });

    it("refuses publish on the public control route; publish has its own endpoint", async () => {
        expect.assertions(2);

        const calls: ShardCall[] = [];
        const stream = defineLiveStream({ topics, allowAnonymousControl: true, id: "posts" });
        const context = makeContext(calls);

        const response = await dispatch(stream.control, context, "POST", "/live/posts/control", {
            action: "publish",
            data: "forged",
            topic: "room:chat",
        });

        expect(response.status).toBe(400);
        expect(calls).toHaveLength(0);
    });

    it("stamps the control body with this stream's id, ignoring any stream the browser names", async () => {
        expect.assertions(1);

        const calls: ShardCall[] = [];
        const stream = defineLiveStream({ topics, allowAnonymousControl: true, id: "posts" });
        const context = makeContext(calls);

        await dispatch(stream.control, context, "POST", "/live/posts/control", {
            action: "subscribe",
            connectionId: "c1",
            stream: "private",
            subscriptionId: "s1",
            topic: "post:1",
        });

        expect(JSON.parse(calls[0]?.init?.body ?? "{}") as unknown).toMatchObject({ stream: "posts" });
    });

    it("denies when the onSubscribe handler throws, and logs the failure", async () => {
        expect.assertions(2);

        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const stream = defineLiveStream({
            topics,
            id: "posts",
            onSubscribe: () => {
                throw new Error("membership lookup failed");
            },
        });
        const context = makeContext([]);

        const response = await dispatch(stream.control, context, "POST", "/live/posts/control", {
            action: "subscribe",
            connectionId: "c1",
            subscriptionId: "s1",
            topic: "post:1",
        });

        expect(response.status).toBe(403);
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("live subscribe authorization threw"), expect.any(Error));

        errorSpy.mockRestore();
    });

    it("rejects a control request with no topic", async () => {
        expect.assertions(1);

        const stream = defineLiveStream({ topics, allowAnonymousControl: true, id: "posts" });
        const context = makeContext([]);

        const response = await dispatch(stream.control, context, "POST", "/live/posts/control", { action: "subscribe" });

        expect(response.status).toBe(400);
    });
});

/** The HTTP status of subscribing to `topic` on `stream`. */
const subscribe = async (stream: ReturnType<typeof defineLiveStream>, topic: string, context: HttpActionContext = makeContext([])): Promise<number> => {
    const response = await dispatch(stream.control, context, "POST", "/live/posts/control", {
        action: "subscribe",
        connectionId: "c1",
        subscriptionId: "s1",
        topic,
    });

    return response.status;
};

describe("defineLiveStream topic declaration", () => {
    it("hands onSubscribe the parsed, narrowed topic", async () => {
        expect.assertions(2);

        const onSubscribe = vi.fn<(options: { key: unknown; raw: string; topic: string }) => boolean>(() => true);
        const stream = defineLiveStream({ id: "posts", onSubscribe, topics });

        await expect(subscribe(stream, "post:p%3A1")).resolves.toBe(200);
        expect(onSubscribe).toHaveBeenCalledWith(expect.objectContaining({ key: { postId: "p:1" }, raw: "post:p%3A1", topic: "post" }));
    });

    it("round-trips a key containing the delimiter without aliasing another topic", async () => {
        expect.assertions(4);

        const seen: unknown[] = [];
        const stream = defineLiveStream({
            id: "posts",
            onSubscribe: (options) => {
                seen.push([options.topic, options.key]);

                return true;
            },
            topics,
        });

        // The encoded `:` is one key segment, never a second one.
        await expect(subscribe(stream, "post:a%3Ab")).resolves.toBe(200);
        expect(seen).toStrictEqual([["post", { postId: "a:b" }]]);
        // The same bytes spelled with a raw `:` have two segments: the wrong arity.
        await expect(subscribe(stream, "post:a:b")).resolves.toBe(403);
        expect(seen).toHaveLength(1);
    });

    it("denies a wrong-arity topic without calling onSubscribe", async () => {
        expect.assertions(2);

        const onSubscribe = vi.fn<() => boolean>(() => true);
        const stream = defineLiveStream({ id: "posts", onSubscribe, topics });

        // `post` needs one segment; `feed` takes none.
        await expect(subscribe(stream, "post")).resolves.toBe(403);
        await expect(subscribe(stream, "feed:1")).resolves.toBe(403);
    });

    it("denies an undeclared name without calling onSubscribe, and without prototype lookups", async () => {
        expect.assertions(3);

        const onSubscribe = vi.fn<() => boolean>(() => true);
        const stream = defineLiveStream({ id: "posts", onSubscribe, topics });

        await expect(subscribe(stream, "nope:1")).resolves.toBe(403);
        await expect(subscribe(stream, "constructor")).resolves.toBe(403);
        expect(onSubscribe).not.toHaveBeenCalled();
    });

    it("denies an undeclared name under allowAnonymousControl too", async () => {
        expect.assertions(2);

        const calls: ShardCall[] = [];
        const stream = defineLiveStream({ allowAnonymousControl: true, id: "posts", topics });

        await expect(subscribe(stream, "nope", makeContext(calls))).resolves.toBe(403);
        expect(calls).toHaveLength(0);
    });

    it("denies a non-canonical spelling of a declared topic", async () => {
        expect.assertions(3);

        const onSubscribe = vi.fn<() => boolean>(() => true);
        const stream = defineLiveStream({ id: "posts", onSubscribe, topics });

        // `%31` decodes to `1`, but `post:1` is the one wire form of that topic.
        await expect(subscribe(stream, "post:%31")).resolves.toBe(403);
        await expect(subscribe(stream, "post:a%3ab")).resolves.toBe(403);
        expect(onSubscribe).not.toHaveBeenCalled();
    });

    it("denies malformed escapes and topics over the length limit", async () => {
        expect.assertions(3);

        const onSubscribe = vi.fn<() => boolean>(() => true);
        const stream = defineLiveStream({ id: "posts", onSubscribe, topics });

        await expect(subscribe(stream, "post:%E0%A4%A")).resolves.toBe(403);
        // 250 chars of key encode to 250; "post:" pushes the encoded topic past 256.
        await expect(subscribe(stream, `post:${"a".repeat(252)}`)).resolves.toBe(403);
        expect(onSubscribe).not.toHaveBeenCalled();
    });

    it("denies a key segment its validator rejects, without calling onSubscribe", async () => {
        expect.assertions(2);

        const onSubscribe = vi.fn<() => boolean>(() => true);
        const stream = defineLiveStream({
            id: "posts",
            onSubscribe,
            topics: { post: { key: { kind: v.literal("news") }, payload: v.null() } },
        });

        await expect(subscribe(stream, "post:sports")).resolves.toBe(403);
        expect(onSubscribe).not.toHaveBeenCalled();
    });

    it("accepts a bounded key validator, and denies a key past the bound without calling onSubscribe", async () => {
        expect.assertions(3);

        const onSubscribe = vi.fn<() => boolean>(() => true);
        const stream = defineLiveStream({ id: "posts", onSubscribe, topics: { post: { key: { postId: v.string().max(64) }, payload: v.null() } } });

        await expect(subscribe(stream, `post:${"a".repeat(64)}`)).resolves.toBe(200);
        await expect(subscribe(stream, `post:${"a".repeat(65)}`)).resolves.toBe(403);
        expect(onSubscribe).toHaveBeenCalledTimes(1);
    });

    it("rejects a declaration whose topics could alias or never publish", () => {
        expect.assertions(5);

        expect(() => defineLiveStream({ id: "posts", topics: { "a:b": { payload: v.null() } } })).toThrow(/plain identifier/u);
        expect(() => defineLiveStream({ id: "posts", topics: { room: { payload: v.null() } } })).toThrow(/reserved topic prefix/u);
        expect(() => defineLiveStream({ id: "posts", topics: { post: { key: { "a%": v.string() }, payload: v.null() } } })).toThrow(/plain identifier/u);
        expect(() => defineLiveStream({ id: "posts", topics: { post: { key: { n: v.number() as never }, payload: v.null() } } })).toThrow(/string validator/u);
        expect(() => defineLiveStream({ id: "posts", topics: { post: { key: { id: v.string() }, payload: v.null() } } })).not.toThrow();
    });
});

describe("defineLiveStream types", () => {
    it("narrows key and payload by the declared topic", () => {
        expect.assertions(1);

        const stream = defineLiveStream({
            id: "posts",
            onSubscribe: ({ key, topic }) => {
                if (topic === "post") {
                    expectTypeOf(key).toEqualTypeOf<{ readonly postId: string }>();
                }

                if (topic === "feed") {
                    expectTypeOf(key).toEqualTypeOf<Readonly<Record<string, never>>>();
                }

                return true;
            },
            topics,
        });

        expectTypeOf<LiveTopicPayload<(typeof stream.topics)["post"]>>().toExtend<{ text: string }>();
        expectTypeOf<{ text: string }>().toExtend<LiveTopicPayload<(typeof stream.topics)["post"]>>();

        expect(stream.id).toBe("posts");
    });
});

describe("ctx.live.publish types", () => {
    it("types the payload from the ref, so a wrong payload does not compile", async () => {
        expect.assertions(1);

        const ref = { __lunoraLive: "posts", topic: "post:1" } as LiveTopicRef<{ text: string }>;
        const publish = vi.fn<HttpActionContext["live"]["publish"]>(() => Promise.resolve());
        const live: HttpActionContext["live"] = { publish };

        await live.publish(ref, { text: "hi" });
        // @ts-expect-error -- `text` is declared a string
        await live.publish(ref, { text: 1 });
        // @ts-expect-error -- `stream` is gone: the ref names its stream
        await live.publish(ref, { text: "hi" }, { stream: "posts" });

        expect(publish).toHaveBeenCalledTimes(3);
    });
});

describe("defineLiveStream validatePublish", () => {
    const stream = defineLiveStream({ id: "posts", topics });

    it("accepts a declared topic carrying a valid payload, and returns it as the validator parsed it", () => {
        expect.assertions(3);

        expect(stream.validatePublish("post:1", { text: "hi" })).toStrictEqual({ text: "hi" });
        expect(stream.validatePublish("feed", null)).toBeNull();
        // An object validator drops what it did not declare, so a subscriber must get the parsed value, not the sent one.
        expect(stream.validatePublish("post:1", { extra: 1, text: "hi" })).toStrictEqual({ text: "hi" });
    });

    it("rejects a payload that does not satisfy the declared validator with BAD_REQUEST", () => {
        expect.assertions(2);

        const attempt = (): void => {
            stream.validatePublish("post:1", { text: 3 });
        };

        expect(attempt).toThrow(LunoraError);
        expect(attempt).toThrow(expect.objectContaining({ code: "BAD_REQUEST", status: 400 }));
    });

    it("rejects an undeclared or non-canonical topic with BAD_REQUEST", () => {
        expect.assertions(3);

        expect(() => {
            stream.validatePublish("nope", null);
        }).toThrow(expect.objectContaining({ code: "BAD_REQUEST" }));
        expect(() => {
            stream.validatePublish("post:%31", { text: "x" });
        }).toThrow(expect.objectContaining({ code: "BAD_REQUEST" }));
        expect(() => {
            stream.validatePublish("post", { text: "x" });
        }).toThrow(expect.objectContaining({ code: "BAD_REQUEST" }));
    });
});
