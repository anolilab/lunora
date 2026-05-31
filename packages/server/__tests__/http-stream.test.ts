import { describe, expect, test } from "vitest";

import type { CirrusRouteHandler, HttpActionCtx } from "../src/index.js";
import { CirrusError, httpRoute, httpRouter, v } from "../src/index.js";

const ctx = {} as HttpActionCtx;

const dispatch = async (route: CirrusRouteHandler, method: string, path: string, request: Request): Promise<Response> => {
    const app = httpRouter();

    app.on(method, path, route);

    return app.fetch(request, { __cirrusCtx: ctx });
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
    test("returns text/event-stream with data frames + a terminal event:complete", async () => {
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

    test("coerces searchParams + params and routes them through the stream handler", async () => {
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

    test("surfaces a thrown CirrusError as an event:error frame", async () => {
        // eslint-disable-next-line require-yield, sonarjs/generator-without-yield -- intentional: this generator only throws.
        const route = httpRoute.get("/api/boom").stream(async function* boomGen() {
            throw new CirrusError("FORBIDDEN", "nope");
        });

        const response = await dispatch(route, "GET", "/api/boom", new Request("https://x/api/boom"));
        const { events } = await readSse(response);
        const error = events.find((event) => event.event === "error");

        expect(error).toBeDefined();
        expect(error?.data).toMatchObject({ code: "FORBIDDEN", message: "nope" });
    });

    test("returns 400 when search-param decoding fails (rejection happens before the stream starts)", async () => {
        const route = httpRoute
            .get("/api/feed")
            .searchParams({ limit: v.number() })
            .stream(async function* limitGen() {
                yield 1;
            });

        const response = await dispatch(route, "GET", "/api/feed", new Request("https://x/api/feed?limit=not-a-number"));

        expect(response.status).toBe(400);
    });
});
