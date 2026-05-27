import { existsSync, rmSync } from "node:fs";

import { join } from "@visulima/path";

import type { Logger } from "../util/logger.js";

export interface ResetCommandOptions {
    all?: boolean;
    cwd?: string;
    logger: Logger;
}

export interface ResetCommandResult {
    removed: ReadonlyArray<string>;
}

export const runResetCommand = (options: ResetCommandOptions): ResetCommandResult => {
    const cwd = options.cwd ?? process.cwd();
    const targets: string[] = [join(cwd, ".wrangler", "state")];

    if (options.all) {
        targets.push(join(cwd, ".cirrus-cache"));
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

    return { removed };
};
