import { describe, expect, it } from "vitest";

import { resolveTenant } from "../src/dispatcher/route";

describe(resolveTenant, () => {
    it("maps a single-label subdomain to its script", async () => {
        await expect(resolveTenant("acme-app.cirrus.app", { appDomain: "cirrus.app" })).resolves.toStrictEqual({ scriptName: "acme-app" });
    });

    it("is case-insensitive on the host", async () => {
        await expect(resolveTenant("Acme-App.Cirrus.App", { appDomain: "cirrus.app" })).resolves.toStrictEqual({ scriptName: "acme-app" });
    });

    it("rejects the apex and multi-label subdomains", async () => {
        await expect(resolveTenant("cirrus.app", { appDomain: "cirrus.app" })).resolves.toBeNull();
        await expect(resolveTenant("a.b.cirrus.app", { appDomain: "cirrus.app" })).resolves.toBeNull();
    });

    it("resolves a custom domain through the injected lookup", async () => {
        const resolveCustomDomain = (host: string) => Promise.resolve(host === "app.acme.com" ? "acme-app" : null);

        await expect(resolveTenant("app.acme.com", { appDomain: "cirrus.app", resolveCustomDomain })).resolves.toStrictEqual({ scriptName: "acme-app" });
        await expect(resolveTenant("unknown.com", { appDomain: "cirrus.app", resolveCustomDomain })).resolves.toBeNull();
    });
});
