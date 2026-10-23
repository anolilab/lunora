import type { ExecutionContext } from "hono";
import { describe, expect, it, vi } from "vitest";

import type { HttpActionCtx as HttpActionContext, LiveStream, ShardFetch } from "../src/index";
import { defineLiveStream, httpRouter, liveStreamRouter, v } from "../src/index";

const stream = defineLiveStream({
    id: "posts",
    onSubscribe: () => true,
    topics: { feed: { payload: v.object({ n: v.number() }) } },
});

interface ShardCall {
    path: string;
}

/** An action context whose shard hop is recorded, so a test can tell the stream's handler ran. */
const makeEnv = (calls: ShardCall[]): { __lunoraCtx: HttpActionContext } => {
    const fetchShard: ShardFetch = (_shardKey, path) => {
        calls.push({ path });

        return Promise.resolve(new Response("forwarded"));
    };

    return { __lunoraCtx: { auth: { getIdentity: () => Promise.resolve(null), userId: null }, fetchShard } as unknown as HttpActionContext };
};

const context: ExecutionContext = { passThroughOnException: () => undefined, props: undefined, waitUntil: () => undefined };

const fallbackRouter = () => {
    return {
        fetch: vi.fn<(request: Request, env: unknown, context: unknown) => Promise<Response>>(() =>
            Promise.resolve(new Response("from the app", { status: 200 })),
        ),
    };
};

describe("liveStreamRouter", () => {
    it("serves the connect route from the stream without calling the fallback", async () => {
        expect.assertions(3);

        const calls: ShardCall[] = [];
        const fallback = fallbackRouter();
        const router = liveStreamRouter([{ id: "posts", load: () => Promise.resolve(stream) }], fallback);

        const response = await router.fetch(new Request("https://app.test/live/posts/connect"), makeEnv(calls), context);

        await expect(response.text()).resolves.toBe("forwarded");
        expect(calls).toHaveLength(1);
        expect(fallback.fetch).not.toHaveBeenCalled();
    });

    it("serves the control route with POST, forwarding an unsubscribe to the shard", async () => {
        expect.assertions(2);

        const calls: ShardCall[] = [];
        const fallback = fallbackRouter();
        const router = liveStreamRouter([{ id: "posts", load: () => Promise.resolve(stream) }], fallback);

        const response = await router.fetch(
            new Request("https://app.test/live/posts/control", {
                body: JSON.stringify({ action: "unsubscribe", subscriptionId: "s1", topic: "feed" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
            makeEnv(calls),
            context,
        );

        expect(response.status).toBe(200);
        expect(calls).toHaveLength(1);
    });

    it("hands a request to the fallback when it names a stream path with the wrong method", async () => {
        expect.assertions(2);

        const fallback = fallbackRouter();
        const load = vi.fn<() => Promise<Pick<LiveStream, "connect" | "control">>>(() => Promise.resolve(stream));
        const router = liveStreamRouter([{ id: "posts", load }], fallback);

        await router.fetch(new Request("https://app.test/live/posts/control"), makeEnv([]), context);

        expect(fallback.fetch).toHaveBeenCalledTimes(1);
        expect(load).not.toHaveBeenCalled();
    });

    it("hands every other path to the fallback, unchanged", async () => {
        expect.assertions(2);

        const fallback = fallbackRouter();
        const router = liveStreamRouter([{ id: "posts", load: () => Promise.resolve(stream) }], fallback);
        const request = new Request("https://app.test/posts/page");

        const response = await router.fetch(request, makeEnv([]), context);

        expect(fallback.fetch).toHaveBeenCalledWith(request, expect.anything(), context);
        await expect(response.text()).resolves.toBe("from the app");
    });

    it("answers 404 for an unmatched path when there is no fallback", async () => {
        expect.assertions(1);

        const router = liveStreamRouter([{ id: "posts", load: () => Promise.resolve(stream) }]);

        const response = await router.fetch(new Request("https://app.test/anything"), makeEnv([]), context);

        expect(response.status).toBe(404);
    });

    it("loads a stream on its first request and reuses it after", async () => {
        expect.assertions(2);

        const load = vi.fn<() => Promise<Pick<LiveStream, "connect" | "control">>>(() => Promise.resolve(stream));
        const router = liveStreamRouter([{ id: "posts", load }]);

        expect(load).not.toHaveBeenCalled();

        await router.fetch(new Request("https://app.test/live/posts/control", { body: "{}", method: "POST" }), makeEnv([]), context);
        await router.fetch(new Request("https://app.test/live/posts/control", { body: "{}", method: "POST" }), makeEnv([]), context);

        expect(load).toHaveBeenCalledTimes(1);
    });

    it("retries a stream whose load failed, rather than replaying the rejection", async () => {
        expect.assertions(2);

        const load = vi
            .fn<() => Promise<Pick<LiveStream, "connect" | "control">>>()
            .mockRejectedValueOnce(new Error("module failed to evaluate"))
            .mockResolvedValueOnce(stream);
        const router = liveStreamRouter([{ id: "posts", load }]);
        const request = (): Request => new Request("https://app.test/live/posts/control", { body: "{}", method: "POST" });

        const failed = await router.fetch(request(), makeEnv([]), context);

        expect(failed.status).toBe(500);

        const response = await router.fetch(request(), makeEnv([]), context);

        expect(response.status).toBe(400);
    });

    it("runs the app's own middleware on the stream routes, when the app is the fallback", async () => {
        expect.assertions(2);

        const calls: ShardCall[] = [];
        const app = httpRouter();
        const seen: string[] = [];

        app.use("*", async (c, next) => {
            seen.push(c.req.path);

            await next();

            c.res.headers.set("x-app", "1");
        });

        const router = liveStreamRouter([{ id: "posts", load: () => Promise.resolve(stream) }], app);

        const response = await router.fetch(new Request("https://app.test/live/posts/connect"), makeEnv(calls), context);

        expect(response.headers.get("x-app")).toBe("1");
        expect(seen).toStrictEqual(["/live/posts/connect"]);
    });

    it("registers the stream routes on an app once, however often the router is built", () => {
        expect.assertions(1);

        const app = httpRouter();
        const mounts = [{ id: "posts", load: () => Promise.resolve(stream) }];

        liveStreamRouter(mounts, app);

        const registered = app.routes.length;

        liveStreamRouter(mounts, app);

        expect(app.routes).toHaveLength(registered);
    });
});
