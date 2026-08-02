import { describe, expect, it } from "vitest";

import CLOUDFLARE_DRIVER from "../src/cloudflare/cloudflare-driver";
import { DEFAULT_DEPLOY_TARGET, deployTargetIds, resolveDeployDriver } from "../src/driver-registry";

describe("resolveDeployDriver", () => {
    // Omitting the target must select Cloudflare — that is what makes target
    // selection a no-op for every project that predates it.
    it("defaults to cloudflare", () => {
        expect.assertions(2);

        expect(DEFAULT_DEPLOY_TARGET).toBe("cloudflare");
        expect(resolveDeployDriver()).toBe(CLOUDFLARE_DRIVER);
    });

    it("resolves an explicitly named target", () => {
        expect.assertions(1);

        expect(resolveDeployDriver("cloudflare")).toBe(CLOUDFLARE_DRIVER);
    });

    // The failure mode this must never have: silently deploying to Cloudflare
    // because the requested target was not recognized.
    it("throws on an unknown target rather than falling back to the default", () => {
        expect.assertions(2);

        expect(() => resolveDeployDriver("aws")).toThrow(/unknown deploy target "aws"/);
        // The message lists what is selectable, so the error is actionable.
        expect(() => resolveDeployDriver("aws")).toThrow(/cloudflare/);
    });

    it("lists the registered target ids", () => {
        expect.assertions(1);

        expect(deployTargetIds()).toStrictEqual(["cloudflare", "node"]);
    });
});
