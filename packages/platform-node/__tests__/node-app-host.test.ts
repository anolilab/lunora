import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkNodeAppHost, createNodeAppHost } from "../src/node-app-host";
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

/** The declared cron rows the shard binding's platform database holds, as `name → function path`. */
const declaredCrons = (dataDirectory: string, binding = "SHARD"): Record<string, string> => {
    const database = new Database(join(dataDirectory, `${binding}.platform.sqlite3`), { readonly: true });

    try {
        const rows = database.prepare<[], { function_path: string; key: string }>("SELECT key, function_path FROM _lunora_scheduler_crons").all();

        return Object.fromEntries(rows.map((row) => [row.key, row.function_path]));
    } finally {
        database.close();
    }
};

/** A shard class that answers every call, for hosts whose test reads stored state rather than responses. */
class Quiet {
    // eslint-disable-next-line class-methods-use-this -- answers without state
    public async fetch(): Promise<Response> {
        return Response.json({ result: null });
    }
}

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

    it("refuses a binding whose export cannot be constructed, before building anything", () => {
        expect.assertions(2);

        const options = {
            durableObjects: [{ className: "Arrow", name: "COUNTER" }],
            worker: {
                Arrow: () => {
                    return {};
                },
                default: worker.default,
            },
        };

        expect(() => {
            checkNodeAppHost(options);
        }).toThrow(/cannot construct/u);
        expect(() => createNodeAppHost(options)).toThrow(/cannot construct/u);
    });

    it("deletes the crons an earlier host declared when the next one declares none", async () => {
        expect.assertions(2);

        const dataDirectory = join(directory, "state");
        const base = { dataDirectory, durableObjects: [{ className: "Quiet", name: "SHARD" }], worker: { default: worker.default, Quiet } };

        await createNodeAppHost({ ...base, crons: { "0 * * * *": [{ functionPath: "reports:sweep", name: "sweep" }] } }).close();

        expect(Object.values(declaredCrons(dataDirectory))).toStrictEqual(["reports:sweep"]);

        await createNodeAppHost(base).close();

        expect(declaredCrons(dataDirectory)).toStrictEqual({});
    });

    it("leaves the declared crons as they were when a candidate host is refused", async () => {
        expect.assertions(2);

        const dataDirectory = join(directory, "state");
        const appWorker = { default: worker.default, Quiet };

        await createNodeAppHost({
            crons: { "0 * * * *": [{ functionPath: "reports:a", name: "sweep" }] },
            dataDirectory,
            durableObjects: [{ className: "Quiet", name: "SHARD" }],
            worker: appWorker,
        }).close();

        // SHARD comes first, so a host that built bindings in order would have rewritten the row before reaching the missing one.
        expect(() =>
            createNodeAppHost({
                crons: { "0 * * * *": [{ functionPath: "reports:b", name: "sweep" }] },
                dataDirectory,
                durableObjects: [
                    { className: "Quiet", name: "SHARD" },
                    { className: "Missing", name: "OTHER" },
                ],
                worker: appWorker,
            }),
        ).toThrow(/names class Missing/u);
        expect(Object.values(declaredCrons(dataDirectory))).toStrictEqual(["reports:a"]);
    });

    it("refuses a binding name that would put its storage outside the data directory", () => {
        expect.assertions(2);

        const options = {
            dataDirectory: join(directory, "state"),
            durableObjects: [{ className: "Counter", name: "../escape" }],
            worker,
        };

        expect(() => {
            checkNodeAppHost(options);
        }).toThrow(/not a valid binding name/u);
        expect(() => createNodeAppHost(options)).toThrow(/not a valid binding name/u);
    });

    it("refuses a binding whose shard directory links out of the data directory", () => {
        expect.assertions(1);

        const dataDirectory = join(directory, "state");

        mkdirSync(join(directory, "elsewhere"), { recursive: true });
        mkdirSync(dataDirectory, { recursive: true });
        symlinkSync(join(directory, "elsewhere"), join(dataDirectory, "COUNTER"), "dir");

        expect(() => createNodeAppHost({ dataDirectory, durableObjects: [{ className: "Counter", name: "COUNTER" }], worker })).toThrow(/links out of it/u);
    });

    it("finishes a request that reaches its Durable Object only after close began", async () => {
        expect.assertions(1);

        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const host = createNodeAppHost({
            dataDirectory: join(directory, "state"),
            durableObjects: [{ className: "Counter", name: "COUNTER" }],
            worker: {
                Counter,
                default: {
                    fetch: async (request: Request, env: Parameters<typeof worker.default.fetch>[1]) => {
                        // Still before its first shard access when the close starts.
                        await gate;

                        return worker.default.fetch(request, env);
                    },
                },
            },
        });
        const answered = host.fetch(new Request("https://app.local/tenant-a"));
        const closing = host.close();

        // A turn later, when a drain that saw nothing running would already have closed the shards.
        setImmediate(release);

        const response = await answered;

        await closing;

        await expect(response.json()).resolves.toMatchObject({ count: 1 });
    });

    it("refuses two bindings whose names differ only in case, or one declared twice", () => {
        expect.assertions(2);

        expect(() => {
            checkNodeAppHost({
                durableObjects: [
                    { className: "Counter", name: "CACHE" },
                    { className: "Counter", name: "cache" },
                ],
                worker,
            });
        }).toThrow(/differ only in case/u);
        expect(() => {
            checkNodeAppHost({
                durableObjects: [
                    { className: "Counter", name: "CACHE" },
                    { className: "Counter", name: "CACHE" },
                ],
                worker,
            });
        }).toThrow(/declared twice/u);
    });

    it("refuses a class name the worker module only inherits", () => {
        expect.assertions(1);

        // `constructor` resolves to Object through the prototype of any module record.
        expect(() => {
            checkNodeAppHost({ durableObjects: [{ className: "constructor", name: "COUNTER" }], worker });
        }).toThrow(/does not export/u);
    });

    it("installs a binding named __proto__ as an own property of env", async () => {
        expect.assertions(1);

        const host = createNodeAppHost({
            durableObjects: [{ className: "Counter", name: "__proto__" }],
            worker: { Counter, default: { fetch: async (_request: Request, env: Record<string, unknown>) => Response.json(Object.hasOwn(env, "__proto__")) } },
        });

        try {
            const response = await host.fetch(new Request("https://app.local/"));

            await expect(response.json()).resolves.toBe(true);
        } finally {
            await host.close();
        }
    });

    it("refuses a platform database path that is a link to nothing", () => {
        expect.assertions(1);

        const dataDirectory = join(directory, "state");

        mkdirSync(dataDirectory, { recursive: true });
        // SQLite would follow this and create the database outside the data directory.
        const databaseFile = ["COUNTER", "platform", "sqlite3"].join(".");

        symlinkSync(join(directory, "elsewhere", databaseFile), join(dataDirectory, databaseFile));

        expect(() => createNodeAppHost({ dataDirectory, durableObjects: [{ className: "Counter", name: "COUNTER" }], worker })).toThrow(/link to nothing/u);
    });

    it("treats a constructor whose blockConcurrencyWhile rejects as broken: the request fails, and the next one constructs anew", async () => {
        expect.assertions(4);

        let constructions = 0;

        class FailsFirstInit {
            private ready = false;

            public constructor(state: NodeShardState) {
                constructions += 1;

                const attempt = constructions;

                // As a Lunora shard does: setup the constructor cannot await, gated behind blockConcurrencyWhile.
                // eslint-disable-next-line no-void, sonarjs/no-async-constructor -- the scenario under test: the promise is left to the host
                void state.blockConcurrencyWhile(async () => {
                    if (attempt === 1) {
                        throw new Error("schema migration failed");
                    }

                    this.ready = true;
                });
            }

            public async fetch(): Promise<Response> {
                return Response.json({ constructions, ready: this.ready });
            }
        }

        const unhandled = vi.fn<(reason: unknown) => void>();

        process.on("unhandledRejection", unhandled);

        const host = createNodeAppHost({
            durableObjects: [{ className: "FailsFirstInit", name: "COUNTER" }],
            worker: { default: worker.default, FailsFirstInit },
        });

        try {
            await expect(host.fetch(new Request("https://app.local/tenant-a"))).rejects.toThrow(/schema migration failed/u);

            // One event-loop turn, which is where Node reports a rejection nobody handled.
            await new Promise<void>((resolve) => {
                setImmediate(resolve);
            });

            expect(unhandled).not.toHaveBeenCalled();

            const response = await host.fetch(new Request("https://app.local/tenant-a"));

            // A fresh instance, constructed for this request and ready before it was served.
            await expect(response.json()).resolves.toStrictEqual({ constructions: 2, ready: true });
            expect(constructions).toBe(2);
        } finally {
            process.off("unhandledRejection", unhandled);
            await host.close();
        }
    });
});
