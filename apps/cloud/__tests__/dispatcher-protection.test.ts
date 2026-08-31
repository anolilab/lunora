import { afterEach, describe, expect, it, vi } from "vitest";

import { previewCookieHeader, signPreviewToken } from "../src/dispatcher/preview-auth";
import dispatcher from "../src/dispatcher/worker";

/**
 * Deployment protection at the dispatcher (GAPS.md B-series follow-on).
 *
 * A preview deployment is publicly addressable the moment it exists. These tests
 * pin the gate that stands in front of it: nothing reaches the tenant without a
 * valid signed cookie, the password is verified by the control plane rather than
 * the data plane, and the gate runs BEFORE dispatch so an unauthenticated probe
 * never executes (or bills for) the tenant's own code.
 */

const CONTROL_PLANE_TOKEN = "cp_token_fixture"; // gitleaks:allow -- fabricated fixture, not a credential
const SCRIPT = "acme-pr-42";

/** A tenant that must never be reached while the gate holds. */
const tenantFetch = vi.fn<() => Promise<Response>>(() => Promise.resolve(new Response("tenant body", { status: 200 })));

/** The one password the control-plane double accepts. */
const PASSWORD = "hunter2-long-enough";

/**
 * Control-plane double, installed ONCE for the file.
 *
 * `createPlanResolver` captures `fetch` when the dispatcher builds its
 * per-isolate resolvers, so re-stubbing the global between cases has no effect —
 * the first stub is the one that stays bound. That mirrors production, where the
 * resolver is built once per isolate, so the double routes by script name rather
 * than being swapped: `acme-pr-42` is a protected preview, `acme-open` is not.
 */
const controlPlane = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);

    if (url.includes("/v1/tenants/plan")) {
        const script = new URL(url).searchParams.get("script") ?? "";

        return Response.json({ plan: "pro", ...(script === SCRIPT ? { protected: true } : {}) }, { status: 200 });
    }

    if (url.includes("/v1/tenants/preview-auth")) {
        const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { password?: string };

        return Response.json({ ok: body.password === PASSWORD }, { status: 200 });
    }

    // Alias/custom-domain lookups fall through to the literal label, as in production.
    return new Response("not found", { status: 404 });
});

vi.stubGlobal("fetch", controlPlane);

const makeEnv = () => {
    return {
        CONTROL_PLANE_TOKEN,
        CONTROL_PLANE_URL: "https://cp.example",
        DISPATCHER: {
            get: vi.fn<() => { fetch: typeof tenantFetch }>(() => {
                return { fetch: tenantFetch };
            }),
        },
        LUNORA_APP_DOMAIN: "lunora.app",
    };
};

const get = (cookie?: string, script: string = SCRIPT): Request =>
    new Request(`https://${script}.lunora.app/dashboard`, { headers: cookie === undefined ? {} : { cookie } });

describe("deployment protection", () => {
    afterEach(() => {
        tenantFetch.mockClear();
    });

    it("challenges an unauthenticated request and never reaches the tenant", async () => {
        const response = await dispatcher.fetch(get(), makeEnv());

        expect(response.status).toBe(401);
        await expect(response.text()).resolves.toContain("This preview is protected");
        // The point of gating before dispatch: an unauthenticated probe must not
        // execute the tenant's code, nor bill for it.
        expect(tenantFetch).not.toHaveBeenCalled();
    });

    /** A crawler or uptime check must not record a protected preview as healthy content. */
    it("challenges with 401 and no-store rather than a 200 page", async () => {
        const response = await dispatcher.fetch(get(), makeEnv());

        expect(response.status).toBe(401);
        expect(response.headers.get("cache-control")).toBe("no-store");
    });

    it("lets a request with a valid cookie through to the tenant", async () => {
        const token = await signPreviewToken(SCRIPT, CONTROL_PLANE_TOKEN);
        const response = await dispatcher.fetch(get(`__lunora_preview=${token}`), makeEnv());

        expect(response.status).toBe(200);
        expect(tenantFetch).toHaveBeenCalledTimes(1);
    });

    /**
     * The cross-preview case. Preview hostnames share an apex, so the browser
     * offers one preview's cookie to the next; the signed scope is what rejects it.
     */
    it("rejects a cookie minted for a different preview", async () => {
        const token = await signPreviewToken("acme-pr-99", CONTROL_PLANE_TOKEN);
        const response = await dispatcher.fetch(get(`__lunora_preview=${token}`), makeEnv());

        expect(response.status).toBe(401);
        expect(tenantFetch).not.toHaveBeenCalled();
    });

    it("accepts the right password and sets a scoped cookie", async () => {
        const form = new FormData();

        form.set("password", PASSWORD);

        const response = await dispatcher.fetch(new Request(`https://${SCRIPT}.lunora.app/__lunora/preview-auth`, { body: form, method: "POST" }), makeEnv());

        // 303 so the browser follows with GET — a 302 would replay the POST.
        expect(response.status).toBe(303);
        expect(response.headers.get("set-cookie")).toContain("HttpOnly");
        expect(tenantFetch).not.toHaveBeenCalled();
    });

    it("re-challenges on a wrong password without setting a cookie", async () => {
        const form = new FormData();

        form.set("password", "wrong");

        const response = await dispatcher.fetch(new Request(`https://${SCRIPT}.lunora.app/__lunora/preview-auth`, { body: form, method: "POST" }), makeEnv());

        expect(response.status).toBe(401);
        expect(response.headers.get("set-cookie")).toBeNull();
    });

    /** The login POST is dispatcher-owned; forwarding it would hand the tenant a plaintext password. */
    it("never forwards the login POST to the tenant", async () => {
        const form = new FormData();

        form.set("password", PASSWORD);

        await dispatcher.fetch(new Request(`https://${SCRIPT}.lunora.app/__lunora/preview-auth`, { body: form, method: "POST" }), makeEnv());

        expect(tenantFetch).not.toHaveBeenCalled();
    });

    /**
     * A distinct script name on purpose. The dispatcher caches script facts per
     * isolate for a TTL, so reusing the gated name here would read the cached
     * `protected: true` from an earlier case — the same reason enabling or
     * disabling protection in production takes up to that TTL to take effect.
     */
    it("does not gate an unprotected deployment", async () => {
        const response = await dispatcher.fetch(get(undefined, "acme-open"), makeEnv());

        expect(response.status).toBe(200);
        expect(tenantFetch).toHaveBeenCalledTimes(1);
    });

    it("mints a cookie carrying the flags that keep it scoped", () => {
        const header = previewCookieHeader("abc.def");

        expect(header).toContain("HttpOnly");
        expect(header).not.toContain("Domain=");
    });
});
