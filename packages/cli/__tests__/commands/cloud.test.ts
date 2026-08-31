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

const deps = (over: Partial<CloudCommandDeps> = {}): Partial<CloudCommandDeps> => {
    return {
        deployFn: async () => {
            return { status: "live" };
        },
        env: { LUNORA_CLOUD_URL: "https://cloud", LUNORA_DEPLOY_KEY: "dk_secret" },
        readBundleBase64: () => "YnVuZGxl",
        readWrangler: () => {
            return { durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] }, name: "app", triggers: { crons: ["0 0 * * *"] } };
        },
        ejectFn: async () => {
            return { projectSlug: "acme", scriptName: "acme-v3", snapshot: '{"table":"users"}\n', url: "https://acme.lunora.app" };
        },
        rollbackFn: async () => {
            return { scriptName: "app-v2", version: 2 };
        },
        writeEjectFile: () => Promise.resolve(),
        ...over,
    };
};

describe("lunora cloud", () => {
    it("rejects an unknown subcommand", async () => {
        expect.assertions(2);

        const { errors, logger } = capturingLogger();
        const result = await runCloudCommand({ argument: ["frobnicate"], cwd: "/x", deps: deps(), logger });

        expect(result.code).toBe(1);
        expect(errors[0]).toMatch(/unknown subcommand/);
    });

    it("errors when the deploy key is absent (never a flag/file)", async () => {
        expect.assertions(2);

        const { errors, logger } = capturingLogger();
        const result = await runCloudCommand({
            argument: ["deploy"],
            cwd: "/x",
            deps: deps({ env: { LUNORA_CLOUD_URL: "https://cloud" } }),
            logger,
            project: "prj_1",
            bundlePath: "dist/index.js",
        });

        expect(result.code).toBe(1);
        expect(errors[0]).toMatch(/LUNORA_DEPLOY_KEY/);
    });

    it("errors when the API URL is absent", async () => {
        expect.assertions(2);

        const { errors, logger } = capturingLogger();
        const result = await runCloudCommand({
            argument: ["deploy"],
            cwd: "/x",
            deps: deps({ env: { LUNORA_DEPLOY_KEY: "dk" } }),
            logger,
            project: "prj_1",
            bundlePath: "b",
        });

        expect(result.code).toBe(1);
        expect(errors[0]).toMatch(/LUNORA_CLOUD_URL/);
    });

    it("deploys: sends the wrangler manifest + bundle and reports live", async () => {
        expect.assertions(3);

        const { logger, successes } = capturingLogger();
        const deployFn = vi.fn<CloudCommandDeps["deployFn"]>(async () => {
            return { status: "live" };
        });

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
        expect.assertions(1);

        const { logger } = capturingLogger();
        const result = await runCloudCommand({
            argument: ["deploy"],
            bundlePath: "b",
            cwd: "/x",
            deps: deps({
                deployFn: async () => {
                    return { status: "failed" };
                },
            }),
            logger,
            project: "prj_1",
        });

        expect(result).toStrictEqual({ code: 1, outcome: "failed" });
    });

    it("deploys: requires project and bundle", async () => {
        expect.assertions(4);

        const { errors, logger } = capturingLogger();

        await expect(runCloudCommand({ argument: ["deploy"], cwd: "/x", deps: deps(), logger, bundlePath: "b" })).resolves.toMatchObject({ code: 1 });
        await expect(runCloudCommand({ argument: ["deploy"], cwd: "/x", deps: deps(), logger, project: "prj_1" })).resolves.toMatchObject({ code: 1 });
        expect(errors.some((error) => /project/.test(error))).toBe(true);
        expect(errors.some((error) => /bundle/.test(error))).toBe(true);
    });

    it("deploys: rejects an invalid --kind", async () => {
        expect.assertions(2);

        const { errors, logger } = capturingLogger();
        const result = await runCloudCommand({ argument: ["deploy"], bundlePath: "b", cwd: "/x", deps: deps(), kind: "staging", logger, project: "prj_1" });

        expect(result.code).toBe(1);
        expect(errors[0]).toMatch(/invalid --kind/);
    });

    it("rolls back with confirmation and reports the now-serving script", async () => {
        expect.assertions(3);

        const { logger, successes } = capturingLogger();
        const rollbackFn = vi.fn<CloudCommandDeps["rollbackFn"]>(async () => {
            return { scriptName: "app-v2", version: 2 };
        });

        const result = await runCloudCommand({ argument: ["rollback", "dep_1"], cwd: "/x", deps: deps({ rollbackFn }), logger, org: "org_1", yes: true });

        expect(result).toStrictEqual({ code: 0, outcome: "app-v2" });
        expect(rollbackFn).toHaveBeenCalledWith({ apiUrl: "https://cloud", deployKey: "dk_secret", deploymentId: "dep_1", organizationId: "org_1" });
        expect(successes[0]).toMatch(/app-v2 \(v2\)/);
    });

    it("rollback requires an id, an org, and --yes", async () => {
        expect.assertions(3);

        const { logger } = capturingLogger();

        await expect(runCloudCommand({ argument: ["rollback"], cwd: "/x", deps: deps(), logger, org: "o", yes: true })).resolves.toMatchObject({ code: 1 });
        await expect(runCloudCommand({ argument: ["rollback", "dep_1"], cwd: "/x", deps: deps(), logger, yes: true })).resolves.toMatchObject({ code: 1 });
        await expect(runCloudCommand({ argument: ["rollback", "dep_1"], cwd: "/x", deps: deps(), logger, org: "o" })).resolves.toMatchObject({ code: 1 });
    });

    it("eject writes the three files into ./eject", async () => {
        expect.assertions(4);

        const written: { content: string; directory: string; name: string }[] = [];
        const { logger } = capturingLogger();

        const result = await runCloudCommand({
            argument: ["eject", "dep_1"],
            cwd: "/x",
            deps: deps({
                writeEjectFile: (directory, name, content) => {
                    written.push({ content, directory, name });

                    return Promise.resolve();
                },
            }),
            logger,
        });

        expect(result.code).toBe(0);
        expect(written.map((file) => file.name)).toStrictEqual(["export.ndjson", "wrangler.jsonc", "README.md"]);
        expect(written[0]?.directory).toBe("/x/eject");
        // The BYO config is named after the deployment's own script, not the cwd.
        expect(written[1]?.content).toContain('"name": "acme-v3"');
    });

    it("eject honours --out", async () => {
        expect.assertions(1);

        const written: string[] = [];
        const { logger } = capturingLogger();

        await runCloudCommand({
            argument: ["eject", "dep_1"],
            cwd: "/x",
            deps: deps({
                writeEjectFile: (directory) => {
                    written.push(directory);

                    return Promise.resolve();
                },
            }),
            ejectOut: "backup",
            logger,
        });

        expect(written[0]).toBe("/x/backup");
    });

    it("eject requires a deployment id", async () => {
        expect.assertions(2);

        const { errors, logger } = capturingLogger();
        const result = await runCloudCommand({ argument: ["eject"], cwd: "/x", deps: deps(), logger });

        expect(result.code).toBe(1);
        expect(errors[0]).toMatch(/requires a deployment id/);
    });

    /**
     * A half-written eject directory reads as a backup and is not one, so a failed
     * export must leave nothing behind rather than the files it managed first.
     */
    it("eject writes nothing when the control plane refuses", async () => {
        expect.assertions(3);

        const written: string[] = [];
        const { errors, logger } = capturingLogger();

        const result = await runCloudCommand({
            argument: ["eject", "dep_1"],
            cwd: "/x",
            deps: deps({
                ejectFn: () => Promise.reject(new Error("eject failed (404)")),
                writeEjectFile: (_directory, name) => {
                    written.push(name);

                    return Promise.resolve();
                },
            }),
            logger,
        });

        expect(result.code).toBe(1);
        expect(written).toStrictEqual([]);
        expect(errors[0]).toMatch(/eject failed \(404\)/);
    });
});
