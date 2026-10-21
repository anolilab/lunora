import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

        await runDeployCommand({ cwd: workdir, dryRun: true, logger: silentLogger(), spawner, secretLister: () => Promise.resolve({ names: [], ok: false }) });

        expect(calls.findIndex((call) => isClientBuild(call.descriptor))).toBe(0);
        expect(calls.some((call) => call.descriptor.args.includes("--dry-run"))).toBe(true);
    });

    it("runs the postcodegen script once per build, inside the client build, not again in the deploy pipeline", async () => {
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

    it("emits the API spec its client build selected, not the deploy default that would delete it", async () => {
        expect.assertions(2);

        const { calls, spawner: recorded } = createRecordingSpawner();
        const spawner = async (descriptor: Parameters<typeof recorded>[0]) => {
            if (isClientBuild(descriptor)) {
                mkdirSync(join(workdir, ".lunora"), { recursive: true });
                writeFileSync(join(workdir, ".lunora", "api-spec.json"), JSON.stringify({ apiSpec: "openrpc" }), "utf8");
            }

            return recorded(descriptor);
        };

        await runDeployCommand({ cwd: workdir, dryRun: true, logger: silentLogger(), spawner, secretLister: () => Promise.resolve({ names: [], ok: false }) });

        expect(calls.some((call) => isClientBuild(call.descriptor))).toBe(true);
        expect(existsSync(join(workdir, "lunora", "_generated", "openrpc.json"))).toBe(true);
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
