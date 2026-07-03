import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { dirname, join } from "@visulima/path";

type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

const FALLBACK: PackageManager = "pnpm";

const KNOWN_MANAGERS: ReadonlyArray<PackageManager> = ["pnpm", "yarn", "npm", "bun"];

/**
 * Preference order for the post-scaffold install offer's **default**: the first
 * installed manager in this list is pre-selected. `pnpm`/`bun` lead because
 * they're the fastest + Lunora's recommended runtimes; `npm` is the universal
 * fallback. Every installed manager is still offered — this only sets the
 * highlighted default.
 */
const INSTALL_PREFERENCE: ReadonlyArray<PackageManager> = ["pnpm", "bun", "yarn", "npm"];

/** True when `manager` is on PATH — probed by running `&lt;manager> --version`. Injectable for tests. */
type PackageManagerProbe = (manager: PackageManager) => boolean;

const isManagerInstalled: PackageManagerProbe = (manager) => {
    try {
        return spawnSync(manager, ["--version"], { stdio: "ignore", timeout: 5000 }).status === 0;
    } catch {
        return false;
    }
};

/**
 * The package managers actually installed on this machine, in preference order
 * ({@link INSTALL_PREFERENCE} — pnpm > bun > yarn > npm). The first entry is the
 * recommended default for the install prompt; the whole list is what the user
 * picks from. Empty when none are found.
 */
const detectInstalledManagers = (probe: PackageManagerProbe = isManagerInstalled): PackageManager[] => INSTALL_PREFERENCE.filter((manager) => probe(manager));

/** The argv that installs a project's dependencies with `manager` (`&lt;manager> install`). */
const installArgsFor = (manager: PackageManager): { args: string[]; command: string } => {
    return { args: ["install"], command: manager };
};

/** Match a corepack-canonical `packageManager` string (`pnpm@8.0.0`) to a manager. */
const parseDeclaredManager = (declared: unknown): PackageManager | undefined => {
    if (typeof declared !== "string") {
        return undefined;
    }

    return KNOWN_MANAGERS.find((manager) => declared.startsWith(`${manager}@`));
};

/** Read the nearest `package.json`'s `packageManager` field at `directory`. */
const readDeclaredManager = (directory: string): PackageManager | undefined => {
    const candidate = join(directory, "package.json");

    if (!existsSync(candidate)) {
        return undefined;
    }

    try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { packageManager?: string };

        return parseDeclaredManager(parsed.packageManager);
    } catch {
        // unreadable / unparseable — keep walking up
        return undefined;
    }
};

/**
 * Walk up from `startDirectory` and read the nearest `package.json`'s
 * `packageManager` field. Returns the detected manager, or `"pnpm"` as a
 * fallback if nothing is declared.
 *
 * Recognises the corepack-canonical strings (`pnpm@8.0.0`, `npm@9.0.0`,
 * `yarn@4.0.0`, `bun@1.0.0`) and ignores anything else.
 */
const detectPackageManager = (startDirectory: string): PackageManager => {
    let directory = startDirectory;

    while (directory && directory !== dirname(directory)) {
        const declared = readDeclaredManager(directory);

        if (declared !== undefined) {
            return declared;
        }

        directory = dirname(directory);
    }

    return FALLBACK;
};

/** Map a package manager to the argv pair that runs an installed CLI. */
const execArgsFor = (manager: PackageManager, command: string, args: ReadonlyArray<string>): { args: string[]; command: string } => {
    if (manager === "yarn") {
        return { args: [command, ...args], command: "yarn" };
    }

    if (manager === "bun") {
        return { args: ["x", command, ...args], command: "bun" };
    }

    if (manager === "npm") {
        return { args: ["--", command, ...args], command: "npx" };
    }

    // pnpm default
    return { args: ["exec", command, ...args], command: "pnpm" };
};

/** The shell command that runs a project script with `manager` (`pnpm dev`, `npm run dev`, …). */
const runScriptCommand = (manager: PackageManager, script: string): string => {
    if (manager === "npm") {
        return `npm run ${script}`;
    }

    if (manager === "bun") {
        return `bun run ${script}`;
    }

    // pnpm / yarn run scripts by bare name.
    return `${manager} ${script}`;
};

export type { PackageManager, PackageManagerProbe };
export { detectInstalledManagers, detectPackageManager, execArgsFor, installArgsFor, runScriptCommand };
