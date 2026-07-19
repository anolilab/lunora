import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { PackageManagerProbe } from "../../src/util/detect-package-manager";
import { detectInstalledManagers, detectPackageManager, execArgsFor, runScriptCommand } from "../../src/util/detect-package-manager";

describe(detectInstalledManagers, () => {
    it("keeps INSTALL_PREFERENCE order and drops managers the probe rejects", () => {
        expect.assertions(1);

        const probe: PackageManagerProbe = (manager) => manager === "yarn" || manager === "npm";

        // Preference order is pnpm > bun > yarn > npm; only yarn/npm are "installed".
        expect(detectInstalledManagers(probe)).toStrictEqual(["yarn", "npm"]);
    });

    it("is empty when nothing is installed", () => {
        expect.assertions(1);

        expect(detectInstalledManagers(() => false)).toStrictEqual([]);
    });
});

describe(detectPackageManager, () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("falls through to the installed-manager probe instead of trusting an unrecognized initiating agent name", () => {
        expect.assertions(1);

        // A directory with no lock file / `packageManager` field anywhere up the
        // tree (outside the repo) so `findPackageManagerSync` cannot resolve —
        // forcing `detectPackageManager` past step 1 into the initiating-manager
        // check.
        const cwd = mkdtempSync(join(tmpdir(), "lunora-cli-detect-pm-"));

        try {
            // An agent name `@visulima/package` cannot map to a known
            // `PackageManager` — previously this flowed straight through via an
            // unchecked cast (`initiating.name as PackageManager`), so
            // `detectPackageManager` would return the literal, un-runnable
            // string "some-unknown-tool" instead of a real package manager.
            vi.stubEnv("npm_config_user_agent", "some-unknown-tool/1.0.0");

            // The sandbox this suite runs in always has pnpm installed (it's the
            // repo's package manager), so the installed-manager probe resolves
            // deterministically to "pnpm" — never the bogus agent name, and never
            // a throw for "nothing installed".
            expect(detectPackageManager(cwd)).toBe("pnpm");
        } finally {
            rmSync(cwd, { force: true, recursive: true });
        }
    });
});

describe(execArgsFor, () => {
    it("never runs an unrecognized manager string directly — pnpm's exec path is the only fallback shape", () => {
        expect.assertions(1);

        // `isKnownPackageManager` guards `detectPackageManager`'s return value, so
        // `execArgsFor` only ever receives one of the four known managers — this
        // pins the pnpm-default branch's shape as a regression guard for that contract.
        expect(execArgsFor("pnpm", "vitest", ["run"])).toStrictEqual({ args: ["exec", "vitest", "run"], command: "pnpm" });
    });
});

describe(runScriptCommand, () => {
    it("renders each manager's script-run form", () => {
        expect.assertions(3);

        expect(runScriptCommand("npm", "dev")).toBe("npm run dev");
        expect(runScriptCommand("bun", "dev")).toBe("bun run dev");
        expect(runScriptCommand("pnpm", "dev")).toBe("pnpm dev");
    });
});
