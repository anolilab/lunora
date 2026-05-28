import { describe, expect, test } from "vitest";

import type { HttpActionCtx } from "../src/index.js";
import { httpAction, httpRouter } from "../src/index.js";

const noopHandler = httpAction(() => new Response("ok"));

describe("httpAction", () => {
    test("marks the registration and preserves the handler", async () => {
        const action = httpAction((_ctx: HttpActionCtx, request: Request) => new Response(request.method));

        expect(action.isHttpAction).toBe(true);

        const response = await action.handler({} as HttpActionCtx, new Request("https://x/y", { method: "PATCH" }));

        await expect(response.text()).resolves.toBe("PATCH");
    });
});

describe("httpRouter", () => {
    test("matches an exact path + method", () => {
        const http = httpRouter();

        http.route({ handler: noopHandler, method: "POST", path: "/webhook" });

        expect(http.lookup("/webhook", "POST")).toStrictEqual({ action: noopHandler, kind: "match" });
    });

    test("returns not_found when no path matches", () => {
        const http = httpRouter();

        http.route({ handler: noopHandler, method: "GET", path: "/a" });

        expect(http.lookup("/b", "GET")).toStrictEqual({ kind: "not_found" });
    });

    test("returns method_not_allowed (with the Allow set) when the path matches but the verb does not", () => {
        const http = httpRouter();

        http.route({ handler: noopHandler, method: "GET", path: "/thing" });
        http.route({ handler: noopHandler, method: "PUT", path: "/thing" });

        const result = http.lookup("/thing", "POST");

        expect(result.kind).toBe("method_not_allowed");
        expect(result).toMatchObject({ allow: expect.arrayContaining(["GET", "PUT"]) });
    });

    test("matches a pathPrefix route", () => {
        const http = httpRouter();

        http.route({ handler: noopHandler, method: "GET", pathPrefix: "/img/" });

        expect(http.lookup("/img/cat.png", "GET")).toStrictEqual({ action: noopHandler, kind: "match" });
        expect(http.lookup("/img/", "GET")).toStrictEqual({ action: noopHandler, kind: "match" });
    });

    test("prefers an exact route over a prefix that also matches", () => {
        const exact = httpAction(() => new Response("exact"));
        const prefix = httpAction(() => new Response("prefix"));
        const http = httpRouter();

        http.route({ handler: prefix, method: "GET", pathPrefix: "/files/" });
        http.route({ handler: exact, method: "GET", path: "/files/special" });

        expect(http.lookup("/files/special", "GET")).toStrictEqual({ action: exact, kind: "match" });
        expect(http.lookup("/files/other", "GET")).toStrictEqual({ action: prefix, kind: "match" });
    });

    test("prefers the longest matching prefix", () => {
        const broad = httpAction(() => new Response("broad"));
        const deep = httpAction(() => new Response("deep"));
        const http = httpRouter();

        http.route({ handler: broad, method: "GET", pathPrefix: "/api/" });
        http.route({ handler: deep, method: "GET", pathPrefix: "/api/v2/" });

        expect(http.lookup("/api/v2/users", "GET")).toStrictEqual({ action: deep, kind: "match" });
        expect(http.lookup("/api/v1/users", "GET")).toStrictEqual({ action: broad, kind: "match" });
    });

    test("rejects a path that does not start with a slash", () => {
        const http = httpRouter();

        expect(() => { http.route({ handler: noopHandler, method: "GET", path: "webhook" }); }).toThrow(/must start with/);
    });

    test("rejects a pathPrefix that does not end with a slash", () => {
        const http = httpRouter();

        expect(() => { http.route({ handler: noopHandler, method: "GET", pathPrefix: "/img" }); }).toThrow(/must end with/);
    });

    test("rejects a duplicate (method, path) registration", () => {
        const http = httpRouter();

        http.route({ handler: noopHandler, method: "POST", path: "/dup" });

        expect(() => { http.route({ handler: noopHandler, method: "POST", path: "/dup" }); }).toThrow(/duplicate/);
    });

    test("allows the same path with a different method", () => {
        const http = httpRouter();

        http.route({ handler: noopHandler, method: "GET", path: "/multi" });

        expect(() => { http.route({ handler: noopHandler, method: "POST", path: "/multi" }); }).not.toThrow();
        expect(http.getRoutes()).toHaveLength(2);
    });
});
