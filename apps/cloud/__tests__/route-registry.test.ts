import { describe, expect, it } from "vitest";

import { createDeployRouter } from "../src/deploy/router";
import type { RegisteredRoute } from "../src/deploy/route-registry";
import { assertRoutesClassified } from "../src/deploy/route-registry";

const noop = (): Promise<Response> => Promise.resolve(new Response());

const route = (over: Partial<RegisteredRoute<typeof noop>>): RegisteredRoute<typeof noop> => ({
    handler: noop,
    method: "POST",
    path: "/v1/thing",
    spec: { auth: "deployKey" },
    ...over,
});

describe(assertRoutesClassified, () => {
    it("accepts a fully classified table", () => {
        expect(() =>
            assertRoutesClassified([route({ path: "/v1/a", spec: { auth: "deployKey" } }), route({ path: "/v1/b", spec: { auth: "session" } })]),
        ).not.toThrow();
    });

    it("throws when a route has no valid auth classification", () => {
        expect(() => assertRoutesClassified([route({ spec: { auth: "nope" as never } })])).toThrow(/no valid auth classification/);
    });

    it("throws when a public route does not justify itself", () => {
        expect(() => assertRoutesClassified([route({ path: "/v1/open", spec: { auth: "public" } })])).toThrow(/must document why it is unauthenticated/);
    });

    it("accepts a public route that documents a reason", () => {
        expect(() => assertRoutesClassified([route({ path: "/v1/open", spec: { auth: "public", reason: "load-balancer health probe" } })])).not.toThrow();
    });

    it("throws on a duplicate (method, path)", () => {
        expect(() => assertRoutesClassified([route({ path: "/v1/dup" }), route({ path: "/v1/dup" })])).toThrow(/duplicate route POST \/v1\/dup/);
    });

    it("treats the same path under different methods as distinct", () => {
        expect(() =>
            assertRoutesClassified([route({ method: "GET", path: "/v1/x", spec: { auth: "adminToken" } }), route({ method: "POST", path: "/v1/x" })]),
        ).not.toThrow();
    });
});

describe("createDeployRouter route classification", () => {
    it("constructs — every real /v1 route is classified (the boot scanner passes)", () => {
        // If any route in the real table lacked a spec, the scanner would throw here.
        expect(() => createDeployRouter()).not.toThrow();
    });

    it("404s an unknown path and a wrong method", async () => {
        const router = createDeployRouter();

        expect((await router.fetch(new Request("https://cloud/v1/nope", { method: "POST" }))).status).toBe(404);
        // /v1/deploy exists as POST; GET must not resolve it.
        expect((await router.fetch(new Request("https://cloud/v1/deploy", { method: "GET" }))).status).toBe(404);
    });
});
