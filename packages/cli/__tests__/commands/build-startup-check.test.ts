import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runBuildCommand } from "../../src/commands/build/handler";
import { STARTUP_WARN_MS } from "../../src/commands/build/startup-check";
import type { Logger } from "../../src/util/logger";
import type { SpawnDescriptor, Spawner } from "../../src/util/spawn";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "..", "..", "..", "codegen", "__tests__", "fixtures", "simple");

const WRANGLER = `{
    "name": "lunora-app",
    "main": "src/index.ts",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["nodejs_compat"],
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
    "d1_databases": [{ "binding": "DB", "database_name": "x", "database_id": "real-db-id-abc123" }]
}
`;

let workdir: string;

const recordingLogger = (): { debugs: string[]; infos: string[]; logger: Logger; warnings: string[] } => {
    const debugs: string[] = [];
    const infos: string[] = [];
    const warnings: string[] = [];

    return {
        debugs,
        infos,
        logger: {
            debug: (message) => debugs.push(message),
            error: () => {},
            info: (message) => infos.push(message),
            success: () => {},
            warn: (message) => warnings.push(message),
        },
        warnings,
    };
};

const flagValue = (descriptor: SpawnDescriptor, flag: string): string | undefined => {
    const index = descriptor.args.indexOf(flag);

    return index === -1 ? undefined : descriptor.args[index + 1];
};

const isStartupProfile = (descriptor: SpawnDescriptor): boolean => descriptor.args.join(" ").includes("check startup");

/**
 * Stands in for wrangler: `deploy --outfile` writes the upload form (unless `writeForm` is off), and
 * each `check startup` reports the next of `actives` the way wrangler 4 prints it.
 */
const fakeWrangler = (
    actives: ReadonlyArray<number>,
    { checkThrows = false, writeForm = true }: { checkThrows?: boolean; writeForm?: boolean } = {},
): { calls: SpawnDescriptor[]; spawner: Spawner } => {
    const calls: SpawnDescriptor[] = [];
    let profiled = 0;

    const spawner: Spawner = async (descriptor) => {
        calls.push(descriptor);

        if (isStartupProfile(descriptor)) {
            if (checkThrows) {
                throw new Error("spawn wrangler ENOENT");
            }

            const active = actives[profiled] ?? 0;

            profiled += 1;

            return { code: 0, stdout: `Local startup profile:\n  Active: ${active.toFixed(1)} ms (including 3.0 ms garbage collection)\n  Idle: 1.0 ms\n` };
        }

        const outFile = flagValue(descriptor, "--outfile");

        if (writeForm && outFile !== undefined) {
            mkdirSync(dirname(join(workdir, outFile)), { recursive: true });
            writeFileSync(join(workdir, outFile), "form", "utf8");
        }

        return { code: 0 };
    };

    return { calls, spawner };
};

describe("lunora build startup check", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-build-startup-"));
        cpSync(join(fixtureRoot, "lunora"), join(workdir, "lunora"), { recursive: true });
        writeFileSync(join(workdir, "wrangler.jsonc"), WRANGLER, "utf8");
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("warns with the median, the threshold, the docs page and the lazy fix when an eager build nears the limit", async () => {
        expect.assertions(8);

        const { calls, spawner } = fakeWrangler([900, 450, 300]);
        const { logger, warnings } = recordingLogger();

        const result = await runBuildCommand({ cwd: workdir, logger, outDir: "dist-worker", spawner });

        // Advisory: the build still succeeds.
        expect(result.code).toBe(0);

        const deploy = calls.find((descriptor) => descriptor.args.includes("deploy"));
        const form = deploy === undefined ? undefined : flagValue(deploy, "--outfile");
        const profiles = calls.filter((descriptor) => isStartupProfile(descriptor));

        // The profiles read the form the dry run wrote, so wrangler does not rebuild against another config.
        expect(form).toBeDefined();
        expect(profiles.map((descriptor) => flagValue(descriptor, "--worker"))).toStrictEqual([form, form, form]);

        const warning = warnings.find((message) => message.startsWith("startup:")) ?? "";

        expect(warning).toContain("450 ms local CPU");
        expect(warning).toContain(`${String(STARTUP_WARN_MS)} ms warning line`);
        expect(warning).toContain("https://lunora.sh/docs/startup-cpu-limit");
        expect(warning).toContain("LUNORA_LAZY_FUNCTIONS=1");
        // The form is scratch: removed after profiling, and never left in the measured out-dir.
        expect(readdirSync(join(workdir, ".lunora", "startup-check"))).toStrictEqual([]);
    });

    it("drops the lazy hint when the generated registry is already lazy", async () => {
        expect.assertions(2);

        const { spawner } = fakeWrangler([500, 500, 500]);
        const { logger, warnings } = recordingLogger();

        await runBuildCommand({ cwd: workdir, lazyFunctions: true, logger, smokeLoad: false, spawner });

        const warning = warnings.find((message) => message.startsWith("startup:")) ?? "";

        expect(warning).toContain("500 ms local CPU");
        expect(warning).not.toContain("--lazy-functions");
    });

    it("reports the median without warning below the threshold", async () => {
        expect.assertions(2);

        const { spawner } = fakeWrangler([40, 900, 35]);
        const { infos, logger, warnings } = recordingLogger();

        await runBuildCommand({ cwd: workdir, logger, spawner });

        expect(infos).toContain("startup: 40 ms local CPU (median of 3 `wrangler check startup` runs)");
        expect(warnings.filter((message) => message.startsWith("startup:"))).toStrictEqual([]);
    });

    it("--no-startup-check asks wrangler for no form and profiles nothing", async () => {
        expect.assertions(2);

        const { calls, spawner } = fakeWrangler([900, 900, 900]);
        const { logger } = recordingLogger();

        await runBuildCommand({ cwd: workdir, logger, spawner, startupCheck: false });

        expect(calls.some((descriptor) => descriptor.args.includes("--outfile"))).toBe(false);
        expect(calls.some((descriptor) => isStartupProfile(descriptor))).toBe(false);
    });

    it("skips quietly when no upload form was written", async () => {
        expect.assertions(3);

        const { calls, spawner } = fakeWrangler([900, 900, 900], { writeForm: false });
        const { debugs, logger } = recordingLogger();

        const result = await runBuildCommand({ cwd: workdir, logger, spawner });

        expect(result.code).toBe(0);
        expect(calls.some((descriptor) => isStartupProfile(descriptor))).toBe(false);
        expect(debugs.some((message) => message.startsWith("startup check skipped: no upload form"))).toBe(true);
    });

    it("skips quietly when wrangler cannot be run", async () => {
        expect.assertions(4);

        const { spawner } = fakeWrangler([], { checkThrows: true });
        const { debugs, logger, warnings } = recordingLogger();

        const result = await runBuildCommand({ cwd: workdir, logger, spawner });

        expect(result.code).toBe(0);
        expect(warnings.filter((message) => message.startsWith("startup:"))).toStrictEqual([]);
        expect(debugs.some((message) => message.includes("could not run"))).toBe(true);
        expect(existsSync(join(workdir, ".lunora", "startup-check")) && readdirSync(join(workdir, ".lunora", "startup-check")).length > 0).toBe(false);
    });
});
