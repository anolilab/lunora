import { existsSync, rmSync } from "node:fs";

import { promptYesNo } from "@lunora/config";
import { join } from "@visulima/path";

import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { Logger } from "../../util/logger";
import type { ResetOptions } from "./index";

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

const runResetCommand = async (options: ResetCommandOptions): Promise<ResetCommandResult> => {
    const cwd = options.cwd ?? process.cwd();
    const targets: string[] = [join(cwd, ".wrangler", "state")];

    if (options.all) {
        targets.push(join(cwd, ".lunora-cache"));
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

/** `lunora reset` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<ResetOptions> = defineHandler<ResetOptions>(({ cwd, logger, options }) =>
    runResetCommand({ all: options.all === true, cwd, logger, yes: options.yes === true }),
);

export { execute };
export type { ResetCommandOptions, ResetCommandResult };
export { runResetCommand };
