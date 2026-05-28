import { existsSync, readFileSync } from "node:fs";

import { dirname, join } from "@visulima/path";

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

const FALLBACK: PackageManager = "pnpm";

/**
 * Walk up from `startDirectory` and read the nearest `package.json`'s
 * `packageManager` field. Returns the detected manager, or `"pnpm"` as a
 * fallback if nothing is declared.
 *
 * Recognises the corepack-canonical strings (`pnpm@8.0.0`, `npm@9.0.0`,
 * `yarn@4.0.0`, `bun@1.0.0`) and ignores anything else.
 */
export const detectPackageManager = (startDirectory: string): PackageManager => {
    let directory = startDirectory;

    while (directory && directory !== dirname(directory)) {
        const candidate = join(directory, "package.json");

        if (existsSync(candidate)) {
            try {
                const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { packageManager?: string };
                const declared = parsed.packageManager;

                if (typeof declared === "string") {
                    if (declared.startsWith("pnpm@")) {
                        return "pnpm";
                    }

                    if (declared.startsWith("yarn@")) {
                        return "yarn";
                    }

                    if (declared.startsWith("npm@")) {
                        return "npm";
                    }

                    if (declared.startsWith("bun@")) {
                        return "bun";
                    }
                }
            } catch {
                /* unreadable / unparseable — keep walking up */
            }
        }

        directory = dirname(directory);
    }

    return FALLBACK;
};

/** Map a package manager to the argv pair that runs an installed CLI. */
export const execArgsFor = (manager: PackageManager, command: string, args: ReadonlyArray<string>): { args: string[]; command: string } => {
    if (manager === "yarn") {
        return { command: "yarn", args: [command, ...args] };
    }

    if (manager === "bun") {
        return { command: "bun", args: ["x", command, ...args] };
    }

    if (manager === "npm") {
        return { command: "npx", args: ["--", command, ...args] };
    }

    // pnpm default
    return { command: "pnpm", args: ["exec", command, ...args] };
};
