import { describe, expect, it } from "vitest";

import type { EventsFacade } from "../src/index";
import { EventLogDOClient, eventsContext } from "../src/index";

// ── Helpers ────────────────────────────────────────────────────────────

/** Build an EventLogDOClient backed by an in-memory DO stub. */
const createTestClient = (): EventLogDOClient => {
    // In-memory event store that mirrors EventLogDO's contract
    let nextSeq = 0;
    const entries: {
        payload: unknown;
        seq: number;
        timestamp: number;
        type: string;
    }[] = [];

    const stub = async (req: Request): Promise<Response> => {
        const url = new URL(req.url);

        if (url.pathname === "/append" && req.method === "POST") {
            const { events } = (await req.json()) as {
                events: { payload: unknown; timestamp?: number; type: string }[];
            };
            const persisted = events.map((e) => {
                const entry = {
                    seq: nextSeq++,
                    type: e.type,
                    payload: e.payload,
                    timestamp: e.timestamp ?? Date.now(),
                };
                entries.push(entry);
                return entry;
            });
            return Response.json({ entries: persisted });
        }

        if (url.pathname === "/since") {
            const seq = Number(url.searchParams.get("seq") ?? "0");
            const limit = Number(url.searchParams.get("limit") ?? "500");
            const matching = entries.filter((e) => e.seq >= seq);
            const page = matching.slice(0, limit);
            const truncated = matching.length > page.length;
            return Response.json({
                cursor: truncated ? page[page.length - 1]!.seq + 1 : undefined,
                entries: page,
                truncated,
            });
        }

        if (url.pathname === "/size") {
            return Response.json({ count: entries.length });
        }

        if (url.pathname === "/state") {
            return Response.json({ entries: [...entries], nextSeq });
        }

        return new Response("Not found", { status: 404 });
    };

    return new EventLogDOClient({ fetch: stub });
};

// ── Middleware test helpers ─────────────────────────────────────────────

interface MockNext {
    (): Promise<Record<string, unknown>>;
    <E extends Record<string, unknown>>(opts: { ctx: E }): Promise<E & Record<string, unknown>>;
}

/**
 * Create a mock `next` that records what extension was passed.
 * When called with `{ ctx }` it merges the extension over the (remembered)
 * original input context so the result behaves like the real runMiddleware
 * chain — simulating `ContextIn & Extension`.
 */
const createNext = (originalCtx: Record<string, unknown>): MockNext => {
    const fn = ((opts?: { ctx: Record<string, unknown> }): Promise<Record<string, unknown>> => {
        if (opts?.ctx) {
            return Promise.resolve({ ...originalCtx, ...opts.ctx } as Record<string, unknown>);
        }
        return Promise.resolve(originalCtx);
    }) as MockNext;

    return fn;
};

// ── Tests ──────────────────────────────────────────────────────────────

describe("eventsContext middleware", () => {
    it("attaches ctx.events with expected facade methods", async () => {
        expect.assertions(5);

        const client = createTestClient();
        const middleware = eventsContext(client);

        const result = await middleware({
            ctx: {},
            next: createNext({}),
        });

        expect(result).toHaveProperty("events");
        expect(result.events.append).toBeTypeOf("function");
        expect(result.events.getSince).toBeTypeOf("function");
        expect(result.events.getSize).toBeTypeOf("function");
        expect(result.events.getState).toBeTypeOf("function");
    });

    it("preserves existing ctx fields through next merge", async () => {
        expect.assertions(4);

        const client = createTestClient();
        const middleware = eventsContext(client);
        const inputCtx = { existing: "value", auth: { userId: "u1" } };

        const result = await middleware({
            ctx: inputCtx,
            next: createNext(inputCtx),
        });

        expect(result).toHaveProperty("existing", "value");
        expect(result).toHaveProperty("auth");
        expect((result as unknown as { auth: { userId: string } }).auth).toEqual({
            userId: "u1",
        });
        expect(result).toHaveProperty("events");
    });

    it("ctx.events.append delegates to the DO client", async () => {
        expect.assertions(5);

        const client = createTestClient();
        const middleware = eventsContext(client);

        const { events } = (await middleware({
            ctx: {},
            next: createNext({}),
        })) as { events: EventsFacade };

        const input = { type: "test.event", payload: { key: "val" } };
        const [entry] = await events.append([input]);

        expect(entry).toBeDefined();
        expect(entry!.type).toBe("test.event");
        expect(entry!.payload).toEqual({ key: "val" });
        expect(entry!.seq).toBe(0);
        expect(entry!.timestamp).toBeTypeOf("number");
    });

    it("ctx.events.getSince returns entries after watermark", async () => {
        expect.assertions(2);

        const client = createTestClient();
        const middleware = eventsContext(client);

        const { events } = (await middleware({
            ctx: {},
            next: createNext({}),
        })) as { events: EventsFacade };

        await events.append([{ type: "a", payload: null }]);
        await events.append([{ type: "b", payload: null }]);

        const since = await events.getSince(1);

        expect(since.entries).toHaveLength(1);
        expect(since.entries[0]!.type).toBe("b");
    });

    it("ctx.events.getSince pages through the log", async () => {
        expect.assertions(6);

        const client = createTestClient();
        const middleware = eventsContext(client);

        const { events } = (await middleware({
            ctx: {},
            next: createNext({}),
        })) as { events: EventsFacade };

        for (let i = 0; i < 5; i += 1) {
            await events.append([{ type: `e${i}`, payload: i }]);
        }

        const page = await events.getSince(2, 2);

        expect(page.entries).toHaveLength(2);
        expect(page.entries[0]!.seq).toBe(2);
        expect(page.entries[1]!.seq).toBe(3);
        expect(page.truncated).toBe(true);

        const last = await events.getSince(page.cursor!, 2);

        expect(last.entries).toHaveLength(1);
        expect(last.truncated).toBe(false);
    });

    it("ctx.events.getSize returns total count", async () => {
        expect.assertions(1);

        const client = createTestClient();
        const middleware = eventsContext(client);

        const { events } = (await middleware({
            ctx: {},
            next: createNext({}),
        })) as { events: EventsFacade };

        await events.append([{ type: "a", payload: null }]);
        await events.append([{ type: "b", payload: null }]);
        await events.append([{ type: "c", payload: null }]);

        const size = await events.getSize();

        expect(size).toBe(3);
    });

    it("ctx.events.getState returns full state", async () => {
        expect.assertions(3);

        const client = createTestClient();
        const middleware = eventsContext(client);

        const { events } = (await middleware({
            ctx: {},
            next: createNext({}),
        })) as { events: EventsFacade };

        await events.append([{ type: "a", payload: 1 }]);

        const state = await events.getState();

        expect(state.entries).toHaveLength(1);
        expect(state.nextSeq).toBe(1);
        expect(state.entries[0]!.type).toBe("a");
    });
});
