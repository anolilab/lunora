import { createWorker, withFrameworkWorker } from "@lunora/runtime";
import type { ExecutionContextLike, ShardNamespaceLike } from "@lunora/runtime";
import { defineLiveStream, httpRouter, liveStreamRouter, v } from "@lunora/server";
import { describe, expect, it, vi } from "vitest";

// The worker's own dispatch serves a declared stream with no route mounted by the app. Codegen emits the same
// `liveStreamRouter` calls these tests make, in the standalone `httpRouter` and around a framework host.

const feed = defineLiveStream({
    id: "feed",
    onSubscribe: () => true,
    topics: { news: { key: { id: v.string() }, payload: v.object({ n: v.number() }) } },
});

/** A shard namespace that records each request's method and path, and answers 200. */
const recordingShards = (seen: string[]): ShardNamespaceLike => ({
    get: () => ({
        fetch: (input: Request | string) => {
            const request = typeof input === "string" ? new Request(input) : input;

            seen.push(`${request.method} ${new URL(request.url).pathname}`);

            return Promise.resolve(new Response("from shard", { status: 200 }));
        },
    }),
    idFromName: (name: string) => ({ __name: name }),
});

const executionContext: ExecutionContextLike = { passThroughOnException: () => undefined, waitUntil: () => undefined };

const connectRequest = (): Request => new Request("https://app.test/live/feed/connect");
const controlRequest = (): Request =>
    new Request("https://app.test/live/feed/control", {
        body: JSON.stringify({ action: "unsubscribe", topic: "news:a" }),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

describe("a declared live stream, mounted by the worker", () => {
    it("serves its connect and control routes, and leaves every other path to the app", async () => {
        expect.assertions(1);

        const seen: string[] = [];
        const app = httpRouter();

        app.get("/about", (c) => c.text("about page"));

        const worker = createWorker({
            httpRouter: liveStreamRouter([{ id: "feed", load: () => Promise.resolve(feed) }], app),
            shardDO: recordingShards(seen),
        });

        const connect = await worker.fetch(connectRequest(), {}, executionContext);
        const control = await worker.fetch(controlRequest(), {}, executionContext);
        const about = await worker.fetch(new Request("https://app.test/about"), {}, executionContext);
        const missing = await worker.fetch(new Request("https://app.test/nope"), {}, executionContext);

        expect({ about: await about.text(), connect: connect.status, control: control.status, missing: missing.status, seen }).toStrictEqual({
            about: "about page",
            connect: 200,
            control: 200,
            missing: 404,
            seen: ["GET /_lunora/live/connect", "POST /_lunora/live/control"],
        });
    });

    it("serves its routes through a framework host, which keeps the host's own triggers", async () => {
        expect.assertions(3);

        const seen: string[] = [];
        const scheduled = vi.fn(() => Promise.resolve());
        const host = {
            fetch: () => new Response("host page", { status: 200 }),
            scheduled,
        };

        const worker = withFrameworkWorker(liveStreamRouter([{ id: "feed", load: () => Promise.resolve(feed) }], host), () => ({
            shardDO: recordingShards(seen),
        }));

        const connect = await worker.fetch(connectRequest(), {}, executionContext);
        const page = await worker.fetch(new Request("https://app.test/page"), {}, executionContext);

        await worker.scheduled({ cron: "* * * * *", scheduledTime: 0 }, {}, executionContext);

        expect({ connect: connect.status, page: await page.text(), seen }).toStrictEqual({
            connect: 200,
            page: "host page",
            seen: ["GET /_lunora/live/connect"],
        });
        expect(scheduled).toHaveBeenCalledTimes(1);
        expect(scheduled).toHaveBeenCalledWith({ cron: "* * * * *", scheduledTime: 0 }, {}, executionContext);
    });
});
