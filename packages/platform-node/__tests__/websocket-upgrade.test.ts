import { ShardDO } from "@lunora/do";
import { afterEach, describe, expect, it, vi } from "vitest";

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

    // `rebuild` mirrors the worker, which rebuilds every non-101 response it returns (security headers).
    const start = async ({ rebuild = false }: { rebuild?: boolean } = {}) => {
        const registry = createNodeShardRegistry();
        const shard = registry.shardFor("tenant-42");
        const shardDo = new TestShardDO(createNodeShardState(shard) as never, {});

        bindShardSockets(shardDo, shard.inbound);

        const server = await createNodeHttpServer({
            fetch: async (request) => {
                const response = await shardDo.fetch(request);

                return rebuild ? new Response(response.body, response) : response;
            },
        });

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

    it("disposes a shard only after a route's close handler settles on shutdown", async () => {
        expect.assertions(2);

        const registry = createNodeShardRegistry();
        const shard = registry.shardFor("tenant-42");
        const shardDo = new TestShardDO(createNodeShardState(shard) as never, {});
        const outcome: string[] = [];
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        // The close handler is held at a gate, so it is still running when the registry is closed.
        bindShardSockets(shardDo, {
            onClose: (handler) => {
                shard.inbound.onClose(async (...args) => {
                    await gate;

                    try {
                        // A read against the shard's database throws once the registry has disposed it.
                        await shard.kv.get("probe");
                        await handler(...args);
                        outcome.push("ok");
                    } catch (error) {
                        outcome.push(String(error));
                    }
                });
            },
            onMessage: (handler) => {
                shard.inbound.onMessage(handler);
            },
        });

        const server = await createNodeHttpServer({ fetch: async (request) => shardDo.fetch(request) });
        const client = new WebSocket(socketUrl(server, "/chat"));

        await new Promise<void>((resolve, reject) => {
            client.addEventListener("open", () => {
                resolve();
            });
            client.addEventListener("error", () => {
                reject(new Error("the handshake failed"));
            });
        });
        await waitFor(() => shardDo.pushToSockets("ready") > 0);

        await server.close();
        registry.close();
        release();

        await waitFor(() => outcome.length > 0);

        expect(outcome).toStrictEqual(["ok"]);
        expect(shardDo.calls.some((call) => call.functionPath === "sockets:chat" && call.args["kind"] === "close")).toBe(true);
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

    it("completes the handshake when the worker rebuilds the upgrade response", async () => {
        expect.assertions(1);

        const { server, shardDo } = await start({ rebuild: true });
        const client = new WebSocket(socketUrl(server, "/chat"));

        await new Promise<void>((resolve, reject) => {
            client.addEventListener("open", () => {
                resolve();
            });
            client.addEventListener("error", () => {
                reject(new Error("the handshake failed"));
            });
        });

        client.send(JSON.stringify({ text: "after rebuild" }));

        await waitFor(() => shardDo.calls.some((call) => call.args["kind"] === "message"));

        expect(JSON.stringify(shardDo.calls.find((call) => call.args["kind"] === "message")?.args)).toContain("after rebuild");

        client.close();
    });

    it("refuses an anonymous upgrade on a route that requires auth, over HTTP", async () => {
        expect.assertions(1);

        const { server } = await start();

        // Read as raw bytes: the status line is the listener's own answer, which the client API would hide behind a failed handshake.
        const refusal = await rawUpgrade(server, "/private");

        expect(refusal).toMatch(/^HTTP\/1\.1 401/u);
    });
});

describe("node upgrade lifecycle", () => {
    /** Open a raw upgrade to `path`; resolves once the request is written. */
    const rawOpen = async (server: NodeHttpServer, path: string): Promise<import("node:net").Socket> => {
        const { port } = new URL(server.origin);
        const { createConnection } = await import("node:net");

        return new Promise((resolve) => {
            const socket = createConnection({ host: "127.0.0.1", port: Number(port) }, () => {
                socket.write(
                    // The RFC 6455 example key: a fixed value, not a credential.
                    // eslint-disable-next-line no-secrets/no-secrets
                    `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
                );
                resolve(socket);
            });

            // The tests reset or destroy this socket on purpose.
            socket.on("error", () => undefined);
        });
    };

    const sleep = async (ms: number): Promise<void> => {
        await new Promise((resolve) => {
            setTimeout(resolve, ms);
        });
    };

    it("aborts a pending upgrade when the client resets the connection during the handshake", async () => {
        expect.assertions(2);

        let upgradeSignal: AbortSignal | undefined;
        const server = await createNodeHttpServer({
            fetch: (request) => {
                if (request.headers.get("upgrade") !== "websocket") {
                    return Promise.resolve(new Response("ok"));
                }

                upgradeSignal = request.signal;

                // The shard decides only after the client has gone, and its refusal is written to the dead socket.
                return new Promise<Response>((resolve) => {
                    request.signal.addEventListener("abort", () => {
                        resolve(new Response("nope", { status: 401 }));
                    });
                });
            },
        });

        const client = await rawOpen(server, "/slow");

        await waitFor(() => upgradeSignal !== undefined);
        client.resetAndDestroy();
        await waitFor(() => upgradeSignal?.aborted === true);
        // Give the refusal write time to reach the dead socket: a missing error listener would end the process here.
        await sleep(50);

        expect(upgradeSignal?.aborted).toBe(true);

        const followUp = await fetch(`${server.origin}/`);

        await expect(followUp.text()).resolves.toBe("ok");

        await server.close();
    });

    it("shuts down promptly while an upgrade is still awaiting its fetch", async () => {
        expect.assertions(1);

        let entered = false;
        const server = await createNodeHttpServer({
            fetch: () => {
                entered = true;

                return new Promise<Response>(() => {
                    // Never settles: the shard is still deciding.
                });
            },
        });

        const client = await rawOpen(server, "/slow");

        await waitFor(() => entered);

        const closed = server.close().then(() => "closed" as const);
        const hung = new Promise<"hung">((resolve) => {
            setTimeout(resolve, 2000, "hung" as const);
        });
        const outcome = await Promise.race([closed, hung]);

        client.destroy();

        expect(outcome).toBe("closed");
    });
});

describe("bindShardSockets", () => {
    it("logs a synchronous throw from webSocketMessage the same way as a rejection", async () => {
        expect.assertions(2);

        let onMessage: ((socket: unknown, data: string) => void) | undefined;
        const inbound = {
            onClose: () => undefined,
            onMessage: (handler: (socket: unknown, data: string) => void) => {
                onMessage = handler;
            },
        };
        const syncThrow = new Error("sync throw");
        const shard = {
            webSocketClose: () => Promise.resolve(),
            webSocketMessage: (): Promise<void> => {
                throw syncThrow;
            },
        };
        const logged: unknown[][] = [];
        const log = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
            logged.push(args);
        });

        try {
            bindShardSockets(shard, inbound as never);

            // A synchronous throw must not escape the listener: it has to reach the same log as a rejection.
            expect(() => onMessage?.({}, "frame")).not.toThrow();

            // `vi.waitFor` retries the callback until it stops throwing; an `expect` inside would count each retry.
            await vi.waitFor(() => {
                if (logged.length !== 1) {
                    throw new Error("the failure was not logged yet");
                }
            });

            expect(logged[0]).toStrictEqual(["[lunora] webSocketMessage threw:", syncThrow]);
        } finally {
            log.mockRestore();
        }
    });
});
