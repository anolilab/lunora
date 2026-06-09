import { existsSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";

import { join } from "@visulima/path";

import type { Logger } from "../util/logger";

interface ResetCommandOptions {
    all?: boolean;
    /** Inject a custom confirmer (tests, non-TTY callers). Returns `true` on confirmation. */
    confirm?: (prompt: string) => Promise<boolean>;
    cwd?: string;
    logger: Logger;
    /** Skip confirmation. Required when stdin is not a TTY. */
    yes?: boolean;
}

interface ResetCommandResult {
    code: number;
    removed: ReadonlyArray<string>;
}

const promptYesNo = async (prompt: string): Promise<boolean> => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    try {
        const answer = await new Promise<string>((resolve) => {
            rl.question(prompt, (input) => {
                resolve(input);
            });
        });

        const normalised = answer.trim().toLowerCase();

        return normalised === "y" || normalised === "yes";
    } finally {
        rl.close();
    }
};

const runResetCommand = async (options: ResetCommandOptions): Promise<ResetCommandResult> => {
    const cwd = options.cwd ?? process.cwd();
    const targets: string[] = [join(cwd, ".wrangler", "state")];

    if (options.all) {
        targets.push(join(cwd, ".cirrus-cache"));
    }

    if (!options.yes) {
        const isTty = process.stdin.isTTY;

        if (!isTty && options.confirm === undefined) {
            options.logger.error("reset: stdin is not a TTY — re-run with --yes to confirm deleting .wrangler/state");

            return { code: 1, removed: [] };
        }

        const confirmer = options.confirm ?? promptYesNo;
        const confirmed = await confirmer("This will delete .wrangler/state. Continue? [y/N] ");

        if (!confirmed) {
            options.logger.info("reset: aborted");

            return { code: 1, removed: [] };
        }
    }

    const removed: string[] = [];

    for (const target of targets) {
        if (existsSync(target)) {
            rmSync(target, { force: true, recursive: true });
            removed.push(target);
            options.logger.success(`removed ${target}`);
        } else {
            options.logger.info(`skipped (not present): ${target}`);
        }
    }

    return { code: 0, removed };
};

export type { ResetCommandOptions, ResetCommandResult };
export { runResetCommand };
