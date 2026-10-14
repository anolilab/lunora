import { afterEach, describe, expect, it } from "vitest";

import { mergeQuery, withRedirectTo } from "../../src/core/redirect-to";

/**
 * `mergeQuery` is the parse-and-merge extracted out of `withRedirectTo` so the
 * invitation bounce (`invitations.ts`) can share it instead of re-appending a
 * blind `?redirectTo=…`, which mangled any `redirects.signIn` that already
 * carried a query (plan 278).
 */
describe("mergeQuery", () => {
    it("adds a query to a path with none", () => {
        expect.assertions(1);

        expect(mergeQuery("/sign-in", { redirectTo: "/app" })).toBe("/sign-in?redirectTo=%2Fapp");
    });

    it("merges into a path that already carries a query, without a second ?", () => {
        expect.assertions(2);

        const merged = mergeQuery("/auth?tab=sign-in", { redirectTo: "/app" });

        expect(merged.match(/\?/g)?.length).toBe(1);
        expect(new URL(merged, "https://x").searchParams.get("tab")).toBe("sign-in");
    });

    it("overwrites an existing key rather than duplicating it — the new value wins", () => {
        expect.assertions(2);

        const merged = mergeQuery("/two-factor?redirectTo=/stale", { redirectTo: "/fresh" });
        const params = new URL(merged, "https://x").searchParams;

        expect(params.getAll("redirectTo")).toStrictEqual(["/fresh"]);
        expect(params.get("redirectTo")).toBe("/fresh");
    });

    it("merges several parameters at once", () => {
        expect.assertions(1);

        const merged = mergeQuery("/auth?tab=sign-in", { email: "a@b.co", redirectTo: "/app" });
        const params = new URL(merged, "https://x").searchParams;

        expect(Object.fromEntries(params)).toStrictEqual({ email: "a@b.co", redirectTo: "/app", tab: "sign-in" });
    });
});

describe("withRedirectTo (refactored onto mergeQuery — behaviour unchanged)", () => {
    afterEach(() => {
        globalThis.history.pushState({}, "", "/");
    });

    it("passes the path through untouched when there is no redirectTo on the current URL", () => {
        expect.assertions(1);

        expect(withRedirectTo("/two-factor")).toBe("/two-factor");
    });

    it("carries redirectTo onto the intermediate step's URL", () => {
        expect.assertions(1);

        globalThis.history.pushState({}, "", "/sign-in?redirectTo=%2Finvite%2Fxyz");

        // eslint-disable-next-line no-secrets/no-secrets -- a URL path, not a credential.
        expect(withRedirectTo("/two-factor")).toBe("/two-factor?redirectTo=%2Finvite%2Fxyz"); // secret-scanner:allow -- a URL path, not a credential.
    });

    it("the configured redirectTo does not win over the invitation target it exists to carry", () => {
        expect.assertions(1);

        globalThis.history.pushState({}, "", "/sign-in?redirectTo=%2Finvite%2Fxyz");

        // eslint-disable-next-line no-secrets/no-secrets -- a URL path, not a credential.
        expect(withRedirectTo("/two-factor?redirectTo=%2Fconfigured")).toBe("/two-factor?redirectTo=%2Finvite%2Fxyz"); // secret-scanner:allow -- a URL path, not a credential.
    });
});
