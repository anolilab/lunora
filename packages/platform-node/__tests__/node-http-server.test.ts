import { once } from "node:events";
import { OutgoingMessage } from "node:http";
import type { Socket } from "node:net";
import { connect } from "node:net";

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

    it("aborts the request signal when the client disconnects before the response is written", async () => {
        expect.hasAssertions();

        let aborted = false;
        let entered: (() => void) | undefined;
        const handlerEntered = new Promise<void>((resolve) => {
            entered = resolve;
        });

        const server = await listen(
            (incoming) =>
                new Promise<Response>(() => {
                    incoming.signal.addEventListener("abort", () => {
                        aborted = true;
                    });
                    entered?.();
                }),
        );

        const controller = new AbortController();
        const client = fetch(server.origin, { signal: controller.signal }).catch(() => undefined);

        await handlerEntered;
        controller.abort();
        await client;

        await vi.waitFor(() => {
            expect(aborted).toBe(true);
        });
    });

    it("passes a body over 1 MiB to fetch intact, leaving the size cap to the worker", async () => {
        expect.hasAssertions();

        // Well over the 1 MiB default a route may declare a larger budget for (uploads, KV values, queue fan-out): the listener must not cap it.
        const payload = new Uint8Array(2 * 1_048_576);

        for (let index = 0; index < payload.length; index += 1) {
            payload[index] = index % 251;
        }

        const server = await listen(async (incoming) => {
            const received = new Uint8Array(await incoming.arrayBuffer());

            return new Response(String(received.length === payload.length && received.every((byte, index) => byte === payload[index])));
        });

        const response = await fetch(server.origin, { body: payload, method: "POST" });

        expect(response.status).toBe(200);
        await expect(response.text()).resolves.toBe("true");
    });

    it("delivers the 413 for a streamed body the handler cancels over its cap", async () => {
        expect.hasAssertions();

        // A handler that reads a streamed body up to a 64 KiB cap, then cancels it and answers 413, as the worker's body readers do.
        const server = await listen(async (incoming) => {
            const reader = incoming.body?.getReader();
            let total = 0;

            while (reader) {
                // eslint-disable-next-line no-await-in-loop -- sequential by design, each chunk counts toward the cap
                const { done, value } = await reader.read();

                if (done) {
                    break;
                }

                total += value.byteLength;

                if (total > 65_536) {
                    // eslint-disable-next-line no-await-in-loop -- one-shot cleanup before answering
                    await reader.cancel();

                    return new Response("too large", { status: 413 });
                }
            }

            return new Response("ok");
        });

        const payload = new Uint8Array(1_048_576);
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(payload);
                controller.close();
            },
        });

        const response = await fetch(server.origin, { body, duplex: "half", method: "POST" } as RequestInit);

        expect(response.status).toBe(413);
        await expect(response.text()).resolves.toBe("too large");
    });

    describe("a body refused over its cap", () => {
        /** Reads a streamed body up to a 64 KiB cap, then cancels it and answers 413, as the worker's body readers do. */
        const rejectOverCap = async (incoming: Request): Promise<Response> => {
            const reader = incoming.body?.getReader();
            let total = 0;

            while (reader) {
                // eslint-disable-next-line no-await-in-loop -- sequential by design, each chunk counts toward the cap
                const { done, value } = await reader.read();

                if (done) {
                    break;
                }

                total += value.byteLength;

                if (total > 65_536) {
                    // eslint-disable-next-line no-await-in-loop -- one-shot cleanup before answering
                    await reader.cancel();

                    return new Response("too large", { status: 413 });
                }
            }

            return new Response("ok");
        };

        /** A raw connection that sends a request declaring a 1 GB body, so the upload can be left open for as long as the test needs. */
        const openUpload = async (server: NodeHttpServer): Promise<{ received: () => string; socket: Socket }> => {
            const socket = connect({ host: "127.0.0.1", port: Number(new URL(server.origin).port) });
            let received = "";

            socket.on("data", (data: Buffer) => {
                received += data.toString();
            });
            socket.on("error", () => undefined);
            await once(socket, "connect");
            socket.write("POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 1000000000\r\n\r\n");

            return { received: () => received, socket };
        };

        /** Resolves once the chunk is flushed, or at once if the socket was destroyed first: the write callback fires either way. */
        const writeChunk = (socket: Socket, chunk: Buffer): Promise<void> =>
            new Promise<void>((resolve) => {
                socket.write(chunk, () => {
                    resolve();
                });
            });

        it("cuts off a never-ending upload after the byte ceiling, once the 413 is out", async () => {
            expect.hasAssertions();

            const server = await listen(rejectOverCap);
            const { received, socket } = await openUpload(server);
            let open = true;

            socket.once("close", () => {
                open = false;
            });

            // A client that never stops uploading. The loop is bounded so a server that never cuts it off fails rather than hangs.
            const chunk = Buffer.alloc(65_536);

            for (let sent = 0; open && sent < 512; sent += 1) {
                // eslint-disable-next-line no-await-in-loop -- each chunk is written after the previous one is flushed
                await writeChunk(socket, chunk);
            }

            await vi.waitFor(() => {
                expect(open).toBe(false);
            });

            expect(received()).toContain("413");
        });

        it("keeps a keep-alive socket whose refused body had already fully arrived", async () => {
            expect.hasAssertions();

            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

            try {
                let release: () => void = () => undefined;
                const gate = new Promise<void>((resolve) => {
                    release = resolve;
                });
                const server = await listen(async (request) => {
                    if (request.method === "GET") {
                        return new Response("second");
                    }

                    const reader = request.body?.getReader();

                    await reader?.read();
                    // The cancel comes only after the whole body has reached the server.
                    await gate;
                    await reader?.cancel();

                    return new Response("too large", { status: 413 });
                });
                const socket = connect({ host: "127.0.0.1", port: Number(new URL(server.origin).port) });
                let received = "";

                socket.on("data", (data: Buffer) => {
                    received += data.toString();
                });
                socket.on("error", () => undefined);
                await once(socket, "connect");
                socket.write(Buffer.concat([Buffer.from("POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 131072\r\n\r\n"), Buffer.alloc(131_072)]));

                for (let tick = 0; tick < 50; tick += 1) {
                    // eslint-disable-next-line no-await-in-loop -- let the loopback deliver the whole body before the cancel
                    await new Promise((resolve) => {
                        setImmediate(resolve);
                    });
                }

                release();
                await vi.waitFor(() => {
                    expect(received).toContain("413");
                });

                // Past the drain's time ceiling, the same connection still serves the next request.
                await vi.advanceTimersByTimeAsync(60_000);
                socket.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
                await vi.waitFor(() => {
                    expect(received).toContain("second");
                });

                socket.destroy();
            } finally {
                vi.useRealTimers();
            }
        });

        it("cuts off a stalled upload after the time ceiling, once the 413 is out", async () => {
            expect.hasAssertions();

            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

            try {
                const server = await listen(rejectOverCap);
                const { received, socket } = await openUpload(server);
                let open = true;

                socket.once("close", () => {
                    open = false;
                });

                // Enough to pass the cap, then nothing more: the body never ends and never reaches the byte ceiling.
                await writeChunk(socket, Buffer.alloc(131_072));
                await vi.waitFor(() => {
                    expect(received()).toContain("413");
                });

                await vi.advanceTimersByTimeAsync(60_000);
                await vi.waitFor(() => {
                    expect(open).toBe(false);
                });
            } finally {
                vi.useRealTimers();
            }
        });
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

    describe("request origin", () => {
        // Raw sockets: fetch cannot send a spoofed Host header or an absolute-form request target.
        const sendRaw = (port: number, requestLine: string, host: string): Promise<string> =>
            new Promise((resolve, reject) => {
                const socket = connect(port, "127.0.0.1", () => {
                    socket.write(`${requestLine} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
                });
                let data = "";

                socket.setEncoding("utf8");
                socket.on("data", (chunk: string) => {
                    data += chunk;
                });
                socket.on("end", () => {
                    resolve(data);
                });
                socket.on("error", reject);
            });

        const recordUrls = (): { fetch: (request: Request) => Response; urls: string[] } => {
            const urls: string[] = [];

            return {
                fetch: (request) => {
                    urls.push(request.url);

                    return new Response("ok");
                },
                urls,
            };
        };

        it("ignores a spoofed Host header and uses the bound origin", async () => {
            expect.hasAssertions();

            const recorder = recordUrls();
            const server = await listen(recorder.fetch);
            const port = Number(new URL(server.origin).port);

            await sendRaw(port, "GET /path?q=1", "evil.example");

            expect(recorder.urls).toStrictEqual([`${server.origin}/path?q=1`]);
        });

        it("ignores the scheme and authority of an absolute-form request target", async () => {
            expect.hasAssertions();

            const recorder = recordUrls();
            const server = await listen(recorder.fetch);
            const port = Number(new URL(server.origin).port);

            await sendRaw(port, "GET http://evil.example/path?q=1", "127.0.0.1");

            expect(recorder.urls).toStrictEqual([`${server.origin}/path?q=1`]);
        });

        it("ignores a protocol-relative or backslash authority in the request target", async () => {
            expect.hasAssertions();

            const recorder = recordUrls();
            const server = await listen(recorder.fetch);
            const port = Number(new URL(server.origin).port);

            await sendRaw(port, "GET //evil.example/a", "127.0.0.1");
            await sendRaw(port, String.raw`GET /\evil.example/b`, "127.0.0.1");

            expect(recorder.urls).toStrictEqual([`${server.origin}/a`, `${server.origin}/b`]);
        });

        it("uses the configured origin for normal requests, whatever the Host header says", async () => {
            expect.hasAssertions();

            const recorder = recordUrls();
            const server = await createNodeHttpServer({ fetch: recorder.fetch, origin: "https://app.example/", port: 0 });

            servers.push(server);

            const port = Number(new URL(server.origin).port);

            await sendRaw(port, "GET /x", "evil.example");

            expect(recorder.urls).toStrictEqual(["https://app.example/x"]);
            // The bound address is unchanged: it is what the listener answers on, not the public origin.
            expect(server.origin).toBe(`http://127.0.0.1:${String(port)}`);
        });

        it("rejects a configured origin that is not http or https", async () => {
            expect.hasAssertions();

            await expect(createNodeHttpServer({ fetch: () => new Response("ok"), origin: "ftp://app.example", port: 0 })).rejects.toThrow(RangeError);
        });

        it("does not echo the credentials of a rejected origin", async () => {
            expect.hasAssertions();

            const error = await createNodeHttpServer({ fetch: () => new Response("ok"), origin: "ftp://user:secret@app.example", port: 0 }).catch(
                (error_: unknown) => error_,
            );

            expect(error).toBeInstanceOf(RangeError);
            expect((error as Error).message).not.toContain("secret");
            expect((error as Error).message).not.toContain("user");
        });

        it("answers a malformed request target with 400, without reaching the handler", async () => {
            expect.hasAssertions();

            const recorder = recordUrls();
            const server = await listen(recorder.fetch);
            const port = Number(new URL(server.origin).port);

            // `//[` is a protocol-relative target whose host the URL parser rejects.
            const reply = await sendRaw(port, "GET //[", "127.0.0.1");

            expect(reply).toMatch(/^HTTP\/1\.1 400 /);
            expect(recorder.urls).toStrictEqual([]);
        });

        it("refuses a non-loopback bind without an origin, before listening", async () => {
            expect.hasAssertions();

            await expect(createNodeHttpServer({ fetch: () => new Response("ok"), host: "0.0.0.0", port: 0 })).rejects.toThrow(/set origin/);
            await expect(createNodeHttpServer({ fetch: () => new Response("ok"), host: "::", port: 0 })).rejects.toThrow(/set origin/);
        });

        it("serves a loopback bind without an origin, on the bound address", async () => {
            expect.hasAssertions();

            const server = await createNodeHttpServer({ fetch: () => new Response("ok"), host: "localhost", port: 0 });

            servers.push(server);

            expect(new URL(server.origin).hostname).toBe("localhost");

            const response = await fetch(server.origin);

            await expect(response.text()).resolves.toBe("ok");
        });

        it("serves a non-loopback bind when the public origin is configured", async () => {
            expect.hasAssertions();

            const recorder = recordUrls();
            const server = await createNodeHttpServer({ fetch: recorder.fetch, host: "0.0.0.0", origin: "https://app.example", port: 0 });

            servers.push(server);

            const port = Number(new URL(server.origin).port);

            await sendRaw(port, "GET /x", `10.0.0.5:${String(port)}`);

            expect(recorder.urls).toStrictEqual(["https://app.example/x"]);
        });
    });
});
