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

const readBody = async (request: IncomingMessage): Promise<Buffer | undefined> => {
    if (request.method === "GET" || request.method === "HEAD") {
        return undefined;
    }

    const chunks: Buffer[] = [];

    for await (const chunk of request as AsyncIterable<Buffer>) {
        chunks.push(chunk);
    }

    return Buffer.concat(chunks);
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

const writeResponse = async (response: Response, outgoing: ServerResponse): Promise<void> => {
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
                outgoing.once("drain", resolve);
                outgoing.once("close", resolve);
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
                () => {
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
