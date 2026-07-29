import { readLinkedProject, resolveDeployDriver } from "@lunora/config";

import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { detectPackageManager, execArgsFor } from "../../util/detect-package-manager";
import type { Logger } from "../../util/logger";
import type { SpawnDescriptor, Spawner } from "../../util/spawn";
import { defaultSpawner } from "../../util/spawn";
import { runDurableLogsCommand } from "./durable";
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
    /** Deploy target whose tail command to run. Resolved by the caller; falls back to `"target"` in `lunora.json`, then `"cloudflare"`. */
    target?: string;

    /**
     * Tail a temporary-account deployment (`wrangler tail --temporary`). For
     * unauthenticated use only — wrangler errors if credentials are present.
     */
    temporary?: boolean;
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
 * Stream live logs from a deployed Lunora Worker by wrapping `wrangler tail`.
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

    // Default the environment from the `.lunora/project.json` link when the
    // caller didn't pass `--env`, so a linked checkout tails the right env.
    const env = options.env ?? readLinkedProject(cwd)?.env;
    const driver = resolveDeployDriver(options.target);

    if (driver.toolchain === undefined) {
        options.logger.error(`logs: deploy target "${driver.id}" has no command-line toolchain`);

        return { code: 1, descriptor: undefined, error: "no toolchain" };
    }

    const tailCommand = driver.toolchain.tail({
        environment: env,
        format: options.format,
        search: options.search,
        status: options.status,
        temporary: options.temporary,
        worker: options.worker,
    });

    const exec = execArgsFor(detectPackageManager(cwd), tailCommand.tool, tailCommand.args);
    const descriptor: SpawnDescriptor = {
        args: exec.args,
        command: exec.command,
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

/** `lunora logs [worker]` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<LogsOptions> = defineHandler<LogsOptions>(({ argument, cwd, logger, options }) => {
    // `--durable` switches from tailing a live Worker to reading the persisted
    // `ctx.log` archive (pipelineLogSink → R2) back via R2 SQL — a different data
    // path with its own credentials, so it forks here before touching wrangler.
    if (options.durable === true) {
        return runDurableLogsCommand({
            cursor: options.cursor,
            functionPrefix: options.functionPrefix,
            level: options.level,
            limit: options.limit,
            logger,
            minLevel: options.minLevel,
            namespace: options.namespace,
            ndjson: options.ndjson === true,
            shardKey: options.shardKey,
            since: options.since,
            table: options.table,
            traceId: options.traceId,
            until: options.until,
            userId: options.userId,
        });
    }

    return runLogsCommand({
        cwd,
        env: options.env,
        format: options.format,
        logger,
        search: options.search,
        status: options.status,
        target: options.target,
        temporary: options.temporary === true,
        worker: argument[0],
    });
});

export { execute };
export type { LogsCommandOptions, LogsCommandResult };
export { runLogsCommand };
