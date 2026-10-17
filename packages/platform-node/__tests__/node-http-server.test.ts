import { OutgoingMessage, request } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { NodeHttpServer } from "../src/node-http-server";
import { createNodeHttpServer } from "../src/node-http-server";

describe("createNodeHttpServer", () => {
    const servers: NodeHttpServer[] = [];

    const listen = async (fetch: (request: Request) => Promise<Response> | Response): Promise<NodeHttpServer> => {
        const server = await createNodeHttpServer({ fetch, port: 0 });

        servers.push(server);

        return server;
    };

    afterEach(async () => {
        vi.restoreAllMocks();
        await Promise.all(servers.splice(0).map((server) => server.close()));
    });

    it("handles a response error mid-stream by cancelling the body instead of crashing", async () => {
        expect.hasAssertions();

        let cancelled = false;
        const write = vi.spyOn(OutgoingMessage.prototype, "write");

        const server = await listen(
            () =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        cancel() {
                            cancelled = true;
                        },
                        // Nothing more to send: the pending read stays open, so the stream is live when the error lands.
                        pull(): void {},
                        start(controller) {
                            controller.enqueue(new TextEncoder().encode("first"));
                        },
                    }),
                ),
        );

        const pending = fetch(server.origin).catch(() => undefined);

        await vi.waitFor(() => {
            expect(write.mock.contexts.length).toBeGreaterThan(0);
        });

        // `mock.contexts` holds the `this` of each call: the ServerResponse the first chunk was written to.
        const outgoing = write.mock.contexts[0] as OutgoingMessage;

        // With no 'error' listener on the response this emit throws, which is the process crash.
        outgoing.emit("error", new Error("EPIPE"));

        await vi.waitFor(() => {
            expect(cancelled).toBe(true);
        });

        expect(outgoing.destroyed).toBe(true);

        await pending;
    });

    it("cancels the body of a response that arrives after the client disconnected", async () => {
        expect.hasAssertions();

        let cancelled = false;
        const pendingFetch: { resolve?: (response: Response) => void } = {};

        const server = await listen(
            () =>
                new Promise<Response>((resolve) => {
                    pendingFetch.resolve = resolve;
                }),
        );

        const controller = new AbortController();
        const client = fetch(server.origin, { signal: controller.signal }).catch(() => undefined);

        await vi.waitFor(() => {
            expect(pendingFetch.resolve).toBeDefined();
        });

        // Disconnect while fetch is still pending: the close has already happened when the response shows up.
        controller.abort();
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 100);
        });

        pendingFetch.resolve?.(
            new Response(
                new ReadableStream<Uint8Array>({
                    cancel() {
                        cancelled = true;
                    },
                    pull(): void {},
                    start(streamController) {
                        streamController.enqueue(new TextEncoder().encode("late"));
                    },
                }),
            ),
        );

        await vi.waitFor(() => {
            expect(cancelled).toBe(true);
        });

        await client;
    });

    it("answers 413 to a declared body over the limit without calling fetch", async () => {
        expect.hasAssertions();

        const app = vi.fn<() => Response>(() => new Response("ok"));
        const server = await listen(app);

        // Headers only: the declared length alone must be refused, so no body is sent. Sending one would race the server's close.
        const status = await new Promise<number | undefined>((resolve, reject) => {
            const outgoing = request(server.origin, { headers: { "content-length": "1048577" }, method: "POST" }, (incoming) => {
                resolve(incoming.statusCode);
                incoming.resume();
            });

            outgoing.on("error", reject);
            outgoing.end();
        });

        expect(status).toBe(413);
        expect(app).not.toHaveBeenCalled();
    });

    it("answers 413 to a chunked body that grows past the limit", async () => {
        expect.hasAssertions();

        const app = vi.fn<() => Response>(() => new Response("ok"));
        const server = await listen(app);

        const chunk = new Uint8Array(65_536);
        const body = new ReadableStream<Uint8Array>({
            start(streamController) {
                // 17 chunks of 64 KiB is 1 MiB + 64 KiB, over the 1 MiB cap, with no content-length to refuse it up front.
                for (let index = 0; index < 17; index += 1) {
                    streamController.enqueue(chunk);
                }

                streamController.close();
            },
        });

        const response = await fetch(server.origin, { body, duplex: "half", method: "POST" } as RequestInit);

        expect(response.status).toBe(413);
        expect(app).not.toHaveBeenCalled();
    });

    it("brackets an IPv6 host so the origin is a valid URL", async () => {
        expect.hasAssertions();

        const server = await createNodeHttpServer({ fetch: () => new Response("ok"), host: "::1", port: 0 });

        servers.push(server);

        const { port } = new URL(server.origin);

        expect(server.origin).toBe(`http://[::1]:${port}`);

        const response = await fetch(server.origin);

        await expect(response.text()).resolves.toBe("ok");
    });
});
