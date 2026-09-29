import { describe, expect, it } from "vitest";

import CLOUDFLARE_DRIVER from "../src/cloudflare/cloudflare-driver";
import type { DeployDriver } from "../src/deploy-driver";
import { DEFAULT_DEPLOY_TARGET, deployTargetIds, planToolchainInvocation, resolveDeployDriver, targetRunsOwnDevServer } from "../src/driver-registry";

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

        expect(deployTargetIds()).toStrictEqual(["celld", "cloudflare", "node"]);
    });
});

describe(planToolchainInvocation, () => {
    const projecting = (writes: string[]): DeployDriver => {
        return {
            id: "fake",
            name: "fake",
            projectConfig: () => {
                return { configPath: "/p/.fake.json", dropped: ["observability"], write: () => writes.push("/p/.fake.json") };
            },
        };
    };

    it("builds the argv against the projection's path and writes only on commit", () => {
        expect.assertions(3);

        const writes: string[] = [];
        const invocation = planToolchainInvocation(projecting(writes), "/p", "deploy", (configPath) => {
            return { args: ["deploy", String(configPath)], tool: "fake" };
        });

        expect(invocation.command.args).toStrictEqual(["deploy", "/p/.fake.json"]);
        expect(writes).toStrictEqual([]);

        invocation.commit();

        expect(writes).toStrictEqual(["/p/.fake.json"]);
    });

    it("writes nothing when the argv builder refuses the request", () => {
        expect.assertions(2);

        const writes: string[] = [];

        expect(() =>
            planToolchainInvocation(projecting(writes), "/p", "deploy", () => {
                throw new Error("no preview versions");
            }),
        ).toThrow("no preview versions");
        expect(writes).toStrictEqual([]);
    });

    it("passes no config path for a driver that reads the project config as-is", () => {
        expect.assertions(2);

        const invocation = planToolchainInvocation(resolveDeployDriver("cloudflare"), "/p", "deploy", (configPath) => {
            return { args: [String(configPath)], tool: "wrangler" };
        });

        expect(invocation.command.args).toStrictEqual(["undefined"]);
        expect(invocation.projection).toBeUndefined();
    });
});

describe(targetRunsOwnDevServer, () => {
    it("is true only for a host that serves the worker itself", () => {
        expect.assertions(2);

        expect(targetRunsOwnDevServer("celld")).toBe(true);
        expect(targetRunsOwnDevServer("cloudflare")).toBe(false);
    });
});
