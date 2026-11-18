import { afterEach, describe, expect, it, vi } from "vitest";

import { createNodeHttpServer } from "../src/node-http-server";

/** A promise the test settles by hand. */
const deferred = (): { promise: Promise<void>; release: () => void } => {
    let release: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });

    return { promise, release };
};

/** One full event-loop turn: every microtask a non-waiting drain would need to settle has run. */
const turn = async (): Promise<void> =>
    new Promise((resolve) => {
        setImmediate(resolve);
    });

describe("createNodeHttpServer drain", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("waits for a response whose body is still being written, and the client receives all of it", async () => {
        expect.assertions(2);

        const lastChunk = deferred();
        const events: string[] = [];
        const server = await createNodeHttpServer({
            fetch: () => {
                const body = new ReadableStream<Uint8Array>({
                    start: async (controller) => {
                        controller.enqueue(new TextEncoder().encode("first "));
                        await lastChunk.promise;
                        controller.enqueue(new TextEncoder().encode("last"));
                        controller.close();
                    },
                });

                return new Response(body);
            },
        });

        try {
            const response = await fetch(server.origin);
            const text = response.text();
            const drained = server.drain().then(() => events.push("drained"));

            await turn();
            events.push("released");
            lastChunk.release();
            await drained;

            await expect(text).resolves.toBe("first last");
            expect(events).toStrictEqual(["released", "drained"]);
        } finally {
            await server.close();
        }
    });

    it("does not wait for an event stream, which close() ends", async () => {
        expect.assertions(1);

        const server = await createNodeHttpServer({
            fetch: () =>
                new Response(
                    new ReadableStream({
                        start: (controller) => {
                            controller.enqueue(new TextEncoder().encode("data: 1\n\n"));
                        },
                    }),
                    {
                        headers: { "content-type": "text/event-stream" },
                    },
                ),
        });

        try {
            const response = await fetch(server.origin);
            const reader = response.body?.getReader();

            await reader?.read();

            // Resolves although the stream never ends; a drain that waited for it would hold the test here.
            await expect(server.drain()).resolves.toBeUndefined();
        } finally {
            await server.close();
        }
    });

    it("logs a fetch handler that throws, with the error object, before answering 500", async () => {
        expect.assertions(2);

        const logged = vi.spyOn(console, "error").mockImplementation(() => {});
        const failure = new Error("handler broke", { cause: new Error("root cause") });
        const server = await createNodeHttpServer({
            fetch: () => {
                throw failure;
            },
        });

        try {
            const response = await fetch(`${server.origin}/boom`);

            expect(response.status).toBe(500);
            expect(logged).toHaveBeenCalledWith(expect.stringContaining("GET /boom"), failure);
        } finally {
            await server.close();
        }
    });
});
