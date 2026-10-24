import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { CelldCommandRunner } from "../src/celld/celld-toolchain";
import { launchOptions, probeCelldToolchain, runCommand } from "../src/celld/celld-toolchain";

/** A runner for the given tools: each present one answers with the version it reports, the others are not on PATH. */
const tools =
    (present: Record<string, string>): CelldCommandRunner =>
    async (command) =>
        command in present ? { code: 0, stdout: present[command] ?? "" } : undefined;

const ALL = { celld: "celld 0.6.1\n", esbuild: "0.25.0\n" };

const errorsOf = async (options: Parameters<typeof probeCelldToolchain>[0]): Promise<string[]> => {
    const probe = await probeCelldToolchain(options);

    return probe.errors;
};
const BUCKET = { CELLD_BUCKET: "s3://fleet" };

describe("probeCelldToolchain", () => {
    it("finds nothing wrong for a deploy with celld, esbuild and a bucket", async () => {
        expect.assertions(1);

        await expect(probeCelldToolchain({ env: BUCKET, purpose: "deploy", run: tools(ALL) })).resolves.toStrictEqual({ errors: [], warnings: [] });
    });

    it("errors when celld is not on PATH, for a dev session as for a deploy", async () => {
        expect.assertions(2);

        const dev = await probeCelldToolchain({ purpose: "dev", run: tools({ esbuild: "0.25.0" }) });

        expect(dev.errors).toStrictEqual([expect.stringMatching(/celld is not on PATH/u)]);
        await expect(probeCelldToolchain({ env: BUCKET, purpose: "deploy", run: tools({ esbuild: "0.25.0" }) })).resolves.toMatchObject({
            errors: [expect.stringMatching(/celld is not on PATH/u)],
        });
    });

    it("errors without esbuild, for a dev session as for a deploy: celld bundles the worker in both", async () => {
        expect.assertions(2);

        await expect(errorsOf({ env: BUCKET, purpose: "deploy", run: tools({ celld: "celld 0.6.1" }) })).resolves.toStrictEqual([
            expect.stringMatching(/esbuild is not on PATH/u),
        ]);
        await expect(errorsOf({ purpose: "dev", run: tools({ celld: "celld 0.6.1" }) })).resolves.toStrictEqual([
            expect.stringMatching(/esbuild is not on PATH/u),
        ]);
    });

    it("checks the esbuild CELLD_ESBUILD names instead of the one on PATH", async () => {
        expect.assertions(2);

        const run = tools({ "/opt/esbuild": "0.25.0", celld: "celld 0.6.1" });

        await expect(errorsOf({ env: { ...BUCKET, CELLD_ESBUILD: "/opt/esbuild" }, purpose: "deploy", run })).resolves.toStrictEqual([]);
        await expect(errorsOf({ env: { CELLD_ESBUILD: "/missing/esbuild" }, purpose: "dev", run })).resolves.toStrictEqual([
            expect.stringMatching(/CELLD_ESBUILD names \/missing\/esbuild, which does not exist/u),
        ]);
    });

    it("reports a tool that exists but cannot start as broken, not as missing from PATH", async () => {
        expect.assertions(1);

        const directory = mkdtempSync(join(tmpdir(), "celld-toolchain-"));

        for (const tool of ["celld", "esbuild"]) {
            writeFileSync(join(directory, tool), "#!/bin/sh\n");
            chmodSync(join(directory, tool), 0o644);
        }

        vi.stubEnv("PATH", directory);

        try {
            await expect(errorsOf({ purpose: "dev" })).resolves.toStrictEqual([
                "`celld --version` could not start (EACCES) — the celld on PATH does not run; reinstall it",
                "`esbuild --version` could not start (EACCES) — the esbuild celld bundles the worker with does not run",
            ]);
        } finally {
            vi.unstubAllEnvs();
            rmSync(directory, { force: true, recursive: true });
        }
    });

    it("errors on a live deploy with no CELLD_BUCKET, but not on a dry run", async () => {
        expect.assertions(2);

        await expect(errorsOf({ env: {}, purpose: "deploy", run: tools(ALL) })).resolves.toStrictEqual([expect.stringMatching(/CELLD_BUCKET is not set/u)]);
        await expect(errorsOf({ dryRun: true, env: {}, purpose: "deploy", run: tools(ALL) })).resolves.toStrictEqual([]);
    });

    it("errors when celld or esbuild starts but exits nonzero", async () => {
        expect.assertions(1);

        const failing: CelldCommandRunner = async () => {
            return { code: 127, stdout: "" };
        };

        await expect(errorsOf({ env: BUCKET, purpose: "deploy", run: failing })).resolves.toStrictEqual([
            expect.stringMatching(/`celld --version` exited with code 127/u),
            expect.stringMatching(/`esbuild --version` exited with code 127/u),
        ]);
    });

    it("warns, without erroring, when celld is older than the version the matrix is rated against", async () => {
        expect.assertions(2);

        const old = await probeCelldToolchain({ env: BUCKET, purpose: "deploy", run: tools({ ...ALL, celld: "celld 0.5.1" }) });

        expect(old.errors).toStrictEqual([]);
        expect(old.warnings).toStrictEqual([expect.stringMatching(/celld 0\.5\.1 is older than 0\.6\.1/u)]);
    });

    it("compares minor and patch versions, not only the major", async () => {
        expect.assertions(1);

        const result = await probeCelldToolchain({ purpose: "dev", run: tools({ celld: "celld 0.6.0", esbuild: "0.25.0" }) });

        expect(result.warnings).toStrictEqual([expect.stringMatching(/celld 0\.6\.0 is older/u)]);
    });

    it("reports a tool that never exits as hung, naming the command", async () => {
        expect.assertions(1);

        const hung: CelldCommandRunner = async (command) => (command === "celld" ? { code: 1, error: "ETIMEDOUT", stdout: "" } : { code: 0, stdout: "0.25.0" });

        await expect(errorsOf({ purpose: "dev", run: hung })).resolves.toStrictEqual([
            "`celld --version` did not exit within 10s — the celld on PATH does not run; reinstall it",
        ]);
    });
});

describe(runCommand, () => {
    it("kills a command still running at the timeout and resolves it as timed out", async () => {
        expect.assertions(1);

        const directory = mkdtempSync(join(tmpdir(), "celld-toolchain-"));
        const tool = join(directory, "hung");

        // `exec` replaces the shell, so the kill reaches the sleeper and closes its stdout.
        writeFileSync(tool, "#!/bin/sh\nexec sleep 30\n");
        chmodSync(tool, 0o755);

        try {
            await expect(runCommand(tool, ["--version"], { timeoutMs: 100 })).resolves.toStrictEqual({ code: 1, error: "ETIMEDOUT", stdout: "" });
        } finally {
            rmSync(directory, { force: true, recursive: true });
        }
    });
});

describe(launchOptions, () => {
    it("runs a Windows command through a shell, quoting one that cmd.exe would re-split", () => {
        expect.assertions(3);

        expect(launchOptions("esbuild", "win32")).toStrictEqual({ command: "esbuild", shell: true });
        expect(launchOptions(String.raw`C:\Program Files\tools\esbuild.cmd`, "win32")).toStrictEqual({
            command: String.raw`"C:\Program Files\tools\esbuild.cmd"`,
            shell: true,
        });
        expect(launchOptions("a&calc", "win32")).toStrictEqual({ command: '"a&calc"', shell: true });
    });

    it("leaves a command alone off Windows", () => {
        expect.assertions(1);

        expect(launchOptions("/opt/my tools/esbuild", "linux")).toStrictEqual({ command: "/opt/my tools/esbuild", shell: false });
    });
});
