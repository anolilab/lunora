/**
 * An HTTP listener for a `fetch`-style app worker, over `node:http`.
 *
 * The worker's `fetch` is the one entry point a Cloudflare Worker has, so the
 * listener is a thin adapter: an `IncomingMessage` becomes a `Request`, and the
 * `Response` is written back chunk by chunk. The body is never buffered, so a
 * live SSE response reaches the client as the shard produces each frame.
 *
 * A client that disconnects cancels the response body. That cancel is what
 * tells the shard to drop the subscriber, so it is not optional plumbing.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** Upper bound on a request body: the 1 MiB default `@lunora/runtime` gives a request body (`MAX_BODY_BYTES`, not exported). */
const MAX_REQUEST_BODY_BYTES = 1_048_576;

/** Thrown when a request body exceeds {@link MAX_REQUEST_BODY_BYTES}. The listener answers it with 413. */
class PayloadTooLargeError extends Error {}

const readBody = async (request: IncomingMessage): Promise<Uint8Array<ArrayBuffer> | undefined> => {
    if (request.method === "GET" || request.method === "HEAD") {
        return undefined;
    }

    // A declared oversize body is refused before any of it is read.
    const declared = Number(request.headers["content-length"]);

    if (Number.isFinite(declared) && declared > MAX_REQUEST_BODY_BYTES) {
        throw new PayloadTooLargeError(`request body exceeds ${String(MAX_REQUEST_BODY_BYTES)} bytes`);
    }

    const chunks: Buffer[] = [];
    let received = 0;

    // A body without a content-length (chunked) is counted as it arrives, so the cap holds either way.
    for await (const chunk of request as AsyncIterable<Buffer>) {
        received += chunk.byteLength;

        if (received > MAX_REQUEST_BODY_BYTES) {
            throw new PayloadTooLargeError(`request body exceeds ${String(MAX_REQUEST_BODY_BYTES)} bytes`);
        }

        chunks.push(chunk);
    }

    // Copied into a fresh `ArrayBuffer`: a `RequestInit` body will not take the `ArrayBufferLike` that `Buffer.concat` is typed with.
    const body = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
    let offset = 0;

    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }

    return body;
};

const toRequest = async (incoming: IncomingMessage, origin: string): Promise<Request> => {
    const headers = new Headers();

    for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) {
            for (const item of value) {
                headers.append(name, item);
            }
        } else if (value !== undefined) {
            headers.set(name, value);
        }
    }

    const body = await readBody(incoming);

    return new Request(new URL(incoming.url ?? "/", origin), {
        headers,
        method: incoming.method ?? "GET",
        ...(body === undefined || body.byteLength === 0 ? {} : { body }),
    });
};

// A helper rather than an inline `outgoing.destroyed` check: TypeScript would narrow that property after an early return and then flag the loop's later re-check as always truthy.
const isDisconnected = (outgoing: ServerResponse): boolean => outgoing.destroyed;

const writeResponse = async (response: Response, outgoing: ServerResponse): Promise<void> => {
    // An unhandled 'error' event throws, and a socket write error must not take the process down. Destroying the response is what
    // fires 'close', which cancels the body and ends any wait for drain below.
    outgoing.on("error", () => {
        outgoing.destroy();
    });

    // A client that disconnected while fetch was pending fired 'close' before the listener below existed, so nothing else will free
    // the body. Cancel it now, which is what releases the shard's subscriber slot.
    if (isDisconnected(outgoing)) {
        await response.body?.cancel().catch(() => undefined);

        return;
    }

    const headers: Record<string, string | string[]> = {};

    response.headers.forEach((value, name) => {
        if (name !== "set-cookie") {
            headers[name] = value;
        }
    });

    const cookies = response.headers.getSetCookie();

    if (cookies.length > 0) {
        headers["set-cookie"] = cookies;
    }

    outgoing.writeHead(response.status, headers);

    if (response.body === null) {
        outgoing.end();

        return;
    }

    const reader = response.body.getReader();

    // The client going away must end the body, so the shard's `cancel` hook
    // deregisters the subscriber rather than queueing frames nobody reads.
    outgoing.once("close", () => {
        reader.cancel().catch(() => undefined);
    });

    // Each chunk must be written before the next is read: this loop is the
    // backpressure, so the reads cannot run ahead of the socket.

    let next = await reader.read();

    while (!next.done && !outgoing.destroyed) {
        if (!outgoing.write(next.value)) {
            // eslint-disable-next-line no-await-in-loop -- waiting for the socket to drain is the point
            await new Promise<void>((resolve) => {
                // Whichever of drain or close fires first ends the wait, and takes the other listener with it.
                const settle = (): void => {
                    outgoing.off("drain", settle);
                    outgoing.off("close", settle);
                    resolve();
                };

                outgoing.on("drain", settle);
                outgoing.on("close", settle);
            });
        }

        // eslint-disable-next-line no-await-in-loop -- sequential by design, see above
        next = await reader.read();
    }

    outgoing.end();
};

/** Serve `options.fetch` over `node:http`. Resolves once the server is listening. */
export const createNodeHttpServer = async (options: NodeHttpServerOptions): Promise<NodeHttpServer> => {
    const host = options.host ?? "127.0.0.1";
    const server = createServer((incoming, outgoing) => {
        const origin = `http://${incoming.headers.host ?? host}`;

        toRequest(incoming, origin)
            .then((request) => options.fetch(request))
            .then(
                (response) => writeResponse(response, outgoing),
                (error: unknown) => {
                    if (error instanceof PayloadTooLargeError) {
                        // `connection: close` because the unread rest of the body would otherwise hold the socket open.
                        outgoing.writeHead(413, { connection: "close", "content-type": "text/plain; charset=utf-8" });
                        outgoing.end("Payload Too Large");

                        return;
                    }

                    if (!outgoing.headersSent) {
                        outgoing.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
                    }

                    outgoing.end("Internal Server Error");
                },
            )
            .catch(() => {
                outgoing.destroy();
            });
    });

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port ?? 0, host, () => {
            server.off("error", reject);
            resolve();
        });
    });

    const { port } = server.address() as AddressInfo;

    return {
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.closeAllConnections();
                server.close((error) => {
                    if (error === undefined) {
                        resolve();
                    } else {
                        reject(error);
                    }
                });
            }),
        origin: `http://${host}:${String(port)}`,
    };
};

/** Options for {@link createNodeHttpServer}. */
export interface NodeHttpServerOptions {
    /** The app worker's `fetch`, already bound to its env and context. */
    fetch: (request: Request) => Promise<Response> | Response;
    /** Host to bind. Defaults to the loopback interface. */
    host?: string;
    /** Port to bind. `0` (the default) picks a free ephemeral port. */
    port?: number;
}

/** A listening server. */
export interface NodeHttpServer {
    /** Stop accepting connections and end every open one, streams included. */
    close: () => Promise<void>;
    /** The `http://host:port` origin the server answers on. */
    origin: string;
}
