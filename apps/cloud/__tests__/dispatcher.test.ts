import { describe, expect, it } from "vitest";

import { limitsForPlan } from "../src/billing/plans";
import { resolveTenant } from "../src/dispatcher/route";

describe(resolveTenant, () => {
    it("maps a single-label subdomain to its script", async () => {
        await expect(resolveTenant("acme-app.cirrus.app", { appDomain: "cirrus.app" })).resolves.toStrictEqual({ plan: undefined, scriptName: "acme-app" });
    });

    it("is case-insensitive on the host", async () => {
        await expect(resolveTenant("Acme-App.Cirrus.App", { appDomain: "cirrus.app" })).resolves.toStrictEqual({ plan: undefined, scriptName: "acme-app" });
    });

    it("rejects the apex and multi-label subdomains", async () => {
        await expect(resolveTenant("cirrus.app", { appDomain: "cirrus.app" })).resolves.toBeNull();
        await expect(resolveTenant("a.b.cirrus.app", { appDomain: "cirrus.app" })).resolves.toBeNull();
    });

    it("resolves a custom domain through the injected lookup", async () => {
        const resolveCustomDomain = (host: string) => Promise.resolve(host === "app.acme.com" ? "acme-app" : null);

        await expect(resolveTenant("app.acme.com", { appDomain: "cirrus.app", resolveCustomDomain })).resolves.toStrictEqual({
            plan: undefined,
            scriptName: "acme-app",
        });
        await expect(resolveTenant("unknown.com", { appDomain: "cirrus.app", resolveCustomDomain })).resolves.toBeNull();
    });

    it("attaches the tenant plan via the injected resolver", async () => {
        const resolvePlan = (scriptName: string) => Promise.resolve(scriptName === "acme-app" ? "pro" : undefined);

        await expect(resolveTenant("acme-app.cirrus.app", { appDomain: "cirrus.app", resolvePlan })).resolves.toStrictEqual({
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
