import { describe, expect, it, vi } from "vitest";

import dispatcher from "../src/dispatcher/worker";

/**
 * Admission at the dispatcher (plan 365 W3, and the fail-closed review). A
 * tenant is served only on a verified servable plan: a suspended or over-cap
 * org, a script no verified row serves, a failed or malformed lookup, and a
 * suspended org's redirect-only domain are all refused before any tenant code
 * runs — none of them falls through to a default tier.
 */

/** What the control-plane double answers, by script name or hostname. */
const PLANS: Record<string, unknown> = {
    "acme-broken": "not json",
    "acme-ok": { plan: "pro" },
    "acme-suspended": { plan: "suspended" },
    "acme-unknown": { plan: "unknown" },
    "acme-weird": { plan: "platinum" },
};
const DOMAINS: Record<string, unknown> = {
    "go.suspended.example": { suspended: true },
    "go.redirect.example": { redirectTo: "https://elsewhere.example/" },
    "shop.ok.example": { scriptName: "acme-ok" },
};

const controlPlane = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));

    if (url.pathname === "/v1/tenants/plan") {
        const answer = PLANS[url.searchParams.get("script") ?? ""];

        if (answer === undefined) {
            throw new Error("control plane unreachable");
        }

        return typeof answer === "string" ? new Response(answer, { status: 200 }) : Response.json(answer);
    }

    if (url.pathname === "/v1/tenants/custom-domain") {
        const answer = DOMAINS[url.searchParams.get("host") ?? ""];

        return answer === undefined ? Response.json({}) : Response.json(answer);
    }

    return new Response("not found", { status: 404 });
});

vi.stubGlobal("fetch", controlPlane);

const tenantFetch = vi.fn<() => Promise<Response>>(() => Promise.resolve(new Response("tenant body", { status: 200 })));

let cell = 0;

/** A fresh control-plane URL per test, so each gets its own resolver caches. */
const environment = () => {
    cell += 1;

    return {
        CONTROL_PLANE_TOKEN: "cp_token_fixture", // gitleaks:allow -- fabricated fixture, not a credential
        CONTROL_PLANE_URL: `https://cp-${String(cell)}.example`,
        DISPATCHER: {
            get: () => {
                return { fetch: tenantFetch };
            },
        },
        LUNORA_APP_DOMAIN: "lunora.app",
    };
};

const status = async (url: string): Promise<number> => {
    tenantFetch.mockClear();

    const response = await dispatcher.fetch(new Request(url), environment());

    return response.status;
};

describe("dispatcher admission", () => {
    it("serves a tenant on a verified servable plan", async () => {
        await expect(status("https://acme-ok.lunora.app/")).resolves.toBe(200);
        expect(tenantFetch).toHaveBeenCalledTimes(1);
    });

    it.each([
        ["a suspended or over-cap org", "acme-suspended", 503],
        ["a script no verified row serves", "acme-unknown", 404],
        ["an unreachable control plane", "acme-never-seen", 503],
        ["a malformed answer", "acme-broken", 503],
        ["an unknown plan name", "acme-weird", 503],
    ])("refuses %s without running the tenant", async (_label, script, expected) => {
        await expect(status(`https://${script}.lunora.app/`)).resolves.toBe(expected);
        expect(tenantFetch).not.toHaveBeenCalled();
    });

    it("routes a custom domain through the same admission", async () => {
        await expect(status("https://shop.ok.example/")).resolves.toBe(200);
    });

    /** A redirect is answered before any plan lookup, so a suspended org's redirect domain was the path that skipped the check. */
    it("refuses a suspended org's redirect-only domain before redirecting", async () => {
        await expect(status("https://go.suspended.example/")).resolves.toBe(503);
        await expect(status("https://go.redirect.example/")).resolves.toBe(308);
    });

    it("404s an unknown hostname rather than guessing a tenant", async () => {
        await expect(status("https://nobody.example/")).resolves.toBe(404);
    });
});
