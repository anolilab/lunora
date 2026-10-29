/**
 * The auth plane's streamed body cap under workerd's own `Request` /
 * `ReadableStream`, which the node suite cannot stand in for: the capped copy
 * must stream the original body lazily, and a declining handler must leave the
 * original readable.
 */
import { describe, expect, it } from "vitest";

import type { ExecutionContextLike } from "../../src/create-worker";
import { createWorker } from "../../src/create-worker";
import type { ShardNamespaceLike } from "../../src/resolve-shard";

const context: ExecutionContextLike = { passThroughOnException: () => undefined, waitUntil: () => undefined };

const namespace: ShardNamespaceLike = {
    get: () => {
        return { fetch: async () => Response.json({ ok: true }) };
    },
    idFromName: (name) => {
        return { __name: name };
    },
};

const chunkedBody = (chunks: number): ReadableStream<Uint8Array> => {
    const chunk = new Uint8Array(64 * 1024).fill(0x61);
    let sent = 0;

    return new ReadableStream<Uint8Array>({
        pull: (controller) => {
            if (sent < chunks) {
                sent += 1;
                controller.enqueue(chunk);
            } else {
                controller.close();
            }
        },
    });
};

describe("auth plane body cap (workerd)", () => {
    it("refuses a 3 MiB chunked body with 413 and the handler sees at most 1 MiB", async () => {
        expect.assertions(2);

        let bytesSeen = 0;
        const worker = createWorker({
            authHandler: async (request) => {
                try {
                    const bytes = await request.arrayBuffer();

                    bytesSeen = bytes.byteLength;
                } catch {
                    // The cap errors the stream; the runtime answers 413 regardless.
                }

                return new Response("ok");
            },
            shardDO: namespace,
        });

        const response = await worker.fetch(new Request("https://app.test/api/auth/sign-in/email", { body: chunkedBody(48), method: "POST" }), {}, context);

        expect(bytesSeen).toBeLessThanOrEqual(1_048_576);
        expect(response.status).toBe(413);
    });

    it("passes a normal body through and leaves it readable when the handler declines", async () => {
        expect.assertions(3);

        const seen: string[] = [];
        const worker = createWorker({
            authHandler: async (request) => {
                if (new URL(request.url).pathname.endsWith("/sign-in/email")) {
                    seen.push(await request.text());

                    return new Response("signed-in");
                }

                return undefined;
            },
            routes: { "POST /api/auth/custom": async (request: Request) => new Response(await request.text()) },
            shardDO: namespace,
        });

        const signIn = await worker.fetch(new Request("https://app.test/api/auth/sign-in/email", { body: '{"email":"a@b.c"}', method: "POST" }), {}, context);
        const custom = await worker.fetch(new Request("https://app.test/api/auth/custom", { body: "hello", method: "POST" }), {}, context);

        expect(signIn.status).toBe(200);
        expect(seen).toStrictEqual(['{"email":"a@b.c"}']);
        await expect(custom.text()).resolves.toBe("hello");
    });
});
