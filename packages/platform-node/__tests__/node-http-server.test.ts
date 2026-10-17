import { OutgoingMessage } from "node:http";

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
});
