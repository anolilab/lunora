import { describe, expect, it, vi } from "vitest";

import type { CloudCommandDeps } from "../../src/commands/cloud/handler";
import { runCloudCommand } from "../../src/commands/cloud/handler";
import type { Logger } from "../../src/util/logger";

const capturingLogger = (): { errors: string[]; infos: string[]; logger: Logger; successes: string[] } => {
    const errors: string[] = [];
    const infos: string[] = [];
    const successes: string[] = [];

    return {
        errors,
        infos,
        logger: {
            error: (message) => errors.push(message),
            info: (message) => infos.push(message),
            success: (message) => successes.push(message),
            warn: () => {},
        },
        successes,
    };
};

const deps = (over: Partial<CloudCommandDeps> = {}): Partial<CloudCommandDeps> => ({
    deployFn: async () => ({ status: "live" }),
    env: { LUNORA_CLOUD_URL: "https://cloud", LUNORA_DEPLOY_KEY: "dk_secret" },
    readBundleBase64: () => "YnVuZGxl",
    readWrangler: () => ({ durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] }, name: "app", triggers: { crons: ["0 0 * * *"] } }),
    rollbackFn: async () => ({ scriptName: "app-v2", version: 2 }),
    ...over,
});

describe("lunora cloud", () => {
    it("rejects an unknown subcommand", async () => {
        const { errors, logger } = capturingLogger();
        const result = await runCloudCommand({ argument: ["frobnicate"], cwd: "/x", deps: deps(), logger });

        expect(result.code).toBe(1);
        expect(errors[0]).toMatch(/unknown subcommand/);
    });

    it("errors when the deploy key is absent (never a flag/file)", async () => {
        const { errors, logger } = capturingLogger();
        const result = await runCloudCommand({ argument: ["deploy"], cwd: "/x", deps: deps({ env: { LUNORA_CLOUD_URL: "https://cloud" } }), logger, project: "prj_1", bundlePath: "dist/index.js" });

        expect(result.code).toBe(1);
        expect(errors[0]).toMatch(/LUNORA_DEPLOY_KEY/);
    });

    it("errors when the API URL is absent", async () => {
        const { errors, logger } = capturingLogger();
        const result = await runCloudCommand({ argument: ["deploy"], cwd: "/x", deps: deps({ env: { LUNORA_DEPLOY_KEY: "dk" } }), logger, project: "prj_1", bundlePath: "b" });

        expect(result.code).toBe(1);
        expect(errors[0]).toMatch(/LUNORA_CLOUD_URL/);
    });

    it("deploys: sends the wrangler manifest + bundle and reports live", async () => {
        const { logger, successes } = capturingLogger();
        const deployFn = vi.fn(async () => ({ status: "live" }));

        const result = await runCloudCommand({
            argument: ["deploy"],
            branch: "feat/x",
            bundlePath: "dist/index.js",
            cwd: "/x",
            deps: deps({ deployFn }),
            kind: "preview",
            logger,
            project: "prj_1",
        });

        expect(result).toStrictEqual({ code: 0, outcome: "live" });
        expect(successes[0]).toMatch(/live/);
        expect(deployFn).toHaveBeenCalledWith(
            expect.objectContaining({
                apiUrl: "https://cloud",
                bindings: { durableObjects: [{ binding: "SHARD", className: "ShardDO" }] },
                branch: "feat/x",
                bundle: "YnVuZGxl",
                cronSpecs: ["0 0 * * *"],
                deployKey: "dk_secret",
                kind: "preview",
                projectId: "prj_1",
                scriptName: "app",
            }),
            expect.any(Function),
        );
    });

    it("deploys: non-live terminal status is a failure exit", async () => {
        const { logger } = capturingLogger();
        const result = await runCloudCommand({
            argument: ["deploy"],
            bundlePath: "b",
            cwd: "/x",
            deps: deps({ deployFn: async () => ({ status: "failed" }) }),
            logger,
            project: "prj_1",
        });

        expect(result).toStrictEqual({ code: 1, outcome: "failed" });
    });

    it("deploys: requires project and bundle", async () => {
        const { errors, logger } = capturingLogger();

        expect((await runCloudCommand({ argument: ["deploy"], cwd: "/x", deps: deps(), logger, bundlePath: "b" })).code).toBe(1);
        expect((await runCloudCommand({ argument: ["deploy"], cwd: "/x", deps: deps(), logger, project: "prj_1" })).code).toBe(1);
        expect(errors.some((error) => /project/.test(error))).toBe(true);
        expect(errors.some((error) => /bundle/.test(error))).toBe(true);
    });

    it("deploys: rejects an invalid --kind", async () => {
        const { errors, logger } = capturingLogger();
        const result = await runCloudCommand({ argument: ["deploy"], bundlePath: "b", cwd: "/x", deps: deps(), kind: "staging", logger, project: "prj_1" });

        expect(result.code).toBe(1);
        expect(errors[0]).toMatch(/invalid --kind/);
    });

    it("rolls back with confirmation and reports the now-serving script", async () => {
        const { logger, successes } = capturingLogger();
        const rollbackFn = vi.fn(async () => ({ scriptName: "app-v2", version: 2 }));

        const result = await runCloudCommand({ argument: ["rollback", "dep_1"], cwd: "/x", deps: deps({ rollbackFn }), logger, org: "org_1", yes: true });

        expect(result).toStrictEqual({ code: 0, outcome: "app-v2" });
        expect(rollbackFn).toHaveBeenCalledWith({ apiUrl: "https://cloud", deployKey: "dk_secret", deploymentId: "dep_1", organizationId: "org_1" });
        expect(successes[0]).toMatch(/app-v2 \(v2\)/);
    });

    it("rollback requires an id, an org, and --yes", async () => {
        const { logger } = capturingLogger();

        expect((await runCloudCommand({ argument: ["rollback"], cwd: "/x", deps: deps(), logger, org: "o", yes: true })).code).toBe(1);
        expect((await runCloudCommand({ argument: ["rollback", "dep_1"], cwd: "/x", deps: deps(), logger, yes: true })).code).toBe(1);
        expect((await runCloudCommand({ argument: ["rollback", "dep_1"], cwd: "/x", deps: deps(), logger, org: "o" })).code).toBe(1);
    });
});
