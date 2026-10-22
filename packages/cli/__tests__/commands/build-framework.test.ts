import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_BUNDLE_META_PATH } from "@lunora/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { frameworkBuildFor, runClientBuild, viteBundleMetaPath } from "../../src/commands/build/framework-build";
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
const recordingSpawner = (
    options: { frameworkExit?: number; rewriteWrangler?: string; viteMeta?: string; wranglerExit?: number; wranglerMeta?: string } = {},
) => {
    const calls: SpawnDescriptor[] = [];
    const spawner: Spawner = async (descriptor) => {
        calls.push(descriptor);

        const isFramework = !descriptor.args.includes("--dry-run") && descriptor.args.includes("build");

        if (isFramework && options.rewriteWrangler !== undefined) {
            writeFileSync(join(workdir, "wrangler.jsonc"), options.rewriteWrangler, "utf8");
        }

        if (isFramework && options.viteMeta !== undefined) {
            // The plugin writes where `lunora build` points it through the env var.
            const metaPath = descriptor.env?.LUNORA_BUNDLE_META_PATH ?? join(workdir, DEFAULT_BUNDLE_META_PATH);

            mkdirSync(dirname(metaPath), { recursive: true });
            writeFileSync(metaPath, options.viteMeta, "utf8");
        }

        // What wrangler's `--outdir` writes next to the bundle it emits.
        if (!isFramework && descriptor.args.includes("--dry-run") && options.wranglerMeta !== undefined) {
            mkdirSync(join(workdir, "out"), { recursive: true });
            writeFileSync(join(workdir, "out", "bundle-meta.json"), options.wranglerMeta, "utf8");
        }

        return { code: isFramework ? (options.frameworkExit ?? 0) : (options.wranglerExit ?? 0), descriptor, stderr: "", stdout: "" };
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

        it("runs the project's build script for a framework with no Vite or rsbuild config, such as Astro or Nuxt", async () => {
            expect.assertions(2);

            writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWith({ assets: { directory: "./dist" }, main: "src/server.ts" }), "utf8");
            writeFileSync(
                join(workdir, "package.json"),
                JSON.stringify({ dependencies: { "@lunora/d1": "*", "@lunora/storage": "*" }, name: "app", scripts: { build: "astro build" } }),
                "utf8",
            );

            const { calls, spawner } = recordingSpawner();
            const result = await runBuildCommand({ cwd: workdir, logger: silentLogger(), spawner });

            expect(result.code).toBe(0);
            expect(frameworkCalls(calls)[0]?.args).toEqual(["run", "build"]);
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

            expect(frameworkCalls(calls)[0]?.env).toMatchObject({ LUNORA_LAZY_FUNCTIONS: "1" });

            const eager = recordingSpawner();

            await runBuildCommand({ cwd: workdir, logger: silentLogger(), spawner: eager.spawner });

            expect(frameworkCalls(eager.calls)[0]?.env).not.toHaveProperty("LUNORA_LAZY_FUNCTIONS");
        });

        it("tells the client build the target this run resolved and a metafile path only this run names", async () => {
            expect.assertions(2);

            writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWith({ main: "virtual:lunora/worker" }), "utf8");
            writeFileSync(join(workdir, "vite.config.ts"), "export default {};\n", "utf8");

            const { calls, spawner } = recordingSpawner();

            await runBuildCommand({ cwd: workdir, logger: silentLogger(), spawner });

            expect(frameworkCalls(calls)[0]?.env).toMatchObject({ LUNORA_BUILD_TARGET: "cloudflare" });
            expect(frameworkCalls(calls)[0]?.env?.LUNORA_BUNDLE_META_PATH).toMatch(/vite-bundle-meta-[0-9a-f-]{36}\.json$/u);
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

            expect(refused.error).toContain(`this run targets "celld", but the project's target is "cloudflare"`);

            const accepted = recordingSpawner();
            const result = await runBuildCommand({ cwd: workdir, logger: silentLogger(), spawner: accepted.spawner, target: "cloudflare" });

            expect(result.code).toBe(0);
            expect(frameworkCalls(accepted.calls)).toHaveLength(1);
        });
    });

    describe("runClientBuild", () => {
        it("tells a build script the target the run asked for, even when the project default differs", async () => {
            expect.assertions(1);

            writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWith({ assets: { directory: "./dist" }, main: "src/server.ts" }), "utf8");
            writeFileSync(
                join(workdir, "package.json"),
                JSON.stringify({ dependencies: { "@lunora/d1": "*", "@lunora/storage": "*" }, name: "app", scripts: { build: "astro build" } }),
                "utf8",
            );

            const { calls, spawner } = recordingSpawner();

            await runClientBuild({
                cwd: workdir,
                lazyFunctions: false,
                logger: silentLogger(),
                outputJson: false,
                spawner,
                target: "celld",
            });

            expect(frameworkCalls(calls)[0]?.env?.LUNORA_BUILD_TARGET).toBe("celld");
        });

        it("returns a project target that cannot resolve as the build's failure, rather than throwing", async () => {
            expect.assertions(2);

            writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWith({ assets: { directory: "./dist" }, main: "src/server.ts" }), "utf8");
            writeFileSync(
                join(workdir, "package.json"),
                JSON.stringify({ dependencies: { "@lunora/d1": "*", "@lunora/storage": "*" }, name: "app", scripts: { build: "astro build" } }),
                "utf8",
            );
            writeFileSync(join(workdir, "lunora.config.ts"), `export default { target: "no-such-target" };\n`, "utf8");

            const { calls, spawner } = recordingSpawner();
            const failure = await runClientBuild({
                cwd: workdir,
                lazyFunctions: false,
                logger: silentLogger(),
                outputJson: false,
                spawner,
            });

            expect(failure).toEqual(expect.any(String));
            expect(frameworkCalls(calls)).toHaveLength(0);
        });
    });

    describe("lunora build — bundle metafile", () => {
        it("copies the Vite server bundle's metafile into the out-dir as bundle-meta.json", async () => {
            expect.assertions(2);

            writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWith({ main: "virtual:lunora/worker" }), "utf8");
            writeFileSync(join(workdir, "vite.config.ts"), "export default {};\n", "utf8");

            const meta = JSON.stringify({ inputs: {}, outputs: { "index.js": { bytes: 9, imports: [], inputs: {} } } });
            const { spawner } = recordingSpawner({ viteMeta: meta });
            const result = await runBuildCommand({ cwd: workdir, logger: silentLogger(), outDir: "out", spawner });

            expect(result.code).toBe(0);
            expect(readFileSync(join(workdir, "out", "bundle-meta.json"), "utf8")).toBe(meta);
        });

        it("keeps wrangler's own metafile when wrangler bundled a non-Vite worker, instead of the client build's", async () => {
            expect.assertions(2);

            writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWith({ assets: { directory: "./dist" }, main: "src/worker.ts" }), "utf8");
            writeFileSync(join(workdir, "vite.config.ts"), "export default {};\n", "utf8");

            const wranglerMeta = JSON.stringify({ inputs: {}, outputs: { "worker.js": { bytes: 3, imports: [], inputs: {} } } });
            const { calls, spawner } = recordingSpawner({ viteMeta: JSON.stringify({ outputs: {} }), wranglerMeta });

            await runBuildCommand({ cwd: workdir, logger: silentLogger(), outDir: "out", spawner });

            expect(frameworkCalls(calls)).toHaveLength(1);
            expect(readFileSync(join(workdir, "out", "bundle-meta.json"), "utf8")).toBe(wranglerMeta);
        });

        it("replaces a bundle-meta.json an earlier build wrote, so a Vite-built worker reports this run's graph", async () => {
            expect.assertions(1);

            writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWith({ main: "virtual:lunora/worker" }), "utf8");
            writeFileSync(join(workdir, "vite.config.ts"), "export default {};\n", "utf8");
            mkdirSync(join(workdir, "out"), { recursive: true });
            writeFileSync(join(workdir, "out", "bundle-meta.json"), '{"stale":true}', "utf8");

            const meta = JSON.stringify({ inputs: {}, outputs: { "index.js": { bytes: 9, imports: [], inputs: {} } } });
            const { spawner } = recordingSpawner({ viteMeta: meta });

            await runBuildCommand({ cwd: workdir, logger: silentLogger(), outDir: "out", spawner });

            expect(readFileSync(join(workdir, "out", "bundle-meta.json"), "utf8")).toBe(meta);
        });

        it("does not report a metafile an earlier client build left behind", async () => {
            expect.assertions(1);

            writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWith({ main: "src/server.ts" }), "utf8");
            mkdirSync(join(workdir, ".lunora"), { recursive: true });
            // The pid-named file an older CLI wrote; no build reads it any more.
            writeFileSync(join(workdir, ".lunora", `vite-bundle-meta-${String(process.pid)}.json`), "{}", "utf8");

            const { spawner } = recordingSpawner();

            await runBuildCommand({ cwd: workdir, logger: silentLogger(), outDir: "out", spawner });

            expect(existsSync(join(workdir, "out", "bundle-meta.json"))).toBe(false);
        });

        it("copies the metafile a plain vite build left at the default path when a prebuilt worker skips the client build", async () => {
            expect.assertions(3);

            writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWith({ main: "virtual:lunora/worker" }), "utf8");
            writeFileSync(join(workdir, "vite.config.ts"), "export default {};\n", "utf8");
            mkdirSync(join(workdir, ".lunora"), { recursive: true });
            writeFileSync(join(workdir, DEFAULT_BUNDLE_META_PATH), '{"plain":true}', "utf8");

            const { calls, spawner } = recordingSpawner();
            const result = await runBuildCommand({ cwd: workdir, frameworkBuild: false, logger: silentLogger(), outDir: "out", spawner });

            expect(result.code).toBe(0);
            expect(readFileSync(join(workdir, "out", "bundle-meta.json"), "utf8")).toBe('{"plain":true}');
            expect(frameworkCalls(calls)).toHaveLength(0);
        });

        it("clears a plain vite build's metafile before the CLI's own client build, so a later prebuilt run cannot copy it", async () => {
            expect.assertions(1);

            writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWith({ main: "virtual:lunora/worker" }), "utf8");
            writeFileSync(join(workdir, "vite.config.ts"), "export default {};\n", "utf8");
            mkdirSync(join(workdir, ".lunora"), { recursive: true });
            writeFileSync(join(workdir, DEFAULT_BUNDLE_META_PATH), '{"plain":true}', "utf8");

            const { spawner } = recordingSpawner();

            await runBuildCommand({ cwd: workdir, logger: silentLogger(), outDir: "out", spawner });

            expect(existsSync(join(workdir, DEFAULT_BUNDLE_META_PATH))).toBe(false);
        });

        it("keeps the previous bundle-meta.json when the client build fails, so the out-dir keeps one metafile for its bundle", async () => {
            expect.assertions(2);

            writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWith({ main: "virtual:lunora/worker" }), "utf8");
            writeFileSync(join(workdir, "vite.config.ts"), "export default {};\n", "utf8");
            mkdirSync(join(workdir, "out"), { recursive: true });
            writeFileSync(join(workdir, "out", "bundle-meta.json"), '{"previous":true}', "utf8");

            const { spawner } = recordingSpawner({ frameworkExit: 1 });
            const result = await runBuildCommand({ cwd: workdir, logger: silentLogger(), outDir: "out", spawner });

            expect(result.code).not.toBe(0);
            expect(readFileSync(join(workdir, "out", "bundle-meta.json"), "utf8")).toBe('{"previous":true}');
        });

        it("keeps the previous bundle-meta.json when a spawn throws during the dry run", async () => {
            expect.assertions(2);

            writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWith({ main: "virtual:lunora/worker" }), "utf8");
            writeFileSync(join(workdir, "vite.config.ts"), "export default {};\n", "utf8");
            mkdirSync(join(workdir, "out"), { recursive: true });
            writeFileSync(join(workdir, "out", "bundle-meta.json"), '{"previous":true}', "utf8");

            const spawner: Spawner = async (descriptor) => {
                if (descriptor.args.includes("--dry-run")) {
                    throw new Error("spawn failed");
                }

                return { code: 0, descriptor, stderr: "", stdout: "" };
            };

            await expect(runBuildCommand({ cwd: workdir, logger: silentLogger(), outDir: "out", spawner })).rejects.toThrow("spawn failed");

            expect(readFileSync(join(workdir, "out", "bundle-meta.json"), "utf8")).toBe('{"previous":true}');
        });

        it("does not fail on a dangling symlink in the out-dir", async () => {
            expect.assertions(2);

            writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWith({ main: "virtual:lunora/worker" }), "utf8");
            writeFileSync(join(workdir, "vite.config.ts"), "export default {};\n", "utf8");
            mkdirSync(join(workdir, "out"), { recursive: true });
            symlinkSync(join(workdir, "nowhere"), join(workdir, "out", "dangling"));

            const meta = JSON.stringify({ inputs: {}, outputs: { "index.js": { bytes: 9, imports: [], inputs: {} } } });
            const { spawner } = recordingSpawner({ viteMeta: meta });
            const result = await runBuildCommand({ cwd: workdir, logger: silentLogger(), outDir: "out", spawner });

            expect(result.code).toBe(0);
            expect(readFileSync(join(workdir, "out", "bundle-meta.json"), "utf8")).toBe(meta);
        });

        it("does not restore the previous metafile over a bundle a failed run rewrote in the out-dir", async () => {
            expect.assertions(2);

            writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWith({ main: "virtual:lunora/worker" }), "utf8");
            writeFileSync(join(workdir, "vite.config.ts"), "export default {};\n", "utf8");
            mkdirSync(join(workdir, "out"), { recursive: true });
            writeFileSync(join(workdir, "out", "bundle-meta.json"), '{"previous":true}', "utf8");

            const { spawner: recorded } = recordingSpawner({ viteMeta: JSON.stringify({ outputs: {} }), wranglerExit: 1 });
            const spawner: Spawner = async (descriptor) => {
                if (descriptor.args.includes("--dry-run")) {
                    writeFileSync(join(workdir, "out", "worker.js"), "export default {};\n", "utf8");
                }

                return recorded(descriptor);
            };
            const result = await runBuildCommand({ cwd: workdir, logger: silentLogger(), outDir: "out", spawner });

            expect(result.code).not.toBe(0);
            expect(existsSync(join(workdir, "out", "bundle-meta.json"))).toBe(false);
        });

        it("restores the previous metafile when a Vite-built run fails before wrangler writes the out-dir", async () => {
            expect.assertions(2);

            writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWith({ main: "virtual:lunora/worker" }), "utf8");
            writeFileSync(join(workdir, "vite.config.ts"), "export default {};\n", "utf8");
            mkdirSync(join(workdir, "out"), { recursive: true });
            writeFileSync(join(workdir, "out", "bundle-meta.json"), '{"previous":true}', "utf8");

            const { spawner } = recordingSpawner({ viteMeta: JSON.stringify({ outputs: {} }), wranglerExit: 1 });
            const result = await runBuildCommand({ cwd: workdir, logger: silentLogger(), outDir: "out", spawner });

            expect(result.code).not.toBe(0);
            expect(readFileSync(join(workdir, "out", "bundle-meta.json"), "utf8")).toBe('{"previous":true}');
        });

        it("keeps the metafile wrangler wrote when the dry run fails after writing it", async () => {
            expect.assertions(2);

            writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWith({ assets: { directory: "./dist" }, main: "src/worker.ts" }), "utf8");
            mkdirSync(join(workdir, "out"), { recursive: true });
            writeFileSync(join(workdir, "out", "bundle-meta.json"), '{"previous":true}', "utf8");

            const wranglerMeta = '{"fresh":true}';
            const { spawner } = recordingSpawner({ wranglerExit: 1, wranglerMeta });
            const result = await runBuildCommand({ cwd: workdir, logger: silentLogger(), outDir: "out", spawner });

            expect(result.code).not.toBe(0);
            expect(readFileSync(join(workdir, "out", "bundle-meta.json"), "utf8")).toBe(wranglerMeta);
        });
    });

    it("names the per-run metafile by an absolute path, so a relative project directory still reaches the Vite child", () => {
        expect.assertions(1);

        expect(isAbsolute(viteBundleMetaPath("relative/project"))).toBe(true);
    });

    it("keeps each of two overlapping builds in one project, so neither loses its metafile to the other", async () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWith({ main: "virtual:lunora/worker" }), "utf8");
        writeFileSync(join(workdir, "vite.config.ts"), "export default {};\n", "utf8");

        // Each build's Vite step writes its file, then waits for the other build to write its own. The second write lands on a
        // shared path before either build copies, so only per-run names keep both metafiles.
        let arrived = 0;
        let releaseBoth: () => void = () => {};
        const bothWritten = new Promise<void>((resolve) => {
            releaseBoth = resolve;
        });
        const spawner: Spawner = async (descriptor) => {
            const isFramework = !descriptor.args.includes("--dry-run") && descriptor.args.includes("build");

            if (isFramework) {
                arrived += 1;
                const run = arrived;
                const metaPath = descriptor.env?.LUNORA_BUNDLE_META_PATH ?? join(workdir, ".lunora", "missing.json");

                mkdirSync(dirname(metaPath), { recursive: true });
                writeFileSync(metaPath, JSON.stringify({ run }), "utf8");

                if (arrived === 2) {
                    releaseBoth();
                }
                await bothWritten;
            }

            return { code: 0, descriptor, stderr: "", stdout: "" };
        };

        const [first, second] = await Promise.all([
            runBuildCommand({ cwd: workdir, logger: silentLogger(), outDir: "out-a", spawner }),
            runBuildCommand({ cwd: workdir, logger: silentLogger(), outDir: "out-b", spawner }),
        ]);

        expect([first.code, second.code]).toStrictEqual([0, 0]);
        expect(
            [join(workdir, "out-a", "bundle-meta.json"), join(workdir, "out-b", "bundle-meta.json")]
                .map((path) => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { run: number }).run : undefined))
                .toSorted((a = 0, b = 0) => a - b),
        ).toStrictEqual([1, 2]);
    });

    describe("frameworkBuildFor", () => {
        it("returns undefined when there is no vite or rsbuild config", () => {
            expect.assertions(1);

            writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWith({ main: "virtual:lunora/worker" }), "utf8");

            expect(frameworkBuildFor(workdir)).toBeUndefined();
        });

        it("prefers rsbuild when both configs exist for a worker that is not Vite-composed", () => {
            expect.assertions(1);

            writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWith({ assets: { directory: "./dist" }, main: "src/server.ts" }), "utf8");
            writeFileSync(join(workdir, "vite.config.ts"), "export default {};\n", "utf8");
            writeFileSync(join(workdir, "rsbuild.config.mjs"), "export default {};\n", "utf8");

            expect(frameworkBuildFor(workdir)).toBe("rsbuild");
        });

        it("reads the assets directory of the --env block, so a staging-only client build still runs", () => {
            expect.assertions(2);

            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                wranglerWith({ env: { staging: { assets: { directory: "./dist" } } }, main: "src/server.ts" }),
                "utf8",
            );
            writeFileSync(join(workdir, "vite.config.ts"), "export default {};\n", "utf8");

            expect(frameworkBuildFor(workdir)).toBeUndefined();
            expect(frameworkBuildFor(workdir, "staging")).toBe("vite");
        });

        it("does not start a client build from inside one, so a build script that runs lunora cannot recurse", () => {
            expect.assertions(1);

            writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWith({ assets: { directory: "./dist" }, main: "src/server.ts" }), "utf8");
            writeFileSync(join(workdir, "package.json"), JSON.stringify({ name: "app", scripts: { build: "lunora build" } }), "utf8");

            process.env.LUNORA_CLIENT_BUILD = "1";

            try {
                expect(frameworkBuildFor(workdir)).toBeUndefined();
            } finally {
                Reflect.deleteProperty(process.env, "LUNORA_CLIENT_BUILD");
            }
        });

        it("builds a Vite-composed worker with vite even when an rsbuild config also exists", () => {
            expect.assertions(1);

            writeFileSync(join(workdir, "wrangler.jsonc"), wranglerWith({ main: "virtual:lunora/worker" }), "utf8");
            writeFileSync(join(workdir, "vite.config.ts"), "export default {};\n", "utf8");
            writeFileSync(join(workdir, "rsbuild.config.mjs"), "export default {};\n", "utf8");

            expect(frameworkBuildFor(workdir)).toBe("vite");
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
