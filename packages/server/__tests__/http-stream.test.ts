import { describe, expect, it, vi } from "vitest";

import type { HttpActionCtx as HttpActionContext, LunoraRouteHandler } from "../src/index";
import { httpRoute, httpRouter, LunoraError, v } from "../src/index";

const context = {} as HttpActionContext;

const dispatch = async (route: LunoraRouteHandler, method: string, path: string, request: Request): Promise<Response> => {
    const app = httpRouter();

    app.on(method, path, route);

    return app.fetch(request, { __lunoraCtx: context });
};

const readSse = async (response: Response): Promise<{ events: { data: unknown; event: string }[]; raw: string }> => {
    const text = await response.text();
    const events: { data: unknown; event: string }[] = [];

    for (const block of text.split("\n\n")) {
        if (block.trim() === "") {
            continue;
        }

        let event = "message";
        const dataLines: string[] = [];

        for (const line of block.split("\n")) {
            if (line.startsWith("event: ")) {
                event = line.slice("event: ".length);
            } else if (line.startsWith("data: ")) {
                dataLines.push(line.slice("data: ".length));
            }
        }

        if (dataLines.length === 0) {
            continue;
        }

        events.push({ data: JSON.parse(dataLines.join("\n")), event });
    }

    return { events, raw: text };
};

describe("httpRoute stream() terminal", () => {
    it("returns text/event-stream with data frames + a terminal event:complete", async () => {
        expect.hasAssertions();

        const route = httpRoute.get("/api/ticks").stream(async function* ticksGen() {
            yield { tick: 1 };
            yield { tick: 2 };
            yield { tick: 3 };
        });

        const response = await dispatch(route, "GET", "/api/ticks", new Request("https://x/api/ticks"));

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/event-stream");

        const { events } = await readSse(response);

        expect(events.map((e) => e.event)).toEqual(["message", "message", "message", "complete"]);
        expect(events.slice(0, 3).map((e) => e.data)).toEqual([{ tick: 1 }, { tick: 2 }, { tick: 3 }]);
    });

    it("coerces searchParams + params and routes them through the stream handler", async () => {
        expect.hasAssertions();

        const route = httpRoute
            .get("/api/feed/:room")
            .params({ room: v.string() })
            .searchParams({ limit: v.number() })
            .stream(async function* feedGen({ params, searchParams }) {
                for (let index = 0; index < searchParams.limit; index += 1) {
                    yield { index, room: params.room };
                }
            });

        const response = await dispatch(route, "GET", "/api/feed/:room", new Request("https://x/api/feed/lobby?limit=2"));
        const { events } = await readSse(response);
        const chunks = events.filter((event) => event.event === "message").map((event) => event.data);

        expect(chunks).toEqual([
            { index: 0, room: "lobby" },
            { index: 1, room: "lobby" },
        ]);
    });

    it("surfaces a thrown LunoraError as an event:error frame", async () => {
        expect.assertions(2);

        // eslint-disable-next-line require-yield, sonarjs/generator-without-yield -- intentional: this generator only throws.
        const route = httpRoute.get("/api/boom").stream(async function* boomGen() {
            throw new LunoraError("FORBIDDEN", "nope");
        });

        const response = await dispatch(route, "GET", "/api/boom", new Request("https://x/api/boom"));
        const { events } = await readSse(response);
        const error = events.find((event) => event.event === "error");

        expect(error).toBeDefined();
        expect(error?.data).toMatchObject({ code: "FORBIDDEN", message: "nope" });
    });

    it("short-circuits a pre-aborted request without running the user handler", async () => {
        expect.assertions(2);

        let started = false;
        const route = httpRoute.get("/api/ticks").stream(async function* ticksGen() {
            started = true;
            yield { tick: 1 };
        });

        const ac = new AbortController();

        ac.abort();

        const request = new Request("https://x/api/ticks", { signal: ac.signal });
        const response = await dispatch(route, "GET", "/api/ticks", request);
        const { events } = await readSse(response);

        // The handler is never constructed/driven, so the stream closes empty.
        expect(started).toBe(false);
        expect(events).toEqual([]);
    });

    it("returns 400 when search-param decoding fails (rejection happens before the stream starts)", async () => {
        expect.assertions(1);

        const route = httpRoute
            .get("/api/feed")
            .searchParams({ limit: v.number() })
            .stream(async function* limitGen() {
                yield 1;
            });

        const response = await dispatch(route, "GET", "/api/feed", new Request("https://x/api/feed?limit=not-a-number"));

        expect(response.status).toBe(400);
    });

    it("keeps SSE responses uncacheable even when cache headers are declared on the route", async () => {
        expect.assertions(4);

        const route = httpRoute
            .get("/api/ticks")
            .cacheControl("public, max-age=300")
            .cacheTag("ticks")
            .vary("Accept-Encoding")
            .stream(async function* ticksGen() {
                yield { tick: 1 };
            });

        const response = await dispatch(route, "GET", "/api/ticks", new Request("https://x/api/ticks"));

        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
        expect(response.headers.get("cache-tag")).toBeNull();
        expect(response.headers.get("vary")).toBeNull();
    });
});

describe("httpRoute stream() mid-stream cancel", () => {
    // On a consumer cancel the pump breaks, but the terminal `event: complete`
    // frame was enqueued unconditionally onto a controller that is already
    // closed. That throws a `TypeError`, which the catch below logged as a bogus
    // "unhandled stream handler error", then threw AGAIN out of the error frame
    // and out of `finally`'s `close()` — so `start()` rejected unhandled on every
    // mid-stream disconnect, and a real handler error in the same turn was
    // masked by the transport error.
    it("does not enqueue a terminal frame after the consumer cancels", async () => {
        expect.assertions(1);

        const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

        let release = (): void => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        const route = httpRoute.get("/api/ticks").stream(async function* ticksGen() {
            yield { tick: 1 };
            await gate;
            yield { tick: 2 };
        });

        const response = await dispatch(route, "GET", "/api/ticks", new Request("https://x/api/ticks"));
        const reader = response.body!.getReader();

        await reader.read();
        // The consumer drops the stream: `cancel()` aborts the controller and
        // closes it under the still-running pump.
        await reader.cancel();

        release();
        // Let the resumed generator drive the pump past its break.
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

        errors.mockRestore();

        expect(errors).not.toHaveBeenCalled();
    });
});

describe("httpRoute.stream — .output() is enforced per chunk", () => {
    it("parses every chunk through the declared output validator", async () => {
        expect.assertions(1);

        // `applyOutput`'s contract: "Every result-parsing site (RPC, REST, any
        // future transport) must route through this helper". SSE was the one that
        // did not — `.output()` was accepted, type-checked against, and then
        // silently discarded, so a chunk went straight to `JSON.stringify`.
        const route = httpRoute
            .get("/tick")
            .output(v.object({ id: v.string() }))
            .stream(async function* okGen() {
                yield { id: "a" };
                yield { id: "b" };
            });

        const response = await dispatch(route, "GET", "/tick", new Request("https://x.example/tick"));
        const { events } = await readSse(response);

        expect(events.filter((entry) => entry.event === "message").map((entry) => entry.data)).toEqual([{ id: "a" }, { id: "b" }]);
    });

    it("a chunk that violates the output schema becomes an error frame, not raw data", async () => {
        expect.assertions(2);

        const route = httpRoute
            .get("/bad")
            .output(v.object({ id: v.string() }))
            .stream(async function* badGen() {
                yield { id: "ok" };
                yield { id: 42 } as unknown as { id: string };
            });

        const response = await dispatch(route, "GET", "/bad", new Request("https://x.example/bad"));
        const { events } = await readSse(response);

        // The good chunk still shipped; the violating one is a redacted error
        // frame (an output mismatch is a server contract bug → INTERNAL, so
        // `toErrorBody` redacts the message) rather than `data: {"id":42}`.
        expect(events.map((entry) => entry.event)).toEqual(["message", "error"]);
        expect(events[0]?.data).toEqual({ id: "ok" });
    });
});
