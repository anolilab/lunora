/**
 * A `.global()` write on one shard reaches the live queries another shard holds. Two instances of
 * the REAL emitted `delta-sync` shard share one global store (a real `@lunora/d1` writer over
 * `node:sqlite`, changelog on). Shard A writes; shard B learns of it from the changelog on its next
 * poll tick, which the test drives by calling `alarm()`.
 */
import { DatabaseSync } from "node:sqlite";

import { createD1CtxDb } from "@lunora/d1";
import { initLunora, v } from "@lunora/server";
import { beforeAll, describe, expect, it } from "vitest";

import { LUNORA_FUNCTIONS } from "./fixtures/delta-sync/lunora/_generated/functions";
import { createShardDO } from "./fixtures/delta-sync/lunora/_generated/shard";
import schema from "./fixtures/delta-sync/lunora/schema";

interface FakeSocket {
    attachment: unknown;
    close: () => void;
    deserializeAttachment: () => unknown;
    send: (data: string) => void;
    sent: string[];
    serializeAttachment: (value: unknown) => void;
}

interface Shard {
    alarm: () => Promise<void>;
    fetch: (request: Request) => Promise<Response>;
    webSocketMessage: (ws: unknown, message: string) => Promise<void>;
}

interface GlobalRequest {
    bookmark?: string;
    cdc?: boolean;
    onBookmark?: (bookmark: string | undefined) => void;
    onWrite?: (table: string, settledLate?: boolean) => void;
}

const OWNER = "owner-1";

/** A Durable Object's own storage: one `node:sqlite` database per instance. No `waitUntil`, so a refresh has run when the call that scheduled it resolves. */
const createState = (sockets: FakeSocket[], name: string): unknown => {
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
        id: { name },
        storage: {
            setAlarm: () => Promise.resolve(),
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

/** What the shared global store saw: the bookmark each `boards` read was opened with, and each bookmark a statement reported. */
interface GlobalLog {
    /** While set, a read of the changelog fails and every other statement still runs. */
    failChangelog: boolean;
    reads: { bookmark: string | undefined }[];
    /** Every bookmark reported, with the request (one per ctx, so per dispatch) and statement that reported it. */
    reports: { bookmark: string; query: string; request: GlobalRequest }[];
}

/**
 * Two shards over one global store, each with the live query `cross:boards` available. Each statement
 * reports a fresh session bookmark, as D1 does, so a test can tell which bookmark a read started at.
 */
const createPair = (): { a: Shard; aSockets: FakeSocket[]; b: Shard; bSockets: FakeSocket[]; log: GlobalLog } => {
    const global = new DatabaseSync(":memory:");
    const log: GlobalLog = { failChangelog: false, reads: [], reports: [] };
    const all = (query: string, parameters: ReadonlyArray<unknown>): Record<string, unknown>[] => global.prepare(query).all(...(parameters as never[]));
    const sessionExec = (request: GlobalRequest) => {
        const statement = (query: string, parameters: ReadonlyArray<unknown>): Record<string, unknown>[] => {
            if (log.failChangelog && query.startsWith("SELECT") && query.includes("__cdc_log")) {
                throw new Error("changelog read failed");
            }

            if (query.startsWith("SELECT") && query.includes('FROM "boards"')) {
                log.reads.push({ bookmark: request.bookmark });
            }

            const rows = all(query, parameters);
            const reported = `bookmark-${String(log.reports.length + 1)}`;

            log.reports.push({ bookmark: reported, query, request });
            request.onBookmark?.(reported);

            return rows;
        };

        return {
            all: (query: string, parameters: ReadonlyArray<unknown>) => Promise.resolve(statement(query, parameters)),
            run: (query: string, parameters: ReadonlyArray<unknown>) => {
                statement(query, parameters);

                return Promise.resolve();
            },
        };
    };
    const ShardClass = createShardDO({
        cdc: true,
        d1: ((_env: unknown, request: GlobalRequest) =>
            createD1CtxDb({
                cdc: request.cdc ?? false,
                exec: sessionExec(request),
                ...(request.onWrite === undefined ? {} : { onWrite: request.onWrite }),
                schema: schema as never,
            })) as never,
    }) as unknown as new (state: never, env: never) => Shard;
    const aSockets: FakeSocket[] = [];
    const bSockets: FakeSocket[] = [];

    return {
        a: new ShardClass(createState(aSockets, "shard-a") as never, {} as never),
        aSockets,
        b: new ShardClass(createState(bSockets, "shard-b") as never, {} as never),
        bSockets,
        log,
    };
};

const subscribe = async (shard: Shard, sockets: FakeSocket[]): Promise<FakeSocket> => {
    const ws: FakeSocket = {
        attachment: { identity: { userId: OWNER }, subs: {}, userId: OWNER },
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

    sockets.push(ws);
    await shard.webSocketMessage(ws, JSON.stringify({ id: "boards", query: { args: {}, functionPath: "cross:boards" }, type: "subscribe" }));

    return ws;
};

const call = async (shard: Shard, functionPath: string, args: Record<string, unknown>): Promise<unknown> => {
    const response = await shard.fetch(
        new Request("https://shard.internal/rpc", {
            body: JSON.stringify({ args, functionPath }),
            headers: { "content-type": "application/json", "x-lunora-userid": OWNER },
            method: "POST",
        }),
    );

    if (!response.ok) {
        throw new Error(`${functionPath} failed: ${await response.text()}`);
    }

    return ((await response.json()) as { result?: unknown }).result;
};

/** The board names in the last `{type:"data"}` frame the socket received. */
const lastNames = (ws: FakeSocket): unknown =>
    ws.sent.map((line) => JSON.parse(line) as { data?: unknown; type: string }).findLast((frame) => frame.type === "data")?.data;

describe("emitted shard — a .global() write refreshes live queries on another shard", () => {
    beforeAll(() => {
        const lunora = initLunora.dataModel<Record<string, never>>().create() as unknown as {
            mutation: { input: (shape: unknown) => { mutation: (handler: (input: { args: Record<string, string>; ctx: never }) => unknown) => unknown } };
            query: { input: (shape: unknown) => { query: (handler: (input: { ctx: never }) => unknown) => unknown } };
        };
        type Database = {
            delete: (table: string, id: string) => Promise<void>;
            findMany: (table: string, args?: unknown) => Promise<{ page: { name: string }[] }>;
            insert: (table: string, row: unknown) => Promise<string>;
            patch: (table: string, id: string, patch: unknown) => Promise<void>;
            patchIf: (table: string, id: string, args: unknown) => Promise<unknown>;
            replace: (table: string, id: string, row: unknown) => Promise<void>;
        };
        const db = (ctx: never): Database => (ctx as { db: Database }).db;
        const writeArgs = { id: v.optional(v.string()), name: v.optional(v.string()) };

        Object.assign(LUNORA_FUNCTIONS, {
            "cross:boards": lunora.query.input({}).query(async ({ ctx }) => {
                const { page } = await db(ctx).findMany("boards", {});

                return page.map((row) => row.name).toSorted((left, right) => left.localeCompare(right));
            }),
            "cross:insert": lunora.mutation
                .input(writeArgs)
                .mutation(async ({ args, ctx }) => db(ctx).insert("boards", { name: args["name"], ownerId: OWNER })),
            "cross:patch": lunora.mutation
                .input(writeArgs)
                .mutation(async ({ args, ctx }) => db(ctx).patch("boards", args["id"] as string, { name: args["name"] })),
            "cross:patchIf": lunora.mutation
                .input(writeArgs)
                .mutation(async ({ args, ctx }) =>
                    db(ctx).patchIf("boards", args["id"] as string, { patch: { name: args["name"] }, where: { ownerId: OWNER } }),
                ),
            "cross:remove": lunora.mutation.input(writeArgs).mutation(async ({ args, ctx }) => db(ctx).delete("boards", args["id"] as string)),
            "cross:replace": lunora.mutation
                .input(writeArgs)
                .mutation(async ({ args, ctx }) => db(ctx).replace("boards", args["id"] as string, { name: args["name"], ownerId: OWNER })),
        });
    });

    /** Shard B holds the live query with its poll cursor set before A writes, so the tick after is told what moved. */
    const watch = async (): Promise<{ a: Shard; b: Shard; id: string; watcher: FakeSocket }> => {
        const { a, b, bSockets } = createPair();
        const id = (await call(a, "cross:insert", { name: "first" })) as string;
        const watcher = await subscribe(b, bSockets);

        await b.alarm();

        return { a, b, id, watcher };
    };

    it("an insert", async () => {
        expect.assertions(2);

        const { a, b, watcher } = await watch();

        expect(lastNames(watcher)).toStrictEqual(["first"]);

        await call(a, "cross:insert", { name: "second" });
        await b.alarm();

        expect(lastNames(watcher)).toStrictEqual(["first", "second"]);
    });

    it.each([
        ["a patch", "cross:patch"],
        ["a replace", "cross:replace"],
        ["a patchIf", "cross:patchIf"],
    ])("%s", async (_name, functionPath) => {
        expect.assertions(1);

        const { a, b, id, watcher } = await watch();

        await call(a, functionPath, { id, name: "renamed" });
        await b.alarm();

        expect(lastNames(watcher)).toStrictEqual(["renamed"]);
    });

    it("a delete", async () => {
        expect.assertions(1);

        const { a, b, id, watcher } = await watch();

        await call(a, "cross:remove", { id });
        await b.alarm();

        expect(lastNames(watcher)).toStrictEqual([]);
    });

    it("refreshes the writing shard's live query at one bookmark, the write's last, with the changelog on", async () => {
        expect.assertions(2);

        const { a, aSockets, log } = createPair();
        const watcher = await subscribe(a, aSockets);

        await call(a, "cross:insert", { name: "first" });

        // The row write and the changelog append each reported a bookmark; the refresh opens at the later one.
        const writer = log.reports.find((report) => report.query.startsWith('INSERT INTO "boards"'))?.request;
        const lastOfWrite = log.reports.findLast((report) => report.request === writer)?.bookmark;

        expect(lastNames(watcher)).toStrictEqual(["first"]);
        expect(log.reads.at(-1)?.bookmark).toBe(lastOfWrite);
    });

    it("refreshes another shard's live query at the primary when its changelog read fails", async () => {
        expect.assertions(2);

        const { a, b, bSockets, log } = createPair();
        const watcher = await subscribe(b, bSockets);

        await b.alarm();
        await call(a, "cross:insert", { name: "while-blind" });
        log.failChangelog = true;
        await b.alarm();

        expect(lastNames(watcher)).toStrictEqual(["while-blind"]);
        expect(log.reads.at(-1)?.bookmark).toBe("first-primary");
    });
});
