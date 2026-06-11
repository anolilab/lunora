import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { Logger } from "../../util/logger";
import type { SpawnDescriptor, Spawner } from "../../util/spawn";
import { defaultSpawner } from "../../util/spawn";
import type { LogsOptions } from "./index";

/** Output formats `wrangler tail` understands. */
const LOG_FORMATS = new Set(["json", "pretty"]);

interface LogsCommandOptions {
    cwd?: string;
    /** Cloudflare environment name (forwarded as `--env`). */
    env?: string;
    /** Output format: `pretty` (default) or `json`. */
    format?: string;
    logger: Logger;
    /** Substring filter on log messages (forwarded as `--search`). */
    search?: string;
    spawner?: Spawner;
    /** Filter by invocation status: `ok`, `error`, or `canceled` (forwarded as `--status`). */
    status?: string;
    /** Explicit Worker name; defaults to the `name` in wrangler config when omitted. */
    worker?: string;
}

interface LogsCommandResult {
    code: number;
    descriptor: SpawnDescriptor | undefined;
    /** Set when the run aborted before reaching the wrangler invocation. */
    error?: string;
}

/**
 * Stream live logs from a deployed Cirrus Worker by wrapping `wrangler tail`.
 *
 * Unlike `deploy`, this neither runs codegen nor validates wrangler bindings —
 * it only forwards a tail request, and `wrangler` itself reports a clear error
 * if the Worker isn't deployed or the config can't be resolved. The one local
 * guard is `--format`, where a typo is cheap to catch before spawning.
 */
const runLogsCommand = async (options: LogsCommandOptions): Promise<LogsCommandResult> => {
    const cwd = options.cwd ?? process.cwd();

    if (options.format !== undefined && !LOG_FORMATS.has(options.format)) {
        options.logger.error(`logs: unknown --format "${options.format}" — expected pretty | json`);

        return { code: 1, descriptor: undefined, error: "invalid format" };
    }

    const args = ["exec", "wrangler", "tail"];

    if (options.worker !== undefined) {
        args.push(options.worker);
    }

    if (options.env !== undefined) {
        args.push("--env", options.env);
    }

    if (options.format !== undefined) {
        args.push("--format", options.format);
    }

    if (options.status !== undefined) {
        args.push("--status", options.status);
    }

    if (options.search !== undefined) {
        args.push("--search", options.search);
    }

    const descriptor: SpawnDescriptor = {
        args,
        command: "pnpm",
        cwd,
    };

    options.logger.info(`tailing logs via ${descriptor.command} ${descriptor.args.join(" ")}`);

    const spawner = options.spawner ?? defaultSpawner;
    const result = await spawner(descriptor);

    return {
        code: result.code,
        descriptor,
    };
};

/** `cirrus logs [worker]` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<LogsOptions> = defineHandler<LogsOptions>(({ argument, cwd, logger, options }) =>
    runLogsCommand({
        cwd,
        env: options.env,
        format: options.format,
        logger,
        search: options.search,
        status: options.status,
        worker: argument[0],
    }),
);

export { execute };
export type { LogsCommandOptions, LogsCommandResult };
export { runLogsCommand };
