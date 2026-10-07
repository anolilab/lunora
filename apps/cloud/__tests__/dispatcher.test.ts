import { describe, expect, it, vi } from "vitest";

import { limitsForPlan } from "../src/billing/plans";
import { createPlanResolver, PLAN_STALE_GRACE_MS, resolveTenant, UNAVAILABLE_PLAN } from "../src/targets/cloudflare-wfp/route";

describe(resolveTenant, () => {
    it("maps a single-label subdomain to its script", async () => {
        await expect(resolveTenant("acme-app.lunora.app", { appDomain: "lunora.app" })).resolves.toStrictEqual({ plan: undefined, scriptName: "acme-app" });
    });

    it("is case-insensitive on the host", async () => {
        await expect(resolveTenant("Acme-App.Lunora.App", { appDomain: "lunora.app" })).resolves.toStrictEqual({ plan: undefined, scriptName: "acme-app" });
    });

    it("rejects the apex and multi-label subdomains", async () => {
        await expect(resolveTenant("lunora.app", { appDomain: "lunora.app" })).resolves.toBeNull();
        await expect(resolveTenant("a.b.lunora.app", { appDomain: "lunora.app" })).resolves.toBeNull();
    });

    it("resolves a custom domain through the injected lookup", async () => {
        const resolveCustomDomain = (host: string) => Promise.resolve(host === "app.acme.com" ? "acme-app" : null);

        await expect(resolveTenant("app.acme.com", { appDomain: "lunora.app", resolveCustomDomain })).resolves.toStrictEqual({
            plan: undefined,
            scriptName: "acme-app",
        });
        await expect(resolveTenant("unknown.com", { appDomain: "lunora.app", resolveCustomDomain })).resolves.toBeNull();
    });

    it("attaches the tenant plan via the injected resolver", async () => {
        const resolvePlan = (scriptName: string) => Promise.resolve(scriptName === "acme-app" ? { plan: "pro" } : {});

        await expect(resolveTenant("acme-app.lunora.app", { appDomain: "lunora.app", resolvePlan })).resolves.toStrictEqual({
            plan: "pro",
            scriptName: "acme-app",
        });
    });

    /**
     * Protection rides on the same lookup as the plan, so a route either carries
     * both or neither — the dispatcher must never have to make a second
     * control-plane call on the request path to learn whether to gate.
     */
    it("carries deployment protection alongside the plan", async () => {
        const resolvePlan = () => Promise.resolve({ plan: "pro", protected: true });

        await expect(resolveTenant("acme-pr-42.lunora.app", { appDomain: "lunora.app", resolvePlan })).resolves.toStrictEqual({
            plan: "pro",
            protected: true,
            scriptName: "acme-pr-42",
        });
    });

    it("omits protection entirely when the script is not gated", async () => {
        const resolvePlan = () => Promise.resolve({ plan: "pro", protected: false });
        const route = await resolveTenant("acme-app.lunora.app", { appDomain: "lunora.app", resolvePlan });

        expect(route).not.toHaveProperty("protected");
    });
});

describe(limitsForPlan, () => {
    it("scales runtime caps by plan, falling back to free", () => {
        expect(limitsForPlan("enterprise").cpuMs).toBeGreaterThan(limitsForPlan("pro").cpuMs);
        expect(limitsForPlan("pro").cpuMs).toBeGreaterThan(limitsForPlan("free").cpuMs);
        expect(limitsForPlan(undefined)).toStrictEqual(limitsForPlan("free"));
        expect(limitsForPlan("nonexistent")).toStrictEqual(limitsForPlan("free"));
    });
});

describe(createPlanResolver, () => {
    it("resolves a plan and caches it within the TTL", async () => {
        const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ plan: "pro" }, { status: 200 }));
        const resolve = createPlanResolver({ controlPlaneToken: "t", controlPlaneUrl: "https://cp", fetch: fetchMock });

        await expect(resolve("acme-app")).resolves.toStrictEqual({ plan: "pro" });
        await expect(resolve("acme-app")).resolves.toStrictEqual({ plan: "pro" });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    /** Protection is answered by the same call, so it is cached on the same terms. */
    it("carries and caches the protection flag with the plan", async () => {
        const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ plan: "pro", protected: true }, { status: 200 }));
        const resolve = createPlanResolver({ controlPlaneToken: "t", controlPlaneUrl: "https://cp", fetch: fetchMock });

        await expect(resolve("acme-pr-42")).resolves.toStrictEqual({ plan: "pro", protected: true });
        await expect(resolve("acme-pr-42")).resolves.toStrictEqual({ plan: "pro", protected: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    /**
     * Fails CLOSED. A tenant never seen is not served on a lookup that did not
     * happen, and neither is a protected preview: both answer the unservable
     * `unavailable` plan, which the dispatcher refuses.
     */
    it.each([
        ["a 5xx", (): Promise<Response> => Promise.resolve(new Response("nope", { status: 500 }))],
        ["a thrown fetch", (): Promise<Response> => Promise.reject(new Error("timeout"))],
        ["a malformed body", (): Promise<Response> => Promise.resolve(new Response("<html>", { status: 200 }))],
        ["an unknown plan name", (): Promise<Response> => Promise.resolve(Response.json({ plan: "platinum" }))],
        ["a non-boolean protected flag", (): Promise<Response> => Promise.resolve(Response.json({ plan: "pro", protected: "no" }))],
    ])("answers unavailable on %s with nothing cached", async (_label, failure) => {
        const resolve = createPlanResolver({ controlPlaneToken: "t", controlPlaneUrl: "https://cp", fetch: failure });

        await expect(resolve("acme-app")).resolves.toStrictEqual({ plan: UNAVAILABLE_PLAN });
    });

    /** A blip keeps a healthy tenant (and its protection) up for the grace, then refuses it. */
    it("serves the last verified answer through a failed refresh for the grace window only", async () => {
        let clock = 0;
        const fetchMock = vi
            .fn<typeof globalThis.fetch>()
            .mockResolvedValueOnce(Response.json({ plan: "pro", protected: true }))
            .mockRejectedValue(new Error("down"));
        const resolve = createPlanResolver({ controlPlaneToken: "t", controlPlaneUrl: "https://cp", fetch: fetchMock, now: () => clock, ttlMs: 10 });

        await resolve("acme-pr");
        clock = 10 + PLAN_STALE_GRACE_MS - 1;

        await expect(resolve("acme-pr")).resolves.toStrictEqual({ plan: "pro", protected: true });

        clock = 10 + PLAN_STALE_GRACE_MS;

        await expect(resolve("acme-pr")).resolves.toStrictEqual({ plan: UNAVAILABLE_PLAN });
    });

    it("caches an unknown answer only briefly, so a first deploy is served within seconds", async () => {
        let clock = 0;
        const fetchMock = vi
            .fn<typeof globalThis.fetch>()
            .mockResolvedValueOnce(Response.json({ plan: "unknown" }))
            .mockResolvedValueOnce(Response.json({ plan: "free" }));
        const resolve = createPlanResolver({ controlPlaneToken: "t", controlPlaneUrl: "https://cp", fetch: fetchMock, now: () => clock });

        await expect(resolve("acme-new")).resolves.toStrictEqual({ plan: "unknown" });

        clock = 5000;

        await expect(resolve("acme-new")).resolves.toStrictEqual({ plan: "free" });
    });

    /** Keyed by the script it was resolved for: one script's answer is never another's. */
    it("never serves one script's cached answer for another", async () => {
        const fetchMock = vi.fn<typeof globalThis.fetch>(async (input) => {
            const url = input instanceof Request ? input.url : input.toString();

            return Response.json({ plan: url.includes("script=acme-a") ? "pro" : "suspended" });
        });
        const resolve = createPlanResolver({ controlPlaneToken: "t", controlPlaneUrl: "https://cp", fetch: fetchMock });

        await expect(resolve("acme-a")).resolves.toStrictEqual({ plan: "pro" });
        await expect(resolve("acme-b")).resolves.toStrictEqual({ plan: "suspended" });
    });

    /**
     * Failing open is for a healthy tenant during a blip. A tenant last known to
     * be suspended (a spend-cap breach, plan 365 W3) stays refused when the
     * refresh fails — by a 5xx or by a throw — or an outage would lift the cap.
     */
    it.each([
        ["a 5xx", (): Promise<Response> => Promise.resolve(new Response("nope", { status: 503 }))],
        ["a thrown fetch", (): Promise<Response> => Promise.reject(new Error("connect timeout"))],
    ])("keeps refusing a suspended tenant past its TTL when the refresh fails with %s", async (_label, failure) => {
        let clock = 0;
        const fetchMock = vi
            .fn<typeof globalThis.fetch>()
            .mockResolvedValueOnce(Response.json({ plan: "suspended" }))
            .mockImplementation(failure);
        const resolve = createPlanResolver({ controlPlaneToken: "t", controlPlaneUrl: "https://cp", fetch: fetchMock, now: () => clock, ttlMs: 10 });

        await expect(resolve("acme-app")).resolves.toStrictEqual({ plan: "suspended" });

        clock = 100;

        await expect(resolve("acme-app")).resolves.toStrictEqual({ plan: "suspended" });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("lets a tenant back in once the control plane answers that it is no longer suspended", async () => {
        let clock = 0;
        const fetchMock = vi
            .fn<typeof globalThis.fetch>()
            .mockResolvedValueOnce(Response.json({ plan: "suspended" }))
            .mockResolvedValueOnce(Response.json({ plan: "pro" }));
        const resolve = createPlanResolver({ controlPlaneToken: "t", controlPlaneUrl: "https://cp", fetch: fetchMock, now: () => clock, ttlMs: 10 });

        await resolve("acme-app");
        clock = 100;

        await expect(resolve("acme-app")).resolves.toStrictEqual({ plan: "pro" });
    });
});
