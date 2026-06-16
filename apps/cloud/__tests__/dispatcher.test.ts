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
        const resolvePlan = (scriptName: string) => Promise.resolve(scriptName === "acme-app" ? "pro" : undefined);

        await expect(resolveTenant("acme-app.lunora.app", { appDomain: "lunora.app", resolvePlan })).resolves.toStrictEqual({
            plan: "pro",
            scriptName: "acme-app",
        });
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
        const fetchMock = vi.fn().mockResolvedValue(Response.json({ plan: "pro" }, { status: 200 }));
        const resolve = createPlanResolver({ controlPlaneToken: "t", controlPlaneUrl: "https://cp", fetch: fetchMock });

        await expect(resolve("acme-app")).resolves.toBe("pro");
        await expect(resolve("acme-app")).resolves.toBe("pro");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("falls back to undefined on a failed lookup", async () => {
        const resolve = createPlanResolver({
            controlPlaneToken: "t",
            controlPlaneUrl: "https://cp",
            fetch: async () => new Response("nope", { status: 500 }),
        });

        await expect(resolve("acme-app")).resolves.toBeUndefined();
    });
});
