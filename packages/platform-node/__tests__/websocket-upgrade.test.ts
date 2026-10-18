import { ShardDO } from "@lunora/do";
import { afterEach, describe, expect, it } from "vitest";

import type { NodeHttpServer } from "../src/node-http-server";
import { createNodeHttpServer } from "../src/node-http-server";
import { createNodeShardRegistry } from "../src/node-shard-registry";
import { bindShardSockets, createNodeShardState } from "../src/node-shard-state";

/**
 * A `defineWebSocket` route over real network sockets on Node.
 *
 * The Cloudflare runtime calls the shard's `webSocketMessage` and
 * `webSocketClose` hooks. Here the embedder binds them with `bindShardSockets`,
 * and a Node `WebSocket` client drives the handshake over the real listener.
 * Nothing in the path is mocked except the route's app handler, which records
 * what it was called with.
 */

interface Call {
    args: Record<string, unknown>;
    functionPath: string;
}

class TestShardDO extends ShardDO {
    public readonly calls: Call[] = [];

    /** Send `text` to every live socket, the way a route's `socket.send` does. Returns how many were reached. */
    public pushToSockets(text: string): number {
        const handles = this["socketHost"].getSockets();

        for (const handle of handles) {
            handle.send(text);
        }

        return handles.length;
    }

    /** Close every live socket from the shard's side, the way a route can end a connection. */
    public closeSockets(): number {
        const handles = this["socketHost"].getSockets();

        for (const handle of handles) {
            handle.close(1000, "closed by shard");
        }

        return handles.length;
    }

    public handleRpc(functionPath: string, args: Record<string, unknown>): Promise<unknown> {
        this.calls.push({ args, functionPath });

        return Promise.resolve({ functionPath });
    }

    protected override socketRoute(path: string): { auth: boolean; functionPath: string } | undefined {
        if (path === "/chat") {
            return { auth: false, functionPath: "sockets:chat" };
        }

        if (path === "/private") {
            return { auth: true, functionPath: "sockets:private" };
        }

        return super.socketRoute(path);
    }
}

/** Resolve once `predicate` holds, polling briefly. Throws if it never does. */
const waitFor = async (predicate: () => boolean): Promise<void> => {
    for (let index = 0; index < 200; index += 1) {
        if (predicate()) {
            return;
        }

        // eslint-disable-next-line no-await-in-loop -- polling loop must wait between checks
        await new Promise((resolve) => {
            setTimeout(resolve, 10);
        });
    }

    throw new Error("waitFor: predicate never became true");
};

/** The `ws://` URL for a path on the listener. */
const socketUrl = (server: NodeHttpServer, path: string): string => `${server.origin.replace("http://", "ws://")}${path}`;

/** A raw upgrade request, so the refusal's status line can be read as the listener wrote it. */
const rawUpgrade = async (server: NodeHttpServer, path: string): Promise<string> => {
    const { port } = new URL(server.origin);
    const { createConnection } = await import("node:net");

    return new Promise<string>((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port: Number(port) }, () => {
            socket.write(
                // The RFC 6455 example key: a fixed value, not a credential.
                // eslint-disable-next-line no-secrets/no-secrets
                `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
            );
        });

        let data = "";

        socket.on("data", (chunk) => {
            data += chunk.toString("utf8");
        });
        socket.on("end", () => {
            resolve(data);
        });
        socket.on("error", reject);
    });
};

describe("node websocket upgrades", () => {
    const cleanups: (() => Promise<void> | void)[] = [];

    afterEach(async () => {
        for (const cleanup of cleanups.splice(0)) {
            // eslint-disable-next-line no-await-in-loop -- tear down in reverse-safe order, one at a time
            await cleanup();
        }
    });

    const start = async () => {
        const registry = createNodeShardRegistry();
        const shard = registry.shardFor("tenant-42");
        const shardDo = new TestShardDO(createNodeShardState(shard) as never, {});

        bindShardSockets(shardDo, shard.inbound);

        const server = await createNodeHttpServer({ fetch: (request) => shardDo.fetch(request) });

        cleanups.push(async () => {
            await server.close();
            registry.close();
        });

        return { shardDo, server };
    };

    it("delivers a client's frame to the route handler, then reports its close", async () => {
        expect.assertions(3);

        const { server, shardDo } = await start();
        const client = new WebSocket(socketUrl(server, "/chat"));

        await new Promise<void>((resolve, reject) => {
            client.addEventListener("open", () => {
                resolve();
            });
            client.addEventListener("error", () => {
                reject(new Error("the handshake failed"));
            });
        });

        client.send(JSON.stringify({ text: "hello" }));

        const eventOf = (kind: string): Call | undefined => shardDo.calls.find((call) => call.functionPath === "sockets:chat" && call.args["kind"] === kind);

        await waitFor(() => eventOf("message") !== undefined);

        expect(JSON.stringify(eventOf("message")?.args)).toContain("hello");

        client.close(1000, "done");

        await waitFor(() => eventOf("close") !== undefined);

        expect(eventOf("close")).toBeDefined();
        expect(client.readyState).toBe(WebSocket.CLOSED);
    });

    it("sends a shard frame out to the connected client", async () => {
        expect.assertions(1);

        const { server, shardDo } = await start();
        const client = new WebSocket(socketUrl(server, "/chat"));
        const received: string[] = [];

        client.addEventListener("message", (event) => {
            received.push(String(event.data));
        });

        await new Promise<void>((resolve, reject) => {
            client.addEventListener("open", () => {
                resolve();
            });
            client.addEventListener("error", () => {
                reject(new Error("the handshake failed"));
            });
        });

        // The open event can fire before the server has accepted the socket, so the push is retried until it reaches one.
        await waitFor(() => shardDo.pushToSockets("pushed") > 0);
        await waitFor(() => received.includes("pushed"));

        expect(received).toContain("pushed");

        client.close();
    });

    it("answers the client's keepalive ping itself, without the shard seeing it", async () => {
        expect.assertions(2);

        const { server, shardDo } = await start();
        const client = new WebSocket(socketUrl(server, "/chat"));
        const received: string[] = [];

        client.addEventListener("message", (event) => {
            received.push(String(event.data));
        });

        await new Promise<void>((resolve, reject) => {
            client.addEventListener("open", () => {
                resolve();
            });
            client.addEventListener("error", () => {
                reject(new Error("the handshake failed"));
            });
        });

        client.send("lunora-ping");

        await waitFor(() => received.includes("lunora-pong"));

        expect(received).toContain("lunora-pong");
        expect(shardDo.calls.some((call) => JSON.stringify(call.args).includes("lunora-ping"))).toBe(false);

        client.close();
    });

    it("tells the shard about a close the shard itself initiated", async () => {
        expect.assertions(2);

        const { server, shardDo } = await start();
        const client = new WebSocket(socketUrl(server, "/chat"));

        await new Promise<void>((resolve, reject) => {
            client.addEventListener("open", () => {
                resolve();
            });
            client.addEventListener("error", () => {
                reject(new Error("the handshake failed"));
            });
        });

        await waitFor(() => shardDo.closeSockets() > 0);
        await waitFor(() => client.readyState === WebSocket.CLOSED);

        const closeEvents = shardDo.calls.filter((call) => call.functionPath === "sockets:chat" && call.args["kind"] === "close");

        expect(closeEvents).toHaveLength(1);
        expect(client.readyState).toBe(WebSocket.CLOSED);
    });

    it("refuses an anonymous upgrade on a route that requires auth, over HTTP", async () => {
        expect.assertions(1);

        const { server } = await start();

        // Read as raw bytes: the status line is the listener's own answer, which the client API would hide behind a failed handshake.
        const refusal = await rawUpgrade(server, "/private");

        expect(refusal).toMatch(/^HTTP\/1\.1 401/u);
    });
});
