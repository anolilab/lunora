import type { Socket } from "node:net";
import { connect } from "node:net";
import { format } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DrainTimer } from "../src/drain-deadline";
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

/** Each logged line as the console prints it: the format string with its arguments applied. */
const printed = (spy: { mock: { calls: unknown[][] } }): string[] => spy.mock.calls.map((args) => format(...args));

/** A deadline the test fires by hand: no clock runs in these tests. */
const manualTimer = (): { fire: () => void; timer: DrainTimer } => {
    let onExpire: () => void = () => {};

    return {
        fire: () => {
            onExpire();
        },
        timer: (_ms, expire) => {
            onExpire = expire;

            return () => {
                onExpire = () => {};
            };
        },
    };
};

/** A raw keep-alive connection: the test decides exactly when each request goes out on it. */
const openConnection = async (origin: string): Promise<{ read: (until: string) => Promise<string>; send: (path: string) => void; socket: Socket }> => {
    const { hostname, port } = new URL(origin);
    const socket = connect(Number(port), hostname);
    let received = "";
    const waiters: { resolve: (text: string) => void; until: string }[] = [];

    const settle = (): void => {
        for (const waiter of waiters.filter((candidate) => received.includes(candidate.until))) {
            waiters.splice(waiters.indexOf(waiter), 1);

            const end = received.indexOf(waiter.until) + waiter.until.length;
            const text = received.slice(0, end);

            received = received.slice(end);
            waiter.resolve(text);
        }
    };

    socket.on("data", (chunk: Buffer) => {
        received += chunk.toString("utf8");
        settle();
    });

    await new Promise<void>((resolve) => {
        socket.once("connect", resolve);
    });

    return {
        // Checks what already arrived too, so a read registered after the bytes landed still settles.
        read: async (until) =>
            new Promise<string>((resolve) => {
                waiters.push({ resolve, until });
                settle();
            }),
        send: (path) => {
            socket.write(`GET ${path} HTTP/1.1\r\nHost: ${hostname}\r\nConnection: keep-alive\r\n\r\n`);
        },
        socket,
    };
};

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
            await expect(server.drain()).resolves.toStrictEqual({ failed: [], pending: [], timedOut: false });
        } finally {
            await server.close();
        }
    });

    it("stops accepting connections as soon as it begins", async () => {
        expect.assertions(1);

        const held = deferred();
        const arrived = deferred();
        const server = await createNodeHttpServer({
            fetch: async () => {
                arrived.release();
                await held.promise;

                return new Response("held");
            },
        });

        try {
            const inFlight = fetch(`${server.origin}/held`);

            await arrived.promise;

            const drained = server.drain();

            await expect(fetch(`${server.origin}/late`)).rejects.toThrow("fetch failed");

            held.release();
            await inFlight;
            await drained;
        } finally {
            held.release();
            await server.close();
        }
    });

    it("waits only for what was in flight when it began, not for a request sent on an open connection afterwards", async () => {
        expect.assertions(3);

        const firstGate = deferred();
        const lateGate = deferred();
        const firstArrived = deferred();
        const lateArrived = deferred();
        const server = await createNodeHttpServer({
            fetch: async (request) => {
                if (new URL(request.url).pathname === "/first") {
                    firstArrived.release();
                    await firstGate.promise;
                } else {
                    lateArrived.release();
                    await lateGate.promise;
                }

                return new Response("done");
            },
        });
        const connection = await openConnection(server.origin);

        try {
            connection.send("/first");
            await firstArrived.promise;

            const drained = server.drain();

            // Sent after the drain began, on a connection the in-flight request keeps open, so it is not closed as idle.
            connection.send("/late");
            await lateArrived.promise;
            firstGate.release();

            // The late request is still being handled, and the drain does not wait for it.
            await expect(drained).resolves.toStrictEqual({ failed: [], pending: [], timedOut: false });

            const firstAnswer = await connection.read("0\r\n\r\n");

            lateGate.release();

            const lateAnswer = await connection.read("0\r\n\r\n");

            expect(firstAnswer).toContain("HTTP/1.1 200");
            // Answered with keep-alive off, so the connection stops bringing traffic to the draining server.
            expect(lateAnswer.toLowerCase()).toContain("connection: close");
        } finally {
            firstGate.release();
            lateGate.release();
            connection.socket.destroy();
            await server.close();
        }
    });

    it("gives up at the deadline, naming the request still unfinished", async () => {
        expect.assertions(2);

        const logged = vi.spyOn(console, "error").mockImplementation(() => {});
        const { fire, timer } = manualTimer();
        const never = deferred();
        const arrived = deferred();
        const server = await createNodeHttpServer({
            fetch: async () => {
                arrived.release();
                await never.promise;

                return new Response("never");
            },
        });

        try {
            fetch(`${server.origin}/stuck?token=hidden`).catch(() => undefined);
            await arrived.promise;

            const drained = server.drain({ timer });

            fire();

            await expect(drained).resolves.toStrictEqual({ failed: [], pending: ["GET /stuck"], timedOut: true });
            expect(printed(logged)).toContainEqual(expect.stringContaining("GET /stuck"));
        } finally {
            never.release();
            await server.close();
        }
    });

    it("logs the method and path of a failed request, never its query string", async () => {
        expect.assertions(2);

        const logged = vi.spyOn(console, "error").mockImplementation(() => {});
        const server = await createNodeHttpServer({
            fetch: () => {
                throw new Error("handler broke");
            },
        });

        try {
            await fetch(`${server.origin}/reset?token=s3cret-value&sig=abc`);

            const lines = printed(logged);

            expect(lines).toContainEqual(expect.stringContaining("GET /reset;"));
            expect(lines.filter((line) => line.includes("s3cret-value") || line.includes("sig=abc"))).toStrictEqual([]);
        } finally {
            await server.close();
        }
    });

    it("logs a path containing format directives as literal text", async () => {
        expect.assertions(2);

        const logged = vi.spyOn(console, "error").mockImplementation(() => {});
        const failure = new Error("handler broke");
        const server = await createNodeHttpServer({
            fetch: () => {
                throw failure;
            },
        });

        try {
            // A client-chosen path: as part of the format string, each directive would consume the next argument.
            await fetch(`${server.origin}/a%s%s%o`);

            const [line] = printed(logged);

            expect(line).toContain("the fetch handler threw for GET /a%s%s%o; answered 500");
            // The error is still printed whole after the message, not swallowed by a directive.
            expect(line).toContain("Error: handler broke");
        } finally {
            await server.close();
        }
    });

    it("logs a fetch handler that throws, with the error object, before answering 500", async () => {
        expect.assertions(3);

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
            expect(printed(logged)).toContainEqual(expect.stringContaining("GET /boom"));
            expect(logged.mock.calls[0]?.at(-1)).toBe(failure);
        } finally {
            await server.close();
        }
    });
});
