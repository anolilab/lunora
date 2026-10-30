/**
 * Live-query runs shared across subscribers, driven through the REAL emitted
 * `executeSubscription` / `buildCtx` (see `emit-shard-deferred-deletes.dispatch.test.ts`
 * for the harness) and real `@lunora/server` procedures.
 *
 * A path's run is shared across identities only once a run of it finished
 * without reading its caller, so what this suite pins is that every route a
 * handler has to the caller — `ctx.auth`, an `rls()` policy, a `mask()`, a
 * procedure middleware, a composed `ctx.runQuery` — marks the path. A missed
 * route would hand one user's result to another.
 *
 * Uses the `random-replay` golden, plus `delta-sync` for an app with a
 * `.global()` table: its global writer is handed the caller through getters, so
 * only a handler whose global access reads the caller is keyed by it.
 */
import { DatabaseSync } from "node:sqlite";

import { definePolicies, definePolicy, initLunora, mask, rls, v } from "@lunora/server";
import { beforeAll, describe, expect, it } from "vitest";

import { LUNORA_FUNCTIONS as GLOBAL_APP_FUNCTIONS } from "./fixtures/delta-sync/lunora/_generated/functions";
import { createShardDO as createGlobalAppShardDO } from "./fixtures/delta-sync/lunora/_generated/shard";
import { LUNORA_FUNCTIONS } from "./fixtures/random-replay/lunora/_generated/functions";
import { createShardDO } from "./fixtures/random-replay/lunora/_generated/shard";

interface FakeSocket {
    attachment: unknown;
    close: () => void;
    deserializeAttachment: () => unknown;
    send: (data: string) => void;
    sent: string[];
    serializeAttachment: (value: unknown) => void;
}

interface Shard {
    fetch: (request: Request) => Promise<Response>;
    webSocketMessage: (ws: unknown, message: string) => Promise<void>;
}

/** No `waitUntil`, so a write's refresh pass has finished when its `/rpc` resolves. */
const createState = (sockets: FakeSocket[]): unknown => {
    const database = new DatabaseSync(":memory:");
    const run = (query: string, ...parameters: unknown[]): unknown => {
        const rows = database.prepare(query).all(...(parameters as never[])) as unknown[];

        return { one: () => rows[0], toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
    };

    return {
        acceptWebSocket: (ws: FakeSocket) => {
            sockets.push(ws);
        },
        getWebSockets: () => sockets,
        id: { name: "shard-a" },
        storage: {
            sql: { exec: run },
            transaction: async <R>(closure: () => Promise<R>): Promise<R> => {
                run("BEGIN");

                try {
                    const result = await closure();

                    run("COMMIT");

                    return result;
                } catch (error) {
                    run("ROLLBACK");

                    throw error;
                }
            },
        },
    };
};

const runs = new Map<string, number>();

const count = (path: string): void => {
    runs.set(path, (runs.get(path) ?? 0) + 1);
};

const runsOf = (path: string): number => runs.get(path) ?? 0;

const lunora = initLunora.dataModel<Record<string, never>>().create();

interface Ctx {
    auth: { userId: null | string };
    db: { query: (table: string) => { collect: () => Promise<{ value: number }[]> } };
    runQuery: (reference: { __lunoraRef: string }, args: Record<string, unknown>, options?: { untracked?: boolean }) => Promise<unknown>;
}

const values = async (ctx: Ctx): Promise<number[]> => {
    const rows = await ctx.db.query("draws").collect();

    return rows.map((row) => row.value).toSorted((left, right) => left - right);
};

const register = (path: string, registered: unknown, functions: object = LUNORA_FUNCTIONS): void => {
    Object.assign(functions, { [path]: registered });
};

/** Every identity read below goes through a real accessor; each handler counts its own runs. */
const registerAll = (): void => {
    const query = lunora.query as unknown as {
        input: (shape: Record<string, unknown>) => { query: (handler: (input: { args: Record<string, unknown>; ctx: Ctx }) => unknown) => unknown };
        use: (middleware: unknown) => { query: (handler: (input: { ctx: Ctx & { viewer?: string } }) => unknown) => unknown };
    };

    register(
        "live:add",
        (
            lunora.mutation as unknown as {
                input: (shape: unknown) => { mutation: (handler: (input: { args: { value: number }; ctx: unknown }) => unknown) => unknown };
            }
        )
            .input({ value: v.number() })
            .mutation(async ({ args, ctx }) =>
                (ctx as { db: { insert: (table: string, row: unknown) => Promise<unknown> } }).db.insert("draws", { value: args.value }),
            ),
    );

    register(
        "live:public",
        query.input({}).query(async ({ ctx }) => {
            count("live:public");

            return values(ctx);
        }),
    );

    register(
        "live:drawsRandom",
        query.input({}).query(async ({ ctx }) => {
            count("live:drawsRandom");

            return { draw: (ctx as unknown as { random: () => number }).random() >= 0, values: await values(ctx) };
        }),
    );

    register(
        "live:mine",
        query.input({}).query(async ({ ctx }) => {
            count("live:mine");

            return { owner: ctx.auth.userId, values: await values(ctx) };
        }),
    );

    register(
        "live:claims",
        query.input({}).query(async ({ ctx }) => {
            count("live:claims");

            const identity = (await (ctx.auth as unknown as { getIdentity: () => Promise<{ userId: string } | null> }).getIdentity()) ?? null;

            return { owner: identity?.userId ?? null, values: await values(ctx) };
        }),
    );

    // Each user sees only their own value: A reads 1s, everyone else 2s.
    const ownValue = definePolicy<{ auth: { userId: null | string } }>({
        on: "read",
        table: "draws",
        when: ({ auth }) => {
            return { value: auth.userId === "user-A" ? 1 : 2 };
        },
    });

    register(
        "live:rls",
        query.use(rls(definePolicies([ownValue]) as never)).query(async ({ ctx }) => {
            count("live:rls");

            return values(ctx);
        }),
    );

    register(
        "live:masked",
        query.use(mask({ draws: { value: "redact" } } as never)).query(async ({ ctx }) => {
            count("live:masked");

            return values(ctx);
        }),
    );

    register(
        "live:middleware",
        query
            .use(async ({ ctx, next }: { ctx: Ctx; next: (input: { ctx: Record<string, unknown> }) => Promise<unknown> }) =>
                next({ ctx: { viewer: ctx.auth.userId ?? "anon" } }),
            )
            .query(async ({ ctx }) => {
                count("live:middleware");

                return { viewer: ctx.viewer, values: await values(ctx) };
            }),
    );

    register(
        "live:whoOnRequest",
        query.input({ who: v.optional(v.boolean()) }).query(async ({ args, ctx }) => {
            count("live:whoOnRequest");

            return { values: await values(ctx), who: args["who"] === true ? ctx.auth.userId : null };
        }),
    );

    // Reads the caller only once a 99 exists, so the run that first does is a run under the shared key.
    register(
        "live:whoOnData",
        query.input({}).query(async ({ ctx }) => {
            count("live:whoOnData");

            const current = await values(ctx);

            return { values: current, who: current.includes(99) ? ctx.auth.userId : null };
        }),
    );

    register(
        "live:ip",
        query.input({}).query(async ({ ctx }) => {
            count("live:ip");

            return { ip: (ctx as unknown as { ip?: string }).ip ?? null, values: await values(ctx) };
        }),
    );

    register(
        "live:nested",
        query.input({}).query(async ({ ctx }) => {
            count("live:nested");

            return ctx.runQuery({ __lunoraRef: "live:mine" }, {});
        }),
    );

    register(
        "live:nestedUntracked",
        query.input({}).query(async ({ ctx }) => {
            count("live:nestedUntracked");

            // Its own read is what re-runs it: an untracked sub-query's reads never do.
            await values(ctx);

            return ctx.runQuery({ __lunoraRef: "live:mine" }, {}, { untracked: true });
        }),
    );
};

const USERS = ["user-A", "user-B", "user-C", "user-D"];

interface HarnessOptions {
    config?: unknown;
    /** The emitted `createShardDO` and its config; the `random-replay` shard by default. */
    create?: (config: never) => new (state: never, env: never) => unknown;
    writeArgs?: (value: number) => Record<string, unknown>;
    /** The mutation `write` calls and the args it sends for a value. */
    writePath?: string;
}

const createHarness = ({
    config = {},
    create = createShardDO,
    writeArgs = (value) => {
        return { value };
    },
    writePath = "live:add",
}: HarnessOptions = {}): {
    shard: Shard;
    /** An `ip:`-prefixed caller subscribes anonymously from that address. */
    subscribe: (caller: string, functionPath: string, args?: Record<string, unknown>) => Promise<FakeSocket>;
    write: (value: number) => Promise<void>;
} => {
    const sockets: FakeSocket[] = [];
    const ShardClass = create(config as never);
    const state = createState(sockets) as { acceptWebSocket: (ws: FakeSocket) => void };
    const shard = new ShardClass(state as never, {} as never) as Shard;

    return {
        shard,
        subscribe: async (caller, functionPath, args = {}) => {
            const ws: FakeSocket = {
                attachment: undefined,
                close: () => undefined,
                deserializeAttachment() {
                    return this.attachment;
                },
                send(data: string) {
                    this.sent.push(data);
                },
                sent: [],
                serializeAttachment(value: unknown) {
                    this.attachment = value;
                },
            };

            state.acceptWebSocket(ws);
            ws.serializeAttachment(caller.startsWith("ip:") ? { ip: caller.slice(3), subs: {} } : { identity: { userId: caller }, subs: {}, userId: caller });
            await shard.webSocketMessage(ws, JSON.stringify({ id: "sub", query: { args, functionPath }, type: "subscribe" }));

            return ws;
        },
        write: async (value) => {
            const response = await shard.fetch(
                new Request("https://shard.internal/rpc", {
                    body: JSON.stringify({ args: writeArgs(value), functionPath: writePath }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                }),
            );

            if (!response.ok) {
                throw new Error(`write failed: ${await response.text()}`);
            }
        },
    };
};

/** The data of the last `{type:"data"}` frame a socket received. */
const lastData = (ws: FakeSocket): unknown =>
    ws.sent.map((line) => JSON.parse(line) as { data?: unknown; type: string }).findLast((frame) => frame.type === "data")?.data;

/** Subscribes every user, one after another, and returns the handler runs the next write causes. */
const subscribeAllThenWrite = async (
    path: string,
    value = 1,
    harness = createHarness(),
): Promise<{ delta: number; sockets: FakeSocket[]; write: (next: number) => Promise<number> }> => {
    const sockets: FakeSocket[] = [];

    for (const userId of USERS) {
        // eslint-disable-next-line no-await-in-loop -- sequential seeds never join each other's run
        sockets.push(await harness.subscribe(userId, path));
    }

    const write = async (next: number): Promise<number> => {
        const before = runsOf(path);

        await harness.write(next);

        return runsOf(path) - before;
    };

    return { delta: await write(value), sockets, write };
};

describe("emitted shard — live runs shared across identities", () => {
    beforeAll(registerAll);

    it("runs a public query that never reads its caller once per write", async () => {
        expect.assertions(2);

        const { delta, sockets } = await subscribeAllThenWrite("live:public");

        expect(delta).toBe(1);
        expect(sockets.map((ws) => lastData(ws))).toStrictEqual(USERS.map(() => [1]));
    });

    it.each(["live:mine", "live:claims"])("runs %s, which reads the caller, once per user, each with its own result", async (path) => {
        expect.assertions(2);

        const { delta, sockets } = await subscribeAllThenWrite(path);

        expect(delta).toBe(USERS.length);
        expect(sockets.map((ws) => (lastData(ws) as { owner: string }).owner)).toStrictEqual(USERS);
    });

    it("never shares an rls()-filtered run: each user receives only the rows its policy allows", async () => {
        expect.assertions(3);

        const harness = createHarness();

        await harness.write(1);
        await harness.write(2);

        const { delta, sockets } = await subscribeAllThenWrite("live:rls", 1, harness);

        expect(delta).toBe(USERS.length);
        expect(lastData(sockets[0] as FakeSocket)).toStrictEqual([1, 1]);
        expect(sockets.slice(1).map((ws) => lastData(ws))).toStrictEqual(USERS.slice(1).map(() => [2]));
    });

    it("never shares a mask()ed run", async () => {
        expect.assertions(1);

        const { delta } = await subscribeAllThenWrite("live:masked");

        expect(delta).toBe(USERS.length);
    });

    it("never shares a run whose procedure middleware reads the caller", async () => {
        expect.assertions(2);

        const { delta, sockets } = await subscribeAllThenWrite("live:middleware");

        expect(delta).toBe(USERS.length);
        expect(sockets.map((ws) => (lastData(ws) as { viewer: string }).viewer)).toStrictEqual(USERS);
    });

    it("never shares a run that reads ctx.ip across anonymous callers on different addresses", async () => {
        expect.assertions(2);

        const harness = createHarness();
        const addresses = ["203.0.113.1", "203.0.113.2", "203.0.113.3"];
        const sockets: FakeSocket[] = [];

        for (const address of addresses) {
            // eslint-disable-next-line no-await-in-loop -- sequential seeds never join each other's run
            sockets.push(await harness.subscribe(`ip:${address}`, "live:ip"));
        }

        const before = runsOf("live:ip");

        await harness.write(1);

        expect(runsOf("live:ip") - before).toBe(addresses.length);
        expect(sockets.map((ws) => (lastData(ws) as { ip: string }).ip)).toStrictEqual(addresses);
    });

    it("keeps sharing a public query after a client calls it over /rpc with a replay key", async () => {
        expect.assertions(2);

        const harness = createHarness();
        const response = await harness.shard.fetch(
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "live:public" }),
                headers: { "content-type": "application/json", "x-lunora-mutation-id": "replay-1", "x-lunora-userid": "user-A" },
                method: "POST",
            }),
        );

        expect(response.ok).toBe(true);

        const { delta } = await subscribeAllThenWrite("live:public", 1, harness);

        // The replay key only scopes ids and random draws; a handler that never reads them never read the caller.
        expect(delta).toBe(1);
    });

    it("keeps sharing a query that draws random after a client calls it over /rpc with a replay key", async () => {
        expect.assertions(2);

        const harness = createHarness();
        const response = await harness.shard.fetch(
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "live:drawsRandom" }),
                headers: { "content-type": "application/json", "x-lunora-mutation-id": "replay-1", "x-lunora-userid": "user-A" },
                method: "POST",
            }),
        );

        expect(response.ok).toBe(true);

        const { delta } = await subscribeAllThenWrite("live:drawsRandom", 1, harness);

        // A query's random sequence never uses the replay key, so drawing from it must not read the caller.
        expect(delta).toBe(1);
    });

    it.each(["live:nested", "live:nestedUntracked"])("marks the outer path when %s composes a query that reads the caller", async (path) => {
        expect.assertions(2);

        const { delta, sockets } = await subscribeAllThenWrite(path);

        expect(delta).toBe(USERS.length);
        expect(sockets.map((ws) => (lastData(ws) as { owner: string }).owner)).toStrictEqual(USERS);
    });

    it("stops sharing a path for good once a subscription with an argument makes it read the caller", async () => {
        expect.assertions(4);

        const harness = createHarness();
        const { delta, sockets, write } = await subscribeAllThenWrite("live:whoOnRequest", 1, harness);

        expect(delta).toBe(1);

        const asker = await harness.subscribe("user-Z", "live:whoOnRequest", { who: true });

        // The four shared-arg sockets are keyed by caller now; the asker runs on its own too.
        await expect(write(2)).resolves.toBe(USERS.length + 1);
        expect((lastData(asker) as { who: string }).who).toBe("user-Z");
        expect(sockets.map((ws) => (lastData(ws) as { who: null }).who)).toStrictEqual(USERS.map(() => null));
    });

    it("does not hand the shared run that first reads the caller to the other subscribers", async () => {
        expect.assertions(4);

        const { delta, sockets, write } = await subscribeAllThenWrite("live:whoOnData");

        expect(delta).toBe(1);
        // The shared run reads the caller; every other subscriber re-runs under its own identity.
        await expect(write(99)).resolves.toBe(USERS.length);
        expect(sockets.map((ws) => (lastData(ws) as { who: string }).who)).toStrictEqual(USERS);
        await expect(write(3)).resolves.toBe(USERS.length);
    });
});

describe("emitted shard with a .global() table — live runs shared across identities", () => {
    /** The global writer reads its request's caller only when a handler reaches the global table. */
    const globalApp = (): ReturnType<typeof createHarness> =>
        createHarness({
            config: {
                d1: (_env: unknown, request: { userId?: string }) => {
                    return {
                        findMany: async () => [{ name: "board", ownerId: request.userId ?? null }],
                    };
                },
            },
            create: createGlobalAppShardDO as unknown as NonNullable<HarnessOptions["create"]>,
            writeArgs: (value) => {
                return { body: String(value), boardId: "shard-a" };
            },
            writePath: "global:add",
        });

    beforeAll(() => {
        const procedures = lunora as unknown as {
            mutation: { input: (shape: unknown) => { mutation: (handler: (input: { args: Record<string, unknown>; ctx: never }) => unknown) => unknown } };
            query: { input: (shape: unknown) => { query: (handler: (input: { ctx: never }) => unknown) => unknown } };
        };
        type GlobalCtx = {
            db: {
                findMany: (table: string, args?: unknown) => Promise<{ ownerId: null | string }[]>;
                insert: (table: string, row: unknown) => Promise<unknown>;
                query: (table: string) => { collect: () => Promise<{ body: string }[]> };
            };
        };
        const bodies = async (ctx: GlobalCtx): Promise<string[]> => {
            const rows = await ctx.db.query("notes").collect();

            return rows.map((row) => row.body).toSorted((left, right) => left.localeCompare(right));
        };

        register(
            "global:add",
            procedures.mutation
                .input({ body: v.string(), boardId: v.string() })
                .mutation(async ({ args, ctx }) => (ctx as GlobalCtx).db.insert("notes", { body: args["body"], boardId: args["boardId"], ownerId: "x" })),
            GLOBAL_APP_FUNCTIONS,
        );
        register(
            "global:public",
            procedures.query.input({}).query(async ({ ctx }) => {
                count("global:public");

                return bodies(ctx);
            }),
            GLOBAL_APP_FUNCTIONS,
        );
        register(
            "global:boards",
            procedures.query.input({}).query(async ({ ctx }) => {
                count("global:boards");

                const boards = await (ctx as GlobalCtx).db.findMany("boards", {});

                return { bodies: await bodies(ctx), owner: boards[0]?.ownerId ?? null };
            }),
            GLOBAL_APP_FUNCTIONS,
        );
    });

    it("runs a public query that never reaches the global writer once per write", async () => {
        expect.assertions(2);

        const { delta, sockets } = await subscribeAllThenWrite("global:public", 1, globalApp());

        expect(delta).toBe(1);
        expect(sockets.map((ws) => lastData(ws))).toStrictEqual(USERS.map(() => ["1"]));
    });

    it("never shares a run whose global read reaches the caller", async () => {
        expect.assertions(2);

        const { delta, sockets } = await subscribeAllThenWrite("global:boards", 1, globalApp());

        expect(delta).toBe(USERS.length);
        expect(sockets.map((ws) => (lastData(ws) as { owner: string }).owner)).toStrictEqual(USERS);
    });
});
