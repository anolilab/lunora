import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { execute, runDeployCommand } from "../../src/commands/deploy/handler";
import type { DeployOptions } from "../../src/commands/deploy/index";
import type { Logger } from "../../src/util/logger";
import type { SpawnDescriptor } from "../../src/util/spawn";
import { createRecordingSpawner } from "../../src/util/spawn";
import { runExecute } from "../helpers/execute";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "..", "..", "..", "codegen", "__tests__", "fixtures", "simple");

/** Every spawn the deploy `execute` path makes goes through `defaultSpawner`; this records them. */
const executeSpawns: SpawnDescriptor[] = [];

vi.mock(import("../../src/util/spawn"), async (importOriginal) => {
    const actual = await importOriginal();

    return {
        ...actual,
        defaultSpawner: async (descriptor: SpawnDescriptor) => {
            executeSpawns.push(descriptor);

            return { code: 0, descriptor, stderr: "", stdout: "" };
        },
    };
});

const silentLogger = (): Logger => {
    return { error: () => {}, info: () => {}, success: () => {}, warn: () => {} };
};

const wranglerWith = (extra: Record<string, unknown>): string =>
    JSON.stringify({
        compatibility_date: "2026-04-07",
        compatibility_flags: ["nodejs_compat"],
        d1_databases: [{ binding: "DB", database_id: "real-db-id-abc123", database_name: "x" }],
        durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
        migrations: [{ new_sqlite_classes: ["ShardDO"], tag: "v1" }],
        name: "lunora-app",
        ...extra,
    });

const isClientBuild = (descriptor: SpawnDescriptor): boolean => descriptor.args.includes("vite") && descriptor.args.includes("build");

const noSecretList = () => Promise.resolve({ names: [], ok: false });

/** Records like the given spawner, and writes the redirect a composed service's build leaves behind. */
const withGeneratedConfig =
    (serviceDirectory: string, recorded: ReturnType<typeof createRecordingSpawner>["spawner"]) => async (descriptor: Parameters<typeof recorded>[0]) => {
        if (isClientBuild(descriptor) && descriptor.cwd === serviceDirectory) {
            mkdirSync(join(serviceDirectory, ".wrangler", "deploy"), { recursive: true });
            writeFileSync(join(serviceDirectory, ".wrangler", "deploy", "config.json"), JSON.stringify({ configPath: "../../generated.jsonc" }), "utf8");
        }

        return recorded(descriptor);
    };

let workdir: string;

describe("lunora deploy — client build before wrangler", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-deploy-framework-"));
        cpSync(join(fixtureRoot, "lunora"), join(workdir, "lunora"), { recursive: true });
        writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWith({ main: "virtual:lunora/worker" }), "utf8");
        writeFileSync(join(workdir, "vite.config.ts"), "export default {};\n", "utf8");
        executeSpawns.length = 0;
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("runs vite build before wrangler's dry run for a Vite-generated worker", async () => {
        expect.assertions(2);

        const { calls, spawner } = createRecordingSpawner();

        await runDeployCommand({ cwd: workdir, dryRun: true, logger: silentLogger(), spawner, secretLister: noSecretList });

        expect(calls.findIndex((call) => isClientBuild(call.descriptor))).toBe(0);
        expect(calls.some((call) => call.descriptor.args.includes("--dry-run"))).toBe(true);
    });

    it("leaves the postcodegen hook to the plugin's client build, which runs it before bundling, so it runs once", async () => {
        expect.assertions(1);

        writeFileSync(
            join(workdir, "package.json"),
            JSON.stringify({ dependencies: { "@lunora/d1": "*", "@lunora/storage": "*" }, name: "app", scripts: { postcodegen: "echo done" } }),
            "utf8",
        );

        const { calls, spawner } = createRecordingSpawner();

        await runDeployCommand({ cwd: workdir, dryRun: true, logger: silentLogger(), spawner, secretLister: () => Promise.resolve({ names: [], ok: false }) });

        const hookRuns = calls.filter((call) => call.descriptor.args.join(" ").includes("postcodegen"));

        expect(hookRuns).toHaveLength(0);
    });

    it("refuses an unusable target before the client build writes anything", async () => {
        expect.assertions(2);

        const { calls, spawner } = createRecordingSpawner();

        const result = await runDeployCommand({
            cwd: workdir,
            dryRun: true,
            logger: silentLogger(),
            spawner,
            secretLister: () => Promise.resolve({ names: [], ok: false }),
            target: "no-such-target",
        });

        expect(result.code).not.toBe(0);
        expect(calls.some((call) => isClientBuild(call.descriptor))).toBe(false);
    });

    it("leaves the API spec files a plugin build wrote as they are, rather than regenerating them", async () => {
        expect.assertions(2);

        const { calls, spawner: recorded } = createRecordingSpawner();
        const spawner = async (descriptor: Parameters<typeof recorded>[0]) => {
            if (isClientBuild(descriptor)) {
                mkdirSync(join(workdir, "lunora", "_generated"), { recursive: true });
                writeFileSync(join(workdir, "lunora", "_generated", "openrpc.json"), "from the plugin build", "utf8");
            }

            return recorded(descriptor);
        };

        await runDeployCommand({ cwd: workdir, dryRun: true, logger: silentLogger(), spawner, secretLister: () => Promise.resolve({ names: [], ok: false }) });

        expect(calls.some((call) => isClientBuild(call.descriptor))).toBe(true);
        expect(readFileSync(join(workdir, "lunora", "_generated", "openrpc.json"), "utf8")).toBe("from the plugin build");
    });

    it("tells the client build when advisories are opted out, so its plugin does not fail on them", async () => {
        expect.assertions(1);

        const { calls, spawner } = createRecordingSpawner();

        await runDeployCommand({
            cwd: workdir,
            dryRun: true,
            logger: silentLogger(),
            spawner,
            secretLister: () => Promise.resolve({ names: [], ok: false }),
            strictAdvisories: false,
        });

        const build = calls.find((call) => isClientBuild(call.descriptor));

        expect(build?.descriptor.env?.LUNORA_STRICT_ADVISORIES).toBe("0");
    });

    it("builds for the environment --env names, so the client output matches the environment wrangler deploys", async () => {
        expect.assertions(1);

        writeFileSync(
            join(workdir, "wrangler.jsonc"),
            wranglerWith({
                d1_databases: [{ binding: "DB", database_id: "real-db-id-abc123", database_name: "x" }],
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                env: {
                    staging: {
                        d1_databases: [{ binding: "DB", database_id: "real-db-id-abc123", database_name: "x" }],
                        durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                        name: "lunora-app-staging",
                    },
                },
                main: "virtual:lunora/worker",
                migrations: [{ new_sqlite_classes: ["ShardDO"], tag: "v1" }],
            }),
            "utf8",
        );

        const { calls, spawner } = createRecordingSpawner();

        await runDeployCommand({
            cwd: workdir,
            dryRun: true,
            env: "staging",
            logger: silentLogger(),
            spawner,
            secretLister: () => Promise.resolve({ names: [], ok: false }),
        });

        const build = calls.find((call) => isClientBuild(call.descriptor));

        expect(build?.descriptor.env?.CLOUDFLARE_ENV).toBe("staging");
    });

    it("keeps the client build out of a --prebuilt deploy, which trusts an artifact built earlier", async () => {
        expect.assertions(1);

        await runExecute<DeployOptions>(execute, {
            commandName: "deploy",
            cwd: workdir,
            options: { dryRun: true, prebuilt: true },
        });

        expect(executeSpawns.some((descriptor) => isClientBuild(descriptor))).toBe(false);
    });

    it("skips the client build with --no-framework-build", async () => {
        expect.assertions(1);

        await runExecute<DeployOptions>(execute, {
            commandName: "deploy",
            cwd: workdir,
            options: { dryRun: true, frameworkBuild: false },
        });

        expect(executeSpawns.some((descriptor) => isClientBuild(descriptor))).toBe(false);
    });

    it("runs the client build for a deploy that is not prebuilt", async () => {
        expect.assertions(1);

        await runExecute<DeployOptions>(execute, {
            commandName: "deploy",
            cwd: workdir,
            options: { dryRun: true },
        });

        expect(executeSpawns.some((descriptor) => isClientBuild(descriptor))).toBe(true);
    });
});

describe("lunora deploy — a service's client build", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-deploy-service-"));
        cpSync(join(fixtureRoot, "lunora"), join(workdir, "lunora"), { recursive: true });
        writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWith({ main: "virtual:lunora/worker" }), "utf8");
        writeFileSync(join(workdir, "vite.config.ts"), "export default {};\n", "utf8");
        writeFileSync(join(workdir, "lunora.config.ts"), `export default { services: { parser: { dir: "./services/parser" } } };\n`, "utf8");
        mkdirSync(join(workdir, "services", "parser"), { recursive: true });
        writeFileSync(join(workdir, "services", "parser", "wrangler.jsonc"), wranglerWith({ assets: { directory: "./dist" }, main: "src/index.ts" }), "utf8");
        writeFileSync(join(workdir, "services", "parser", "vite.config.ts"), "export default {};\n", "utf8");
        executeSpawns.length = 0;
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("deploys the config a service's own build generated, not its source config", async () => {
        expect.assertions(1);

        const serviceDirectory = join(workdir, "services", "parser");
        const { calls, spawner: recorded } = createRecordingSpawner();
        const spawner = withGeneratedConfig(serviceDirectory, recorded);

        await runDeployCommand({ cwd: workdir, dryRun: true, logger: silentLogger(), spawner, secretLister: noSecretList });

        const deploy = calls.find((call) => call.descriptor.cwd === serviceDirectory && !isClientBuild(call.descriptor));

        expect(deploy?.descriptor.args.join(" ")).toContain("generated.jsonc");
    });

    it("deploys the config a service's build generated under --env too, since that build ran for the deployed environment", async () => {
        expect.assertions(1);

        writeFileSync(
            join(workdir, "wrangler.jsonc"),
            wranglerWith({
                d1_databases: [{ binding: "DB", database_id: "real-db-id-abc123", database_name: "x" }],
                durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                env: {
                    staging: {
                        d1_databases: [{ binding: "DB", database_id: "real-db-id-abc123", database_name: "x" }],
                        durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                        name: "lunora-app-staging",
                    },
                },
                main: "virtual:lunora/worker",
                migrations: [{ new_sqlite_classes: ["ShardDO"], tag: "v1" }],
            }),
            "utf8",
        );

        const serviceDirectory = join(workdir, "services", "parser");
        const { calls, spawner: recorded } = createRecordingSpawner();
        const spawner = withGeneratedConfig(serviceDirectory, recorded);

        await runDeployCommand({
            cwd: workdir,
            dryRun: true,
            env: "staging",
            logger: silentLogger(),
            spawner,
            secretLister: noSecretList,
        });

        const deploy = calls.find((call) => call.descriptor.cwd === serviceDirectory && !isClientBuild(call.descriptor));

        expect(deploy?.descriptor.args.join(" ")).toContain("generated.jsonc");
    });

    it("builds a service whose assets are configured only under the --env block, for that environment", async () => {
        expect.assertions(2);

        writeFileSync(
            join(workdir, "wrangler.jsonc"),
            wranglerWith({
                env: {
                    staging: {
                        d1_databases: [{ binding: "DB", database_id: "real-db-id-abc123", database_name: "x" }],
                        durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
                        name: "lunora-app-staging",
                    },
                },
                main: "virtual:lunora/worker",
            }),
            "utf8",
        );
        writeFileSync(
            join(workdir, "services", "parser", "wrangler.jsonc"),
            wranglerWith({ env: { staging: { assets: { directory: "./dist" } } }, main: "src/index.ts" }),
            "utf8",
        );

        const serviceDirectory = join(workdir, "services", "parser");
        const { calls, spawner: recorded } = createRecordingSpawner();
        const spawner = withGeneratedConfig(serviceDirectory, recorded);

        await runDeployCommand({ cwd: workdir, dryRun: true, env: "staging", logger: silentLogger(), spawner, secretLister: noSecretList });

        const build = calls.find((call) => isClientBuild(call.descriptor) && call.descriptor.cwd === serviceDirectory);

        expect(build).toBeDefined();
        expect(build?.descriptor.env?.CLOUDFLARE_ENV).toBe("staging");
    });

    it("keeps the redirect a previous deploy left when the service's build is refused", async () => {
        expect.assertions(2);

        const serviceDirectory = join(workdir, "services", "parser");
        const redirect = join(serviceDirectory, ".wrangler", "deploy", "config.json");

        writeFileSync(join(serviceDirectory, "lunora.config.ts"), `export default { target: "node" };\n`, "utf8");
        mkdirSync(dirname(redirect), { recursive: true });
        writeFileSync(redirect, JSON.stringify({ configPath: "../../previous.jsonc" }), "utf8");

        const { spawner } = createRecordingSpawner();
        const result = await runDeployCommand({ cwd: workdir, dryRun: true, logger: silentLogger(), spawner, secretLister: noSecretList });

        expect(result.code).not.toBe(0);
        expect(readFileSync(redirect, "utf8")).toContain("previous.jsonc");
    });

    it("tells a service's client build the advisory opt-out, as it does the app's", async () => {
        expect.assertions(1);

        const serviceDirectory = join(workdir, "services", "parser");
        const { calls, spawner } = createRecordingSpawner();

        await runDeployCommand({ cwd: workdir, dryRun: true, logger: silentLogger(), spawner, secretLister: noSecretList, strictAdvisories: false });

        const build = calls.find((call) => isClientBuild(call.descriptor) && call.descriptor.cwd === serviceDirectory);

        expect(build?.descriptor.env?.LUNORA_STRICT_ADVISORIES).toBe("0");
    });

    it("keeps a service's client build out of a --prebuilt deploy, as it keeps the app's out", async () => {
        expect.assertions(1);

        const serviceDirectory = join(workdir, "services", "parser");
        const { calls, spawner } = createRecordingSpawner();

        await runDeployCommand({ cwd: workdir, dryRun: true, logger: silentLogger(), skipCodegen: true, spawner, secretLister: noSecretList });

        expect(calls.some((call) => isClientBuild(call.descriptor) && call.descriptor.cwd === serviceDirectory)).toBe(false);
    });

    it("refuses a service whose own target differs from the parent deploy, rather than building for another host", async () => {
        expect.assertions(2);

        const serviceDirectory = join(workdir, "services", "parser");

        writeFileSync(join(serviceDirectory, "lunora.config.ts"), `export default { target: "node" };\n`, "utf8");

        const { calls, spawner } = createRecordingSpawner();
        const result = await runDeployCommand({
            cwd: workdir,
            dryRun: true,
            logger: silentLogger(),
            spawner,
            secretLister: noSecretList,
        });

        expect(result.code).not.toBe(0);
        expect(calls.some((call) => isClientBuild(call.descriptor) && call.descriptor.cwd === serviceDirectory)).toBe(false);
    });

    it("runs the service's client build from its folder, before that service's wrangler deploy", async () => {
        expect.assertions(2);

        const serviceDirectory = join(workdir, "services", "parser");
        const { calls, spawner } = createRecordingSpawner();

        await runDeployCommand({ cwd: workdir, dryRun: true, logger: silentLogger(), spawner, secretLister: noSecretList });

        const build = calls.findIndex((call) => isClientBuild(call.descriptor) && call.descriptor.cwd === serviceDirectory);
        const deploy = calls.findIndex((call) => call.descriptor.cwd === serviceDirectory && !isClientBuild(call.descriptor));

        expect(build).toBeGreaterThanOrEqual(0);
        expect(build).toBeLessThan(deploy);
    });
});
