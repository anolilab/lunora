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

import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import { WebSocketServer } from "ws";

import { takeUpgradeClient } from "./node-socket-pair";

/** A host as it appears in a URL: an IPv6 literal such as `::1` needs brackets, `[::1]`, or the origin is not a valid URL. */
const urlHost = (host: string): string => (host.includes(":") && !host.startsWith("[") ? `[${host}]` : host);

/** The origin of a configured public base URL. Only http and https are served, so anything else is a configuration error. */
const publicOrigin = (value: string): string => {
    const url = new URL(value);

    // The scheme only: the full value may carry `user:pass@`, which must not reach an error message or a log.
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new RangeError(`origin must be an http or https URL, got scheme ${url.protocol}`);
    }

    return url.origin;
};

const LOOPBACK_HOST = /^(?:127\.\d+\.\d+\.\d+|::1|localhost)$/;

// ponytail: how much of a refused body is read past the cancel before its socket is destroyed. A ceiling, not a guess at a client's size:
// raise it if a legitimate client needs more of its body read to receive the 413.
const REFUSED_BODY_DRAIN_BYTES = 1_048_576;

// ponytail: how long a refused body may keep streaming after the cancel. Same trade-off as REFUSED_BODY_DRAIN_BYTES.
const REFUSED_BODY_DRAIN_MS = 5000;

/**
 * The request body as a web stream, pulled chunk by chunk. Not `Readable.toWeb`, which the supported Node range does not yet ship.
 * Cancelling the stream discards the rest of the body, up to a byte and a time ceiling, rather than destroying the socket at once: the
 * worker answers a cancelled over-cap body with a 413, and that response must still reach a client that is still uploading.
 */
const bodyStream = (incoming: IncomingMessage, outgoing: ServerResponse): ReadableStream<Uint8Array> => {
    const chunks = (incoming as AsyncIterable<Buffer>)[Symbol.asyncIterator]();

    return new ReadableStream<Uint8Array>({
        cancel() {
            if (outgoing.headersSent) {
                incoming.destroy();

                return;
            }

            // The whole body has already arrived: nothing is left to cut off, and the keep-alive socket stays usable. What is still
            // buffered is read out, so the request ends and the connection can parse the next one.
            if (incoming.complete) {
                incoming.resume();

                return;
            }

            // The body is read and dropped only up to a byte or time ceiling. Hitting one marks the drain over, and the socket is
            // destroyed once the 413 has finished, so the response is never cut short. A body that ends first keeps its socket.
            let drained = 0;
            let overCeiling = false;

            const ceilingHit = (): void => {
                // A body that finished arriving meanwhile has nothing left to cut off.
                if (incoming.complete) {
                    return;
                }

                overCeiling = true;

                if (outgoing.writableFinished) {
                    incoming.destroy();

                    return;
                }

                // The response is still owed, so the socket stays, but nothing more of the body is read: an upload past the ceiling
                // is held back by the transport instead of being consumed for as long as the handler takes.
                incoming.removeAllListeners("readable");
                incoming.pause();
            };
            const timer = setTimeout(ceilingHit, REFUSED_BODY_DRAIN_MS);
            const stopTimer = (): void => {
                clearTimeout(timer);
            };

            outgoing.once("finish", () => {
                if (overCeiling) {
                    incoming.destroy();
                }
            });
            incoming.once("end", stopTimer);
            incoming.once("close", stopTimer);

            incoming.removeAllListeners("readable");
            incoming.on("readable", () => {
                let chunk = incoming.read() as Buffer | null;

                while (chunk !== null) {
                    drained += chunk.byteLength;

                    if (drained > REFUSED_BODY_DRAIN_BYTES) {
                        ceilingHit();

                        return;
                    }

                    chunk = incoming.read() as Buffer | null;
                }
            });
        },
        async pull(controller) {
            const next = await chunks.next();

            if (next.done) {
                controller.close();
            } else {
                controller.enqueue(next.value);
            }
        },
    });
};

/**
 * The request URL on `origin`, built from the path and query of the request target only. An absolute-form target
 * (`GET http://evil.example/x`), a protocol-relative one (`//evil.example/x`) or a backslash variant resolves to another
 * authority, so that scheme and authority are discarded: the origin always comes from the server, never the client.
 */
const requestUrl = (target: string | undefined, origin: string): URL => {
    const parsed = new URL(target ?? "/", origin);
    const url = new URL(origin);

    url.pathname = parsed.pathname;
    url.search = parsed.search;

    return url;
};

// The body is streamed through, not buffered: the worker's own per-route body caps (`@lunora/runtime`) decide what is refused, so a
// route with a larger budget than the framework default is not cut off here.
// `outgoing` is the response a refused body's drain watches. An upgrade has none, and a WebSocket handshake is a GET with no body.
const toRequest = (incoming: IncomingMessage, origin: string, signal: AbortSignal, outgoing?: ServerResponse): Request => {
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

    const method = incoming.method ?? "GET";
    // `duplex` is required by the Fetch spec for a streamed request body; it is not in the DOM `RequestInit` type.
    const init: RequestInit & { duplex?: "half" } = { headers, method, signal };

    if (method !== "GET" && method !== "HEAD" && outgoing !== undefined) {
        init.body = bodyStream(incoming, outgoing);
        init.duplex = "half";
    }

    return new Request(requestUrl(incoming.url, origin), init);
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

// ponytail: how much of a refused upgrade's body is relayed. A refusal is a short status message; a worker that streams more is cut off
// here rather than buffered whole per pending connection. Raise it if a legitimate refusal page outgrows it.
const REFUSAL_BODY_LIMIT_BYTES = 65_536;

/**
 * A body's chunks, read one at a time so the caller can cancel the reader midway, up to {@link REFUSAL_BODY_LIMIT_BYTES}. Past that the
 * reader is cancelled and the body truncated.
 */
const readChunks = async (reader: ReadableStreamDefaultReader<Uint8Array>, chunks: Uint8Array[], total = 0): Promise<Uint8Array[]> => {
    const next = await reader.read();

    if (next.done) {
        return chunks;
    }

    const room = REFUSAL_BODY_LIMIT_BYTES - total;

    if (next.value.byteLength >= room) {
        chunks.push(next.value.subarray(0, room));
        await reader.cancel().catch(() => undefined);

        return chunks;
    }

    chunks.push(next.value);

    return readChunks(reader, chunks, total + next.value.byteLength);
};

/**
 * Answer a refused upgrade with the response the worker chose: its status, its
 * headers, and its body. The socket is closed afterwards, because a refused
 * handshake has no connection to keep.
 */
const writeRefusal = async (response: Response, socket: Duplex): Promise<void> => {
    const reader = response.body?.getReader();
    // A client that has gone will never read the refusal, so its body is cancelled rather than read to the end.
    const cancel = (): void => {
        reader?.cancel().catch(() => undefined);
    };

    if (socket.destroyed) {
        cancel();

        return;
    }

    socket.once("close", cancel);

    const chunks = reader === undefined ? [] : await readChunks(reader, []);

    socket.off("close", cancel);

    // A client that left mid-read has nothing to receive the refusal.
    if (!socket.writable) {
        return;
    }

    const body = Buffer.concat(chunks);
    const lines = [
        `HTTP/1.1 ${String(response.status)} ${response.statusText || "Refused"}`,
        "connection: close",
        `content-length: ${String(body.byteLength)}`,
    ];

    response.headers.forEach((value, name) => {
        if (name !== "content-length" && name !== "connection") {
            lines.push(`${name}: ${value}`);
        }
    });

    socket.end(Buffer.concat([Buffer.from(`${lines.join("\r\n")}\r\n\r\n`), body]));
};

/** Serve `options.fetch` over `node:http`. Resolves once the server is listening. */
export const createNodeHttpServer = async (options: NodeHttpServerOptions): Promise<NodeHttpServer> => {
    const host = options.host ?? "127.0.0.1";
    const configured = options.origin === undefined ? undefined : publicOrigin(options.origin);

    // Without a configured origin, requests resolve to the bound address. Browsers send their own address as `Origin`, so the CSRF check
    // would reject every cookie-bearing POST, and signed URLs would point at a wildcard address. Loopback is exempt: the runtime's
    // allowLoopback default covers it.
    if (configured === undefined && !LOOPBACK_HOST.test(host)) {
        throw new Error(
            `createNodeHttpServer: host "${host}" is not a loopback address, so set origin to the public URL (e.g. https://app.example). ` +
                "Without it, browser requests fail the CSRF origin check and signed URLs point at the bound address.",
        );
    }

    // `noServer`: the HTTP listener owns the upgrade, so the worker's own checks run before any handshake is written.
    const webSockets = new WebSocketServer({ noServer: true });
    // Raw sockets whose upgrade is still awaiting the worker. They are not in `webSockets.clients` yet, so `close` reaches them here.
    const pendingUpgrades = new Set<Duplex>();
    const server = createServer();
    // The origin every request URL is built on, for plain requests and upgrades alike. The client's Host header is never read:
    // the configured public origin, or else the bound address.
    const requestOrigin = (): string => configured ?? `http://${urlHost(host)}:${String((server.address() as AddressInfo).port)}`;

    server.on("request", (incoming, outgoing) => {
        const origin = requestOrigin();
        const abort = new AbortController();

        // A client that disconnects before the response is complete will never read it, so the handler's signal fires
        // and the shard can stop work for it. A finished response is not an abort.
        outgoing.once("close", () => {
            if (!outgoing.writableFinished) {
                abort.abort();
            }
        });

        // The only way toRequest throws is a request target the URL parser rejects, which is the client's fault, not the handler's.
        let request: Request;

        try {
            request = toRequest(incoming, origin, abort.signal, outgoing);
        } catch {
            outgoing.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
            outgoing.end("Bad Request");

            return;
        }

        Promise.resolve()
            .then(() => options.fetch(request))
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

    const upgrade = async (incoming: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
        // A client that drops the socket before the handshake completes gets no answer: abort the request so the shard stops.
        const abort = new AbortController();
        // The shard can accept the server end while `fetch` is still running a route's `onOpen`, so a close during the fetch is
        // remembered and acted on once the client end is known.
        // An object, not a `let`: the close fires during the awaited fetch, which control-flow narrowing cannot see.
        const socketState = { closed: false };

        pendingUpgrades.add(socket);
        // The socket has no other 'error' listener until `ws` attaches one. A reset during the fetch, or while a refusal is
        // written, would otherwise be an unhandled 'error' that ends the process. The close that follows does the cleanup.
        socket.on("error", () => {
            socket.destroy();
        });
        socket.once("close", () => {
            socketState.closed = true;
            pendingUpgrades.delete(socket);
            abort.abort();
        });

        const response = await options.fetch(toRequest(incoming, requestOrigin(), abort.signal));
        const client = takeUpgradeClient(response);

        if (client === undefined) {
            // Not an accepted upgrade: the worker refused it (401, 403, 426, 404), so that response is the answer.
            await writeRefusal(response, socket);

            return;
        }

        // The shard has accepted the server end. If the socket has gone, or goes before the handshake does, the shard must hear the close.
        if (socketState.closed) {
            client.abandon();

            return;
        }

        socket.once("close", () => {
            client.abandon();
        });

        webSockets.handleUpgrade(incoming, socket, head, (ws) => {
            client.attach(ws);
        });
    };

    server.on("upgrade", (incoming, socket, head) => {
        upgrade(incoming, socket, head).catch(() => {
            socket.destroy();
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
        close: async () => {
            // Each socket's close event is what starts the shard's close handler, so `close` settles only after
            // every one has fired: a caller that then closes the registry finds those handlers already tracked.
            const socketsClosed = [...webSockets.clients].map(async (ws) => once(ws, "close"));

            // Upgraded sockets are not HTTP connections, so `closeAllConnections` does not reach them.
            for (const ws of webSockets.clients) {
                ws.terminate();
            }

            // A pending upgrade's fetch may never settle, so its raw socket is destroyed rather than waited for.
            for (const socket of pendingUpgrades) {
                socket.destroy();
            }

            webSockets.close();
            server.closeAllConnections();

            await new Promise<void>((resolve, reject) => {
                server.close((error) => {
                    if (error === undefined) {
                        resolve();
                    } else {
                        reject(error);
                    }
                });
            });
            await Promise.all(socketsClosed);
        },
        origin: `http://${urlHost(host)}:${String(port)}`,
    };
};

/** Options for {@link createNodeHttpServer}. */
export interface NodeHttpServerOptions {
    /** The app worker's `fetch`, already bound to its env and context. */
    fetch: (request: Request) => Promise<Response> | Response;
    /** Host to bind. Defaults to the loopback interface. */
    host?: string;

    /**
     * The public base URL the app is served at, e.g. `https://app.example`. Every request URL uses its origin, so origin-sensitive
     * behaviour (CSRF, WebSocket origin checks, cookie rules) sees the public scheme behind a TLS proxy. The client's `Host` header is
     * never used. Defaults to the bound `http://host:port`, which is only allowed for a loopback `host`: binding a non-loopback address
     * (e.g. `0.0.0.0` or a LAN IP) without `origin` makes {@link createNodeHttpServer} reject, because browsers would send that address
     * as `Origin` and fail the CSRF check. Set `origin` to the URL users open.
     */
    origin?: string;
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
