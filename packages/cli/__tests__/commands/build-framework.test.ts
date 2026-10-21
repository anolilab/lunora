import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { frameworkBuildFor } from "../../src/commands/build/framework-build";
import { runBuildCommand } from "../../src/commands/build/handler";
import type { Logger } from "../../src/util/logger";
import type { SpawnDescriptor, Spawner } from "../../src/util/spawn";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "..", "..", "..", "codegen", "__tests__", "fixtures", "simple");

const silentLogger = (): Logger => {
    return { error: () => {}, info: () => {}, success: () => {}, warn: () => {} };
};

/** A wrangler config whose `main` and `assets` decide whether the client build runs. */
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

/**
 * Records every spawn. `frameworkExit` is the exit code of the client build
 * (`vite build` / `rsbuild build`); wrangler's dry run always succeeds. A
 * client build can also rewrite `wrangler.jsonc`, the way the Cloudflare Vite
 * plugin does, so the rollback can be checked.
 */
const recordingSpawner = (options: { frameworkExit?: number; rewriteWrangler?: string } = {}) => {
    const calls: SpawnDescriptor[] = [];
    const spawner: Spawner = async (descriptor) => {
        calls.push(descriptor);

        const isFramework = !descriptor.args.includes("--dry-run") && descriptor.args.includes("build");

        if (isFramework && options.rewriteWrangler !== undefined) {
            writeFileSync(join(workdir, "wrangler.jsonc"), options.rewriteWrangler, "utf8");
        }

        return { code: isFramework ? (options.frameworkExit ?? 0) : 0, descriptor, stderr: "", stdout: "" };
    };

    return { calls, spawner };
};

/** The client-build calls, i.e. spawns that are not wrangler's dry run. */
const frameworkCalls = (calls: SpawnDescriptor[]): SpawnDescriptor[] => calls.filter((call) => !call.args.includes("--dry-run"));

describe("lunora build — client build", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-build-framework-"));
        cpSync(join(fixtureRoot, "lunora"), join(workdir, "lunora"), { recursive: true });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    describe("before wrangler", () => {
        it("runs vite build first when wrangler's main is the Vite-generated composed entry", async () => {
            expect.assertions(3);

            writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWith({ main: "virtual:lunora/worker" }), "utf8");
            writeFileSync(join(workdir, "vite.config.ts"), "export default {};\n", "utf8");

            const { calls, spawner } = recordingSpawner();
            const result = await runBuildCommand({ cwd: workdir, logger: silentLogger(), spawner });

            expect(result.code).toBe(0);
            expect(calls[0]?.args).toEqual(expect.arrayContaining(["vite", "build"]));
            expect(calls[1]?.args).toContain("--dry-run");
        });

        it("runs rsbuild build when the project has an rsbuild config and wrangler serves its assets", async () => {
            expect.assertions(2);

            writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWith({ assets: { directory: "./dist" }, main: "src/server.ts" }), "utf8");
            writeFileSync(join(workdir, "rsbuild.config.ts"), "export default {};\n", "utf8");

            const { calls, spawner } = recordingSpawner();
            const result = await runBuildCommand({ cwd: workdir, logger: silentLogger(), spawner });

            expect(result.code).toBe(0);
            expect(calls[0]?.args).toEqual(expect.arrayContaining(["rsbuild", "build"]));
        });

        it("leaves a plain Worker alone, even with a vite config on disk", async () => {
            expect.assertions(2);

            writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWith({ main: "src/server.ts" }), "utf8");
            writeFileSync(join(workdir, "vite.config.ts"), "export default {};\n", "utf8");

            const { calls, spawner } = recordingSpawner();
            const result = await runBuildCommand({ cwd: workdir, logger: silentLogger(), spawner });

            expect(result.code).toBe(0);
            expect(frameworkCalls(calls)).toHaveLength(0);
        });

        it("skips the client build with frameworkBuild: false, the --no-framework-build path", async () => {
            expect.assertions(1);

            writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWith({ main: "virtual:lunora/worker" }), "utf8");
            writeFileSync(join(workdir, "vite.config.ts"), "export default {};\n", "utf8");

            const { calls, spawner } = recordingSpawner();

            await runBuildCommand({ cwd: workdir, frameworkBuild: false, logger: silentLogger(), spawner });

            expect(frameworkCalls(calls)).toHaveLength(0);
        });

        it("stops before wrangler when the client build fails", async () => {
            expect.assertions(3);

            writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWith({ main: "virtual:lunora/worker" }), "utf8");
            writeFileSync(join(workdir, "vite.config.ts"), "export default {};\n", "utf8");

            const { calls, spawner } = recordingSpawner({ frameworkExit: 2 });
            const result = await runBuildCommand({ cwd: workdir, logger: silentLogger(), spawner });

            expect(result.code).not.toBe(0);
            expect(result.error).toBe("vite build failed with exit code 2");
            expect(calls.some((call) => call.args.includes("--dry-run"))).toBe(false);
        });

        it("passes the lazy-functions opt-in to the client build through the env var both plugins read", async () => {
            expect.assertions(2);

            writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWith({ main: "virtual:lunora/worker" }), "utf8");
            writeFileSync(join(workdir, "vite.config.ts"), "export default {};\n", "utf8");

            const { calls, spawner } = recordingSpawner();

            await runBuildCommand({ cwd: workdir, lazyFunctions: true, logger: silentLogger(), spawner });

            expect(frameworkCalls(calls)[0]?.env).toEqual({ LUNORA_LAZY_FUNCTIONS: "1" });

            const eager = recordingSpawner();

            await runBuildCommand({ cwd: workdir, logger: silentLogger(), spawner: eager.spawner });

            expect(frameworkCalls(eager.calls)[0]?.env).toBeUndefined();
        });

        it("rolls back wrangler.jsonc edits the client build makes, so build leaves the committed config alone", async () => {
            expect.assertions(2);

            const original = wranglerWith({ main: "virtual:lunora/worker" });

            writeFileSync(join(workdir, "wrangler.jsonc"), original, "utf8");
            writeFileSync(join(workdir, "vite.config.ts"), "export default {};\n", "utf8");

            const { spawner } = recordingSpawner({ rewriteWrangler: wranglerWith({ main: "virtual:lunora/worker", vite_marker: true }) });
            const result = await runBuildCommand({ cwd: workdir, logger: silentLogger(), spawner });

            expect(result.code).toBe(0);
            expect(readFileSync(join(workdir, "wrangler.jsonc"), "utf8")).not.toContain("vite_marker");
        });
    });

    describe("before wrangler — output and flags", () => {
        it("keeps the client build's output off stdout under --format json", async () => {
            expect.assertions(2);

            writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWith({ main: "virtual:lunora/worker" }), "utf8");
            writeFileSync(join(workdir, "vite.config.ts"), "export default {};\n", "utf8");

            const json = recordingSpawner();

            await runBuildCommand({ cwd: workdir, format: "json", logger: silentLogger(), spawner: json.spawner });

            const pretty = recordingSpawner();

            await runBuildCommand({ cwd: workdir, logger: silentLogger(), spawner: pretty.spawner });

            expect(frameworkCalls(json.calls)[0]?.stdoutToStderr).toBe(true);
            expect(frameworkCalls(pretty.calls)[0]?.stdoutToStderr).toBe(false);
        });

        it("refuses --api-spec when a client build would run, since the plugin config decides it", async () => {
            expect.assertions(3);

            writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWith({ main: "virtual:lunora/worker" }), "utf8");
            writeFileSync(join(workdir, "vite.config.ts"), "export default {};\n", "utf8");

            const { calls, spawner } = recordingSpawner();
            const result = await runBuildCommand({ apiSpec: "openrpc", cwd: workdir, logger: silentLogger(), spawner });

            expect(result.code).not.toBe(0);
            expect(result.error).toContain("--api-spec is read from the vite plugin config");
            expect(calls).toHaveLength(0);
        });

        it("refuses a --target that differs from the project's target, but accepts the one it already has", async () => {
            expect.assertions(3);

            writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWith({ main: "virtual:lunora/worker" }), "utf8");
            writeFileSync(join(workdir, "vite.config.ts"), "export default {};\n", "utf8");

            const refused = await runBuildCommand({ cwd: workdir, logger: silentLogger(), spawner: recordingSpawner().spawner, target: "celld" });

            expect(refused.error).toContain("--target celld differs from the project's target (cloudflare)");

            const accepted = recordingSpawner();
            const result = await runBuildCommand({ cwd: workdir, logger: silentLogger(), spawner: accepted.spawner, target: "cloudflare" });

            expect(result.code).toBe(0);
            expect(frameworkCalls(accepted.calls)).toHaveLength(1);
        });
    });

    describe("frameworkBuildFor", () => {
        it("returns undefined when there is no vite or rsbuild config", () => {
            expect.assertions(1);

            writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWith({ main: "virtual:lunora/worker" }), "utf8");

            expect(frameworkBuildFor(workdir)).toBeUndefined();
        });

        it("prefers rsbuild when both configs exist", () => {
            expect.assertions(1);

            writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWith({ main: "virtual:lunora/worker" }), "utf8");
            writeFileSync(join(workdir, "vite.config.ts"), "export default {};\n", "utf8");
            writeFileSync(join(workdir, "rsbuild.config.mjs"), "export default {};\n", "utf8");

            expect(frameworkBuildFor(workdir)).toBe("rsbuild");
        });

        it("still builds when a stale dist and a framework redirect already exist", () => {
            expect.assertions(1);

            writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWith({ main: "virtual:lunora/worker" }), "utf8");
            writeFileSync(join(workdir, "vite.config.ts"), "export default {};\n", "utf8");
            mkdirSync(join(workdir, "dist"), { recursive: true });
            mkdirSync(join(workdir, ".wrangler", "deploy"), { recursive: true });
            writeFileSync(join(workdir, ".wrangler", "deploy", "config.json"), "{}\n", "utf8");

            expect(frameworkBuildFor(workdir)).toBe("vite");
        });
    });
});
