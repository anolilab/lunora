import { spawnSync } from "node:child_process";

import { LunoraError } from "@lunora/errors";
import { findPackageManagerSync, identifyInitiatingPackageManager } from "@visulima/package/package-manager";

type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

/**
 * Preference order for the post-scaffold install offer's **default** and for the
 * last-resort "what's actually installed on this machine" detection: the first
 * installed manager in this list is chosen. `pnpm`/`bun` lead because they're
 * the fastest + Lunora's recommended runtimes; `npm` is the universal fallback.
 * Every installed manager is still offered — this only sets the highlighted
 * default.
 */
const INSTALL_PREFERENCE: ReadonlyArray<PackageManager> = ["pnpm", "bun", "yarn", "npm"];

/** The full set of `PackageManager` names — used to validate an arbitrary agent-name string before it's trusted. */
const KNOWN_PACKAGE_MANAGERS: ReadonlySet<string> = new Set(INSTALL_PREFERENCE);

/**
 * Narrow an arbitrary manager-name string (e.g. `identifyInitiatingPackageManager()`'s
 * `name`, which `@visulima/package` types as `PackageManager | "cnpm" | (string & {})` —
 * effectively any string) to the known `PackageManager` union.
 */
const isKnownPackageManager = (name: string): name is PackageManager => KNOWN_PACKAGE_MANAGERS.has(name);

/** True when `manager` is on PATH — probed by running `<manager> --version`. Injectable for tests. */
type PackageManagerProbe = (manager: PackageManager) => boolean;

const isManagerInstalled: PackageManagerProbe = (manager) => {
    try {
        // `shell` on Windows is not optional: the package managers are `.cmd`
        // shims that `spawnSync` cannot start directly since Node's
        // CVE-2024-27980 hardening, so without it every probe threw and the catch
        // reported `false` — `detectInstalledManagers()` was always `[]`, which
        // silently skipped `init`'s install prompt and made `detectPackageManager`
        // throw for a fresh directory. The same fix, for the same reason, is
        // spelled out in `./post-codegen-hook` and the CLI's `util/spawn`.
        //
        // `manager` is one of four literals from INSTALL_PREFERENCE, never
        // user-supplied, so the shell carries nothing to quote.
        return spawnSync(manager, ["--version"], { shell: process.platform === "win32", stdio: "ignore", timeout: 5000 }).status === 0;
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

/** The argv that installs a project's dependencies with `manager` (`<manager> install`). */
const installArgsFor = (manager: PackageManager): { args: string[]; command: string } => {
    return { args: ["install"], command: manager };
};

/**
 * The argv that adds `packages` as new dependencies with `manager` — the
 * counterpart to {@link installArgsFor}, which reinstalls what package.json
 * already declares rather than adding something new to it.
 *
 * npm's dev flag is `--save-dev` (its own docs lead with the long form); bun's
 * is the lowercase `-d` (uppercase `-D` is not one of its recognized flags);
 * pnpm and yarn both take `-D`.
 */
const addArgsFor = (manager: PackageManager, packages: ReadonlyArray<string>, options: { dev?: boolean } = {}): { args: string[]; command: string } => {
    const dev = options.dev === true;

    if (manager === "npm") {
        return { args: ["install", ...(dev ? ["--save-dev"] : []), ...packages], command: "npm" };
    }

    if (manager === "bun") {
        return { args: ["add", ...(dev ? ["-d"] : []), ...packages], command: "bun" };
    }

    // pnpm / yarn both accept `-D`.
    return { args: ["add", ...(dev ? ["-D"] : []), ...packages], command: manager };
};

/**
 * Resolve the package manager to drive for the project rooted at (or above)
 * `startDirectory`. Every step is a real signal — Lunora never blindly assumes a
 * particular manager, and there is no hardcoded fallback:
 *
 * 1. `@visulima/package` — the nearest lock file (`pnpm-lock.yaml`, `yarn.lock`,
 * `package-lock.json`, `bun.lockb`) or the `packageManager` field of the nearest
 * `package.json`.
 * 2. The manager that launched this CLI, read from `npm_config_user_agent` (so
 * `pnpm dlx lunora …` / `npx lunora …` resolve to the right manager).
 * 3. The first package manager actually installed on this machine
 * ({@link detectInstalledManagers}).
 *
 * Throws when none of those resolve — i.e. there is no lock file / `packageManager`
 * field, the CLI wasn't launched by a known manager, and none is on `PATH`.
 * Surfacing that is better than silently guessing a manager that can't run.
 */
const detectPackageManager = (startDirectory: string): PackageManager => {
    try {
        return findPackageManagerSync(startDirectory).packageManager;
    } catch {
        // No lock file or `packageManager` field up the tree — keep detecting.
    }

    const initiating = identifyInitiatingPackageManager();

    if (initiating !== undefined) {
        // `cnpm` (npminstall) is npm-compatible for our exec/run purposes.
        const name = initiating.name === "cnpm" ? "npm" : initiating.name;

        // Validate rather than cast: an unrecognized agent string (a future or
        // unknown package manager, or a malformed `npm_config_user_agent`) must
        // not flow unvalidated into `execArgsFor`/spawn — fall through to the
        // installed-manager probe below instead of trusting it.
        if (isKnownPackageManager(name)) {
            return name;
        }
    }

    const [installed] = detectInstalledManagers();

    if (installed !== undefined) {
        return installed;
    }

    throw new LunoraError(
        "INTERNAL",
        "Could not detect a package manager: no lock file or `packageManager` field was found, and none (pnpm, bun, yarn, npm) is installed on PATH.",
    );
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

/**
 * The argv that runs a project SCRIPT with `manager` — the counterpart to
 * {@link execArgsFor}, which runs a BINARY.
 *
 * All four managers accept `<manager> run <script>`, so this is uniform. It is a
 * separate function because reaching for `execArgsFor(manager, "run", [script])`
 * silently produces something else entirely: `pnpm exec run <script>` fails with
 * `Command "run" not found`, and `npx -- run <script>` resolves the registry
 * PACKAGE named `run` and executes it.
 */
const runScriptArgsFor = (manager: PackageManager, script: string): { args: string[]; command: string } => {
    return { args: ["run", script], command: manager };
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
export { addArgsFor, detectInstalledManagers, detectPackageManager, execArgsFor, installArgsFor, runScriptArgsFor, runScriptCommand };
