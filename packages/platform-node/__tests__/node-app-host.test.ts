import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createNodeAppHost } from "../src/node-app-host";
import type { NodeShardState } from "../src/node-shard-state";

/** A Durable Object that counts in its shard's SQLite, so a count that survives a new host proves the database persisted. */
class Counter {
    private readonly env: Record<string, unknown>;

    private readonly state: NodeShardState;

    public constructor(state: NodeShardState, env: Record<string, unknown>) {
        this.state = state;
        this.env = env;
    }

    public async fetch(): Promise<Response> {
        const { sql } = this.state.storage;

        sql.exec("CREATE TABLE IF NOT EXISTS hits (n INTEGER)");
        sql.exec("INSERT INTO hits (n) VALUES (1)");

        // The state's `exec` is typed `unknown` because `ShardDO` re-adapts it; here it is the host's cursor.
        const [row] = (sql.exec("SELECT count(*) AS count FROM hits") as { toArray: () => { count: number }[] }).toArray();

        return Response.json({ count: row?.count, greeting: this.env["GREETING"], shard: this.state.id.name });
    }
}

const worker = {
    Counter,
    default: {
        fetch: async (request: Request, env: { COUNTER: { getByName: (name: string) => { fetch: (request: Request) => Promise<Response> } } }) =>
            env.COUNTER.getByName(new URL(request.url).pathname.slice(1)).fetch(request),
    },
};

describe(createNodeAppHost, () => {
    let directory: string;

    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), "lunora-node-app-host-"));
    });

    afterEach(() => {
        rmSync(directory, { force: true, recursive: true });
    });

    it("routes the worker's binding to the exported class, with env, and keeps shard data across hosts", async () => {
        expect.assertions(2);

        // Not created yet: the host makes it, as `lunora dev` hands it a fresh `.lunora/node/`.
        const options = {
            dataDirectory: join(directory, "state"),
            durableObjects: [{ className: "Counter", name: "COUNTER" }],
            env: { GREETING: "hi" },
            worker,
        };
        const first = createNodeAppHost(options);

        await first.fetch(new Request("https://app.local/tenant-a"));

        const response = await first.fetch(new Request("https://app.local/tenant-a"));

        await expect(response.json()).resolves.toStrictEqual({
            count: 2,
            greeting: "hi",
            shard: "tenant-a",
        });

        await first.close();

        const second = createNodeAppHost(options);

        try {
            const reopened = await second.fetch(new Request("https://app.local/tenant-a"));

            await expect(reopened.json()).resolves.toMatchObject({ count: 3 });
        } finally {
            await second.close();
        }
    });

    it("fires a declared cron on the shard binding, on the injected clock", async () => {
        expect.assertions(2);

        vi.useFakeTimers({ now: new Date("2026-11-01T12:00:30Z") });

        // The delivery reaching the shard is the milestone; the test waits on it, not on a timer.
        let delivered: (call: { body: unknown; path: string }) => void = () => {};
        const delivery = new Promise<{ body: unknown; path: string }>((_resolve) => {
            delivered = _resolve;
        });

        class Shard {
            // eslint-disable-next-line class-methods-use-this -- a delivery recorder has no state of its own
            public async fetch(request: Request): Promise<Response> {
                delivered({ body: await request.json(), path: new URL(request.url).pathname });

                return Response.json({ result: null });
            }
        }

        const host = createNodeAppHost({
            crons: { "* * * * *": [{ args: { region: "eu" }, functionPath: "reports:sweep", name: "sweep" }] },
            durableObjects: [{ className: "Shard", name: "SHARD" }],
            worker: { default: worker.default, Shard },
        });

        try {
            await vi.advanceTimersByTimeAsync(60 * 1000);

            // Already settled or not at all: a cron that never fired fails here instead of at the test timeout.
            const call = await Promise.race([delivery, Promise.resolve(undefined)]);

            expect(call?.path).toBe("/rpc");
            expect(call?.body).toStrictEqual({ args: { region: "eu" }, functionPath: "reports:sweep" });
        } finally {
            await host.close();
            vi.useRealTimers();
        }
    });

    it("refuses crons when no binding is named for the shard", () => {
        expect.assertions(1);

        expect(() =>
            createNodeAppHost({
                crons: { "* * * * *": [{ functionPath: "reports:sweep", name: "sweep" }] },
                durableObjects: [{ className: "Counter", name: "COUNTER" }],
                worker,
            }),
        ).toThrow(/no Durable Object binding is named SHARD/);
    });

    it("refuses a binding whose class the worker module does not export", () => {
        expect.assertions(1);

        expect(() => createNodeAppHost({ durableObjects: [{ className: "Missing", name: "COUNTER" }], worker })).toThrow(/names class Missing/);
    });

    it("closes on its deadline when the worker's waitUntil work never settles, and releases the databases", async () => {
        expect.assertions(3);

        const options = {
            dataDirectory: join(directory, "state"),
            durableObjects: [{ className: "Counter", name: "COUNTER" }],
            worker: {
                Counter,
                default: {
                    fetch: async (
                        request: Request,
                        env: Parameters<typeof worker.default.fetch>[1],
                        context: { waitUntil: (promise: Promise<unknown>) => void },
                    ) => {
                        context.waitUntil(
                            new Promise(() => {
                                // Never settles, as a stuck background task would.
                            }),
                        );

                        return worker.default.fetch(request, env);
                    },
                },
            },
        };
        const first = createNodeAppHost(options);

        await first.fetch(new Request("https://app.local/tenant-a"));

        let expire: () => void = () => {};
        const closing = first.close({
            timer: (_ms, onExpire) => {
                expire = onExpire;

                return () => {};
            },
        });

        expire();

        const drained = await closing;

        expect(drained.timedOut).toBe(true);
        expect(drained.pending).toContain("1 worker waitUntil task(s)");

        // The database was closed despite the stuck task, so a second host over the same files reads the first one's row.
        const second = createNodeAppHost({ ...options, worker });

        try {
            const response = await second.fetch(new Request("https://app.local/tenant-a"));

            await expect(response.json()).resolves.toMatchObject({ count: 2 });
        } finally {
            await second.close();
        }
    });

    it("waits for a shard's own waitUntil work before closing its database", async () => {
        expect.assertions(1);

        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let started: () => void = () => {};
        const backgroundStarted = new Promise<void>((resolve) => {
            started = resolve;
        });

        class Deferred {
            private readonly state: NodeShardState;

            public constructor(state: NodeShardState) {
                this.state = state;
            }

            public async fetch(): Promise<Response> {
                const { sql } = this.state.storage;

                sql.exec("CREATE TABLE IF NOT EXISTS hits (n INTEGER)");
                this.state.waitUntil(
                    (async () => {
                        started();
                        await gate;
                        sql.exec("INSERT INTO hits (n) VALUES (1)");
                    })(),
                );

                return new Response("ok");
            }
        }

        const options = {
            dataDirectory: join(directory, "state"),
            durableObjects: [{ className: "Deferred", name: "COUNTER" }],
            worker: { Deferred, default: worker.default },
        };
        const first = createNodeAppHost(options);

        await first.fetch(new Request("https://app.local/tenant-a"));
        await backgroundStarted;

        const closing = first.close();

        release();
        await closing;

        // The write landed before the close: the second host counts it alongside its own.
        const second = createNodeAppHost({ ...options, durableObjects: [{ className: "Counter", name: "COUNTER" }], worker });

        try {
            const response = await second.fetch(new Request("https://app.local/tenant-a"));

            await expect(response.json()).resolves.toMatchObject({ count: 2 });
        } finally {
            await second.close();
        }
    });

    it("refuses a shard write that resumes after the deadline closed its database, and keeps no part of it", async () => {
        expect.assertions(4);

        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let started: () => void = () => {};
        const requestStarted = new Promise<void>((resolve) => {
            started = resolve;
        });

        class SlowWriter {
            private readonly state: NodeShardState;

            public constructor(state: NodeShardState) {
                this.state = state;
            }

            public async fetch(): Promise<Response> {
                const { sql } = this.state.storage;

                sql.exec("CREATE TABLE IF NOT EXISTS hits (n INTEGER)");
                started();
                // Still running when the drain's deadline passes; it resumes against the database the close released.
                await gate;
                sql.exec("INSERT INTO hits (n) VALUES (1)");

                return new Response("ok");
            }
        }

        const options = {
            dataDirectory: join(directory, "state"),
            durableObjects: [{ className: "SlowWriter", name: "COUNTER" }],
            worker: { default: worker.default, SlowWriter },
        };
        const first = createNodeAppHost(options);
        const inFlight = first.fetch(new Request("https://app.local/tenant-a"));

        await requestStarted;

        let expire: () => void = () => {};
        const closing = first.close({
            timer: (_ms, onExpire) => {
                expire = onExpire;

                return () => {};
            },
        });

        expire();

        const drained = await closing;

        expect(drained.timedOut).toBe(true);
        expect(drained.pending.length).toBeGreaterThan(0);

        release();

        // The connection is closed, so the write throws instead of landing on a disposed database.
        await expect(inFlight).rejects.toThrow(/not open/u);

        const second = createNodeAppHost({ ...options, durableObjects: [{ className: "Counter", name: "COUNTER" }], worker });

        try {
            const response = await second.fetch(new Request("https://app.local/tenant-a"));

            // Only the second host's own write: nothing of the cut-off request was kept.
            await expect(response.json()).resolves.toMatchObject({ count: 1 });
        } finally {
            await second.close();
        }
    });

    it("closes the platforms it built when a later binding cannot be composed, so their crons never fire", async () => {
        expect.assertions(2);

        vi.useFakeTimers({ now: new Date("2026-11-01T12:00:30Z") });

        const delivered = vi.fn<() => void>();

        class Shard {
            // eslint-disable-next-line class-methods-use-this -- a delivery recorder has no state of its own
            public async fetch(): Promise<Response> {
                delivered();

                return Response.json({ result: null });
            }
        }

        try {
            expect(() =>
                createNodeAppHost({
                    crons: { "* * * * *": [{ functionPath: "reports:sweep", name: "sweep" }] },
                    durableObjects: [
                        { className: "Shard", name: "SHARD" },
                        { className: "Missing", name: "OTHER" },
                    ],
                    worker: { default: worker.default, Shard },
                }),
            ).toThrow(/names class Missing/);

            await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

            expect(delivered).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it("delivers a socket close to a Durable Object that defines only webSocketClose", async () => {
        expect.assertions(1);

        const closes: number[] = [];

        class CloseOnly {
            private readonly state: NodeShardState;

            public constructor(state: NodeShardState) {
                this.state = state;
            }

            // eslint-disable-next-line class-methods-use-this -- records the hook call; the instance holds nothing
            public webSocketClose(_socket: unknown, code: number): void {
                closes.push(code);
            }

            public async fetch(): Promise<Response> {
                // The contract types the pair's ends as unknown; this host's server end closes without a transport attached.
                (this.state.openSocketPair().server as { close: (code: number, reason: string) => void }).close(4001, "bye");

                return new Response("ok");
            }
        }

        const host = createNodeAppHost({ durableObjects: [{ className: "CloseOnly", name: "COUNTER" }], worker: { CloseOnly, default: worker.default } });

        try {
            await host.fetch(new Request("https://app.local/tenant-a"));

            expect(closes).toStrictEqual([4001]);
        } finally {
            await host.close();
        }
    });
});
