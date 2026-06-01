import { existsSync, readFileSync } from "node:fs";

import { dirname, join } from "@visulima/path";

type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

const FALLBACK: PackageManager = "pnpm";

const KNOWN_MANAGERS: ReadonlyArray<PackageManager> = ["pnpm", "yarn", "npm", "bun"];

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

export type { PackageManager };
export { detectPackageManager, execArgsFor };
