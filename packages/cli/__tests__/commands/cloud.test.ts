import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildBindingManifest } from "@lunora/config/cloudflare";
import { describe, expect, it, vi } from "vitest";

import type { CloudCommandDeps } from "../../src/commands/cloud/handler";
import { runCloudCommand } from "../../src/commands/cloud/handler";
import type { Logger } from "../../src/util/logger";

const capturingLogger = (): { errors: string[]; infos: string[]; logger: Logger; successes: string[]; warnings: string[] } => {
    const errors: string[] = [];
    const infos: string[] = [];
    const successes: string[] = [];
    const warnings: string[] = [];

    return {
        errors,
        infos,
        logger: {
            error: (message) => errors.push(message),
            info: (message) => infos.push(message),
            success: (message) => successes.push(message),
            warn: (message) => warnings.push(message),
        },
        successes,
        warnings,
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
            return {
                config: { durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] }, name: "app", triggers: { crons: ["0 0 * * *"] } },
                path: "/x/wrangler.jsonc",
            };
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
                branch: "feat/x",
                bundle: "YnVuZGxl",
                cronSpecs: ["0 0 * * *"],
                deployKey: "dk_secret",
                kind: "preview",
                manifest: { bindings: [{ binding: "SHARD", className: "ShardDO", sqlite: false, type: "durable_object" }] },
                projectId: "prj_1",
                scriptName: "app",
            }),
            expect.any(Function),
        );
    });

    it("deploy --out writes the request body it would upload, without a key or URL", async () => {
        expect.assertions(4);

        const writes: { content: string; path: string }[] = [];
        const deployFn = vi.fn<CloudCommandDeps["deployFn"]>();
        const { logger } = capturingLogger();

        const result = await runCloudCommand({
            argument: ["deploy"],
            bundlePath: "dist/index.js",
            cwd: "/x",
            deps: deps({
                deployFn,
                // No LUNORA_DEPLOY_KEY / LUNORA_CLOUD_URL: writing a file authenticates nothing.
                env: {},
                writeDeployBody: (path, content) => {
                    writes.push({ content, path });

                    return Promise.resolve();
                },
            }),
            logger,
            out: "out/release.json",
        });

        expect(result).toStrictEqual({ code: 0, outcome: "/x/out/release.json" });
        expect(deployFn).not.toHaveBeenCalled();
        expect(writes.map((write) => write.path)).toStrictEqual(["/x/out/release.json"]);
        // The body the upload sends, minus routing the caller did not give — and no key.
        expect(JSON.parse(writes[0]?.content ?? "")).toStrictEqual({
            bundle: "YnVuZGxl",
            cronSpecs: ["0 0 * * *"],
            manifest: { bindings: [{ binding: "SHARD", className: "ShardDO", sqlite: false, type: "durable_object" }] },
            scriptName: "app",
        });
    });

    it("deploy --out carries the same body the upload sends when routing is given", async () => {
        expect.assertions(1);

        let uploaded: unknown;
        let written: unknown;
        const { logger } = capturingLogger();
        const common = { argument: ["deploy"], branch: "feat/x", bundlePath: "dist/index.js", cwd: "/x", kind: "preview", logger, project: "prj_1" };

        await runCloudCommand({
            ...common,
            deps: deps({
                deployFn: async (options) => {
                    // The transport fields are the upload's own; the rest is the body.
                    uploaded = Object.fromEntries(Object.entries(options).filter(([key]) => key !== "apiUrl" && key !== "deployKey"));

                    return { status: "live" };
                },
            }),
        });
        await runCloudCommand({
            ...common,
            deps: deps({
                writeDeployBody: (_path, content) => {
                    written = JSON.parse(content);

                    return Promise.resolve();
                },
            }),
            out: "release.json",
        });

        expect(written).toStrictEqual(uploaded);
    });

    it("deploy --out still refuses a project with no wrangler config", async () => {
        expect.assertions(3);

        const writeDeployBody = vi.fn<CloudCommandDeps["writeDeployBody"]>();
        const { errors, logger } = capturingLogger();

        const result = await runCloudCommand({
            argument: ["deploy"],
            bundlePath: "dist/index.js",
            cwd: "/x",
            deps: deps({ readWrangler: () => undefined, writeDeployBody }),
            logger,
            out: "release.json",
        });

        expect(result.code).toBe(1);
        expect(writeDeployBody).not.toHaveBeenCalled();
        expect(errors[0]).toMatch(/no readable wrangler config/);
    });

    it("deploys: every binding type in the manifest passes through, with the compatibility settings", async () => {
        expect.assertions(3);

        const config = {
            ai: { binding: "AI" },
            analytics_engine_datasets: [{ binding: "EVENTS", dataset: "events" }],
            browser: { binding: "BROWSER" },
            compatibility_date: "2026-01-01",
            compatibility_flags: ["nodejs_compat"],
            containers: [{ class_name: "Box" }],
            d1_databases: [{ binding: "DB", database_name: "db" }],
            durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
            hyperdrive: [{ binding: "PG", id: "hd_1" }],
            images: { binding: "IMAGES" },
            kv_namespaces: [{ binding: "CACHE" }],
            name: "app",
            pipelines: [{ binding: "PIPE", pipeline: "p" }],
            queues: { consumers: [{ queue: "jobs" }], producers: [{ binding: "JOBS", queue: "jobs" }] },
            r2_buckets: [{ binding: "FILES", bucket_name: "files" }],
            vectorize: [{ binding: "SEARCH", index_name: "idx" }],
            workflows: [{ binding: "FLOW", class_name: "Flow", name: "flow" }],
        };
        const deployFn = vi.fn<CloudCommandDeps["deployFn"]>(async () => {
            return { status: "live" };
        });
        const { logger, warnings } = capturingLogger();

        await runCloudCommand({
            argument: ["deploy"],
            bundlePath: "b",
            cwd: "/x",
            deps: deps({
                deployFn,
                readWrangler: () => {
                    return { config, path: "/x/wrangler.jsonc" };
                },
            }),
            logger,
            project: "prj_1",
        });

        const sent = deployFn.mock.calls[0]?.[0];

        expect(sent?.manifest).toStrictEqual({
            bindings: buildBindingManifest(config).bindings,
            compatibilityDate: "2026-01-01",
            compatibilityFlags: ["nodejs_compat"],
        });
        expect(new Set(sent?.manifest.bindings.map((binding) => binding.type))).toStrictEqual(
            new Set([
                "ai",
                "analytics_engine",
                "browser",
                "container",
                "d1",
                "durable_object",
                "hyperdrive",
                "images",
                "kv",
                "pipeline",
                "queue_consumer",
                "queue_producer",
                "r2",
                "vectorize",
                "workflow",
            ]),
        );
        expect(warnings).toStrictEqual([]);
    });

    it("deploys: warns about unmodelled wrangler sections but still deploys", async () => {
        expect.assertions(3);

        const deployFn = vi.fn<CloudCommandDeps["deployFn"]>(async () => {
            return { status: "live" };
        });
        const { logger, warnings } = capturingLogger();

        const result = await runCloudCommand({
            argument: ["deploy"],
            bundlePath: "b",
            cwd: "/x",
            deps: deps({
                deployFn,
                readWrangler: () => {
                    return { config: { mtls_certificates: [], name: "app" }, path: "/x/wrangler.jsonc" };
                },
            }),
            logger,
            project: "prj_1",
        });

        expect(result.code).toBe(0);
        expect(deployFn).toHaveBeenCalledTimes(1);
        expect(warnings[0]).toMatch(/does not model these wrangler sections: mtls_certificates/);
    });

    it("deploys: refuses without a readable wrangler config", async () => {
        expect.assertions(2);

        const { errors, logger } = capturingLogger();
        const result = await runCloudCommand({
            argument: ["deploy"],
            bundlePath: "b",
            cwd: "/x",
            deps: deps({ readWrangler: () => undefined }),
            logger,
            project: "prj_1",
            scriptName: "app",
        });

        expect(result.code).toBe(1);
        expect(errors[0]).toMatch(/no readable wrangler config/);
    });

    it("deploys: uploads static assets from the directory relative to the wrangler file", async () => {
        expect.assertions(2);

        const root = mkdtempSync(join(tmpdir(), "lunora-cloud-deploy-"));

        try {
            mkdirSync(join(root, "app", "dist", "client"), { recursive: true });
            writeFileSync(join(root, "app", "dist", "client", "index.html"), "hi");

            const deployFn = vi.fn<CloudCommandDeps["deployFn"]>(async () => {
                return { status: "live" };
            });
            const { logger } = capturingLogger();

            const result = await runCloudCommand({
                argument: ["deploy"],
                bundlePath: "b",
                cwd: root,
                deps: deps({
                    deployFn,
                    readWrangler: () => {
                        return {
                            config: { assets: { binding: "ASSETS", directory: "./dist/client", not_found_handling: "404-page" }, name: "app" },
                            path: join(root, "app", "wrangler.jsonc"),
                        };
                    },
                }),
                logger,
                project: "prj_1",
            });

            expect(result.code).toBe(0);
            expect(deployFn.mock.calls[0]?.[0].assets).toStrictEqual({
                config: { not_found_handling: "404-page" },
                files: [{ content: "aGk=", path: "/index.html" }],
            });
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("deploys: an assets binding whose directory is missing tells the user to build first", async () => {
        expect.assertions(3);

        const deployFn = vi.fn<CloudCommandDeps["deployFn"]>();
        const { errors, logger } = capturingLogger();
        const root = mkdtempSync(join(tmpdir(), "lunora-cloud-deploy-"));

        try {
            const result = await runCloudCommand({
                argument: ["deploy"],
                bundlePath: "b",
                cwd: root,
                deps: deps({
                    deployFn,
                    readWrangler: () => {
                        return { config: { assets: { binding: "ASSETS", directory: "dist" }, name: "app" }, path: join(root, "wrangler.jsonc") };
                    },
                }),
                logger,
                project: "prj_1",
            });

            expect(result.code).toBe(1);
            expect(deployFn).not.toHaveBeenCalled();
            expect(errors[0]).toMatch(/does not exist — build the app first/);
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
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

    it("eject writes the four files into ./eject", async () => {
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
        expect(written.map((file) => file.name)).toStrictEqual(["export.ndjson", "wrangler.jsonc", "alchemy.run.ts", "README.md"]);
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
            out: "backup",
            logger,
        });

        expect(written[0]).toBe("/x/backup");
    });

    it("eject derives the config from the project's own wrangler config", async () => {
        expect.assertions(2);

        const written = new Map<string, string>();
        const { logger } = capturingLogger();

        await runCloudCommand({
            argument: ["eject", "dep_1"],
            cwd: "/x",
            deps: deps({
                writeEjectFile: (_directory, name, content) => {
                    written.set(name, content);

                    return Promise.resolve();
                },
            }),
            logger,
        });

        // The fixture's DO binding and cron, not a hard-coded template.
        expect(JSON.parse(written.get("wrangler.jsonc") ?? "")).toMatchObject({
            durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
            triggers: { crons: ["0 0 * * *"] },
        });
        // eslint-disable-next-line no-secrets/no-secrets -- emitted Alchemy source, not a credential
        expect(written.get("alchemy.run.ts")).toContain(`SHARD: Cloudflare.Workers.DurableObject("SHARD", { className: "ShardDO" }),`);
    });

    it("eject fails before calling the control plane when there is no wrangler config", async () => {
        expect.assertions(3);

        const ejectFn = vi.fn<CloudCommandDeps["ejectFn"]>();
        const { errors, logger } = capturingLogger();
        const result = await runCloudCommand({ argument: ["eject", "dep_1"], cwd: "/x", deps: deps({ ejectFn, readWrangler: () => undefined }), logger });

        expect(result.code).toBe(1);
        expect(errors[0]).toMatch(/no readable wrangler config/);
        expect(ejectFn).not.toHaveBeenCalled();
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
