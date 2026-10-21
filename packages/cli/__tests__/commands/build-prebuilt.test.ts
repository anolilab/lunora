import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runBuildCommand } from "../../src/commands/build/handler";
import { execute as executeDeploy, runDeployCommand } from "../../src/commands/deploy/handler";
import type { DeployOptions } from "../../src/commands/deploy/index";
import { readBuildMarker } from "../../src/util/build-marker";
import { EXIT_CODE } from "../../src/util/exit-code";
import type { Logger } from "../../src/util/logger";
import type { SpawnDescriptor, Spawner } from "../../src/util/spawn";
import { runExecute } from "../helpers/execute";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "..", "..", "..", "codegen", "__tests__", "fixtures", "simple");

/** Every spawn `execute` makes goes through `defaultSpawner`; a refused deploy must make none, so this records them. */
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

const noRemoteSecrets = () => Promise.resolve({ names: [], ok: false });

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

let workdir: string;

/** What the Cloudflare Vite plugin leaves behind: the redirect file, the redirected config, and the client assets. */
const writeViteOutput = (root: string): void => {
    mkdirSync(join(root, ".wrangler", "deploy"), { recursive: true });
    writeFileSync(join(root, ".wrangler", "deploy", "config.json"), JSON.stringify({ configPath: "../../dist/server/wrangler.json" }), "utf8");
    mkdirSync(join(root, "dist", "server"), { recursive: true });
    writeFileSync(join(root, "dist", "server", "wrangler.json"), JSON.stringify({ assets: { directory: "../client" }, main: "index.js" }), "utf8");
    mkdirSync(join(root, "dist", "client"), { recursive: true });
    writeFileSync(join(root, "dist", "client", "index.html"), "<html></html>\n", "utf8");
};

/** Records every spawn. The client build (`vite build`) writes its output unless `frameworkExit` fails it. */
const buildSpawner = (options: { frameworkExit?: number } = {}) => {
    const calls: SpawnDescriptor[] = [];
    const spawner: Spawner = async (descriptor) => {
        calls.push(descriptor);

        const isFramework = !descriptor.args.includes("--dry-run") && descriptor.args.includes("build");
        const code = isFramework ? (options.frameworkExit ?? 0) : 0;

        if (isFramework && code === 0) {
            writeViteOutput(workdir);
        }

        return { code, descriptor, stderr: "", stdout: "" };
    };

    return { calls, spawner };
};

const clientBuildCalls = (calls: SpawnDescriptor[]): SpawnDescriptor[] =>
    calls.filter((call) => !call.args.includes("--dry-run") && call.args.includes("build"));

/** `deploy --prebuilt` the way `execute` builds it: no client build, no codegen. */
const deployPrebuilt = (options: { env?: string; spawner?: Spawner } = {}) => {
    const { calls, spawner } = buildSpawner();

    return runDeployCommand({
        dryRun: true,
        env: options.env,
        frameworkBuild: false,
        logger: silentLogger(),
        prebuilt: true,
        secretLister: noRemoteSecrets,
        skipCodegen: true,
        cwd: workdir,
        spawner: options.spawner ?? spawner,
    }).then((result) => {
        return { calls, result };
    });
};

describe("lunora build → deploy --prebuilt", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-build-prebuilt-"));
        cpSync(join(fixtureRoot, "lunora"), join(workdir, "lunora"), { recursive: true });
        writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWith({ main: "virtual:lunora/worker" }), "utf8");
        writeFileSync(join(workdir, "vite.config.ts"), "export default {};\n", "utf8");
        executeSpawns.length = 0;
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("refuses a client-build project with no marker, and says to run lunora build", async () => {
        expect.assertions(3);

        const { calls, result } = await deployPrebuilt();

        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(result.error).toContain("Run `lunora build` first");
        expect(calls).toHaveLength(0);
    });

    it("refuses when a source changed after lunora build", async () => {
        expect.assertions(2);

        await runBuildCommand({ cwd: workdir, logger: silentLogger(), spawner: buildSpawner().spawner });
        writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWith({ main: "virtual:lunora/worker", name: "changed" }), "utf8");

        const { result } = await deployPrebuilt();

        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(result.error).toContain("sources changed since `lunora build`");
    });

    it("refuses a default-environment build deployed with --env staging", async () => {
        expect.assertions(2);

        await runBuildCommand({ cwd: workdir, logger: silentLogger(), spawner: buildSpawner().spawner });

        const { result } = await deployPrebuilt({ env: "staging" });

        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(result.error).toContain("environment staging");
    });

    it("refuses when a recorded output directory is missing, such as a CI job that did not upload dist/", async () => {
        expect.assertions(2);

        await runBuildCommand({ cwd: workdir, logger: silentLogger(), spawner: buildSpawner().spawner });
        rmSync(join(workdir, "dist"), { force: true, recursive: true });

        const { result } = await deployPrebuilt();

        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(result.error).toContain("is missing: dist/server/wrangler.json, dist/client");
    });

    it("accepts an unchanged build and runs no client build on deploy", async () => {
        expect.assertions(3);

        const build = buildSpawner();

        await runBuildCommand({ cwd: workdir, logger: silentLogger(), spawner: build.spawner });

        const { calls, result } = await deployPrebuilt();

        expect(result.code).toBe(0);
        expect(clientBuildCalls(calls)).toHaveLength(0);
        expect(calls.some((call) => call.args.includes("--dry-run"))).toBe(true);
    });

    it("accepts a plain Worker with no client build and no marker", async () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWith({ main: "src/server.ts" }), "utf8");
        rmSync(join(workdir, "vite.config.ts"), { force: true });

        const { result } = await deployPrebuilt();

        expect(result.code).toBe(0);
        expect(readBuildMarker(workdir)).toBeUndefined();
    });

    it("leaves no marker behind when the build fails, and clears one from an earlier build", async () => {
        expect.assertions(3);

        await runBuildCommand({ cwd: workdir, logger: silentLogger(), spawner: buildSpawner().spawner });

        expect(readBuildMarker(workdir)).toBeDefined();

        const failed = await runBuildCommand({ cwd: workdir, logger: silentLogger(), spawner: buildSpawner({ frameworkExit: 1 }).spawner });

        expect(failed.code).not.toBe(0);
        expect(readBuildMarker(workdir)).toBeUndefined();
    });

    it("refuses a build that skipped its client build, even when stale client output is on disk", async () => {
        expect.assertions(2);

        writeViteOutput(workdir);
        await runBuildCommand({ cwd: workdir, frameworkBuild: false, logger: silentLogger(), spawner: buildSpawner().spawner });

        const { result } = await deployPrebuilt();

        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(result.error).toContain("without its client build");
    });

    it("fingerprints a real build, including its codegen output, the same in two checkouts", async () => {
        expect.assertions(4);

        const [first, second] = [mkdtempSync(join(tmpdir(), "lunora-checkout-a-")), mkdtempSync(join(tmpdir(), "lunora-checkout-b-"))];

        try {
            for (const root of [first, second]) {
                cpSync(join(fixtureRoot, "lunora"), join(root, "lunora"), { recursive: true });
                writeFileSync(join(root, "wrangler.jsonc"), wranglerWith({ main: "src/server.ts" }), "utf8");
            }

            const firstBuild = await runBuildCommand({ cwd: first, logger: silentLogger(), spawner: buildSpawner().spawner });
            const secondBuild = await runBuildCommand({ cwd: second, logger: silentLogger(), spawner: buildSpawner().spawner });

            expect(firstBuild.code).toBe(0);
            expect(secondBuild.code).toBe(0);
            expect(readBuildMarker(first)?.fingerprint).toBeDefined();
            expect(readBuildMarker(first)?.fingerprint).toBe(readBuildMarker(second)?.fingerprint);
        } finally {
            rmSync(first, { force: true, recursive: true });
            rmSync(second, { force: true, recursive: true });
        }
    });

    it("refuses through the command's execute, so the handler maps the option to the guard", async () => {
        expect.assertions(2);

        const outcome = await runExecute<DeployOptions>(executeDeploy, {
            commandName: "deploy",
            cwd: workdir,
            options: { prebuilt: true },
        });

        expect(outcome.code).toBe(EXIT_CODE.USAGE);
        expect(executeSpawns).toHaveLength(0);
    });
});
