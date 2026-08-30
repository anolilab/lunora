import { describe, expect, it, vi } from "vitest";

import { limitsForPlan } from "../src/billing/plans";
import { createPlanResolver, resolveTenant } from "../src/dispatcher/route";

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
     * Fails OPEN, on both axes. A control-plane blip must not take the data plane
     * down, which means it also cannot gate every protected preview behind a 503 —
     * the password itself is never bypassed, only the decision to ask for it.
     */
    it("falls back to no facts on a failed lookup", async () => {
        const resolve = createPlanResolver({
            controlPlaneToken: "t",
            controlPlaneUrl: "https://cp",
            fetch: async () => new Response("nope", { status: 500 }),
        });

        await expect(resolve("acme-app")).resolves.toStrictEqual({});
    });
});
