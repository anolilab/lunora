import { readLinkedProject, resolveDeployDriver } from "@lunora/config";

import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { detectPackageManager, execArgsFor } from "../../util/detect-package-manager";
import { EXIT_CODE } from "../../util/exit-code";
import type { Logger } from "../../util/logger";
import type { OutputFormat } from "../../util/output-format";
import type { SpawnDescriptor, Spawner } from "../../util/spawn";
import { defaultSpawner } from "../../util/spawn";
import { runDurableLogsCommand } from "./durable";
import type { LogsOptions } from "./index";

interface LogsCommandOptions {
    cwd?: string;

    /** Cloudflare environment name (forwarded as `--env`). */
    env?: string;
    /** Output format: `pretty` (default) or `json`. */
    format?: OutputFormat;
    logger: Logger;
    /** Substring filter on log messages (forwarded as `--search`). */
    search?: string;
    spawner?: Spawner;
    /** Filter by invocation status: `ok`, `error`, or `canceled` (forwarded as `--status`). */
    status?: string;
    /** Deploy target whose tail command to run. Resolved by the caller; falls back to `"target"` in `lunora.config.*`, then `"cloudflare"`. */
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

    /**
     * `logs` streams: `--format json` selects wrangler tail's own JSON log lines
     * on stdout, and `--durable` prints the archived rows there. Either way the
     * stream owns stdout, so the CLI must not append a result document to it.
     */
    delegated?: boolean;
    descriptor: SpawnDescriptor | undefined;
    /** Set when the run aborted before reaching the wrangler invocation. */
    error?: string;
}

/**
 * Stream live logs from a deployed Lunora Worker by wrapping `wrangler tail`.
 *
 * Unlike `deploy`, this neither runs codegen nor validates wrangler bindings —
 * it only forwards a tail request, and `wrangler` itself reports a clear error
 * if the Worker isn't deployed or the config can't be resolved. `--format` is
 * already parsed by `defineHandler`, so it arrives here as a settled choice.
 */
const runLogsCommand = async (options: LogsCommandOptions): Promise<LogsCommandResult> => {
    const cwd = options.cwd ?? process.cwd();

    // Default the environment from the `.lunora/project.json` link when the
    // caller didn't pass `--env`, so a linked checkout tails the right env.
    const env = options.env ?? readLinkedProject(cwd)?.env;
    const driver = resolveDeployDriver(options.target);

    if (driver.toolchain === undefined) {
        const message = `logs: deploy target "${driver.id}" has no command-line toolchain`;

        options.logger.error(message);

        return { code: EXIT_CODE.USAGE, descriptor: undefined, error: message };
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
        delegated: true,
        descriptor,
    };
};

/** `lunora logs [worker]` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<LogsOptions> = defineHandler<LogsOptions>(async ({ argument, cwd, format, logger, options }) => {
    // `--durable` switches from tailing a live Worker to reading the persisted
    // `ctx.log` archive (pipelineLogSink → R2) back via R2 SQL — a different data
    // path with its own credentials, so it forks here before touching wrangler.
    if (options.durable === true) {
        // The archived rows are the output, printed to stdout as text or NDJSON —
        // this run's stdout is a stream, never a result document.
        const durable = await runDurableLogsCommand({
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

        // `delegated` means "a child already wrote the document", which is only
        // true once the durable stream produced rows. Its early refusals (missing
        // config, bad option) write nothing, so claiming delegation there made
        // `--format json` suppress the envelope and leave stdout empty — the one
        // outcome the envelope exists to prevent.
        return { ...durable, ...(durable.rows === undefined ? {} : { delegated: true }) };
    }

    return runLogsCommand({
        cwd,
        env: options.env,
        format,
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
