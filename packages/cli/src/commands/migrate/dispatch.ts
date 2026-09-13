/**
 * `lunora migrate <subcommand>` — the cerebro adapter and the five subcommand
 * shells it routes to.
 *
 * Split from `./handler`, which holds the migration operations themselves and is
 * the library entry point (`runMigrateGenerateCommand` is re-exported from the
 * package root). The dependency runs one way — dispatch reads handler — so the
 * file that grows a subcommand is not the file an embedder imports.
 */
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { EXIT_CODE } from "../../util/exit-code";
import type { Logger } from "../../util/logger";
import type { CommandResult } from "../../util/output-format";
import { resolveProductionWorkerUrl } from "../../util/resolve-target";
import { runMigrateCreateCommand, runMigrateDataCommand, runMigrateGenerateCommand, runMigrateToHyperdriveCommand } from "./handler";
import type { MigrateOptions } from "./index";

/**
 * The `--format json` payload, discriminated by `subcommand`: the five verbs
 * answer five different questions. There is no `ok` — the envelope's `code` is
 * the verdict.
 */
type MigrateCommandData =
    | { bytes: number; exported: number; imported: number; subcommand: "d1-to-hyperdrive" }
    | { empty: boolean; migrationFile?: string; subcommand: "generate" }
    | { file?: string; name: string; subcommand: "create" }
    | { id: string; result: unknown; subcommand: "down" | "status" | "up" };

/** What every `migrate` subcommand shell below needs: the parsed invocation. */
interface MigrateDispatchContext {
    argument: string[];
    cwd: string;
    /** Already routed for the format — stderr in json mode. */
    logger: Logger;
    options: MigrateOptions;
}

/** `migrate generate`: diff the schema and emit a SQL migration. */
const dispatchGenerate = (context: MigrateDispatchContext): CommandResult<MigrateCommandData> => {
    const { argument, cwd, logger, options } = context;
    const result = runMigrateGenerateCommand({ cwd, logger, name: argument[1] ?? options.name });

    return {
        code: result.code,
        // `migrationFile` is omitted when nothing was written (an empty diff, or a failure).
        data: { empty: result.empty, migrationFile: result.migrationFile === "" ? undefined : result.migrationFile, subcommand: "generate" },
        ...(result.error === undefined ? {} : { error: result.error }),
    };
};

/** `migrate d1-to-hyperdrive`: copy `.global()` data between two deployments. */
const dispatchToHyperdrive = async (context: MigrateDispatchContext): Promise<CommandResult<MigrateCommandData>> => {
    const { logger, options } = context;
    const result = await runMigrateToHyperdriveCommand({
        batchSize: options.batchSize,
        fromToken: options.fromToken ?? options.token,
        fromUrl: options.fromUrl ?? options.url,
        logger,
        out: options.out,
        prod: options.prod === true,
        tables: options.tables,
        toToken: options.toToken ?? options.token,
        toUrl: options.toUrl ?? options.url,
        yes: options.yes === true,
    });

    return {
        code: result.code,
        data: { bytes: result.bytes, exported: result.exported, imported: result.imported, subcommand: "d1-to-hyperdrive" },
        ...(result.error === undefined ? {} : { error: result.error }),
    };
};

/** `migrate create`: scaffold a data migration. */
const dispatchCreate = async (context: MigrateDispatchContext): Promise<CommandResult<MigrateCommandData>> => {
    const { argument, cwd, logger, options } = context;
    const name = argument[1] ?? options.name;

    if (!name) {
        const message = "migrate create requires a name. Usage: lunora migrate create <name> [--table <table>]";

        logger.error(message);

        return { code: EXIT_CODE.USAGE, error: message };
    }

    const result = await runMigrateCreateCommand({ cwd, logger, name, table: options.table });

    return { code: result.code, data: { file: result.file === "" ? undefined : result.file, name, subcommand: "create" } };
};

/** `migrate up|down|status`: drive the cross-shard data-migration orchestrator. */
const dispatchData = async (context: MigrateDispatchContext, subcommand: "down" | "status" | "up"): Promise<CommandResult<MigrateCommandData>> => {
    const { argument, cwd, logger, options } = context;
    const id = argument[1] ?? options.name;

    if (!id) {
        const message = `migrate ${subcommand} requires a migration id. Usage: lunora migrate ${subcommand} <id>`;

        logger.error(message);

        return { code: EXIT_CODE.USAGE, error: message };
    }

    const result = await runMigrateDataCommand({
        batchSize: options.batchSize,
        cwd,
        dryRun: options.dryRun === true,
        id,
        logger,
        maxBatches: options.steps,
        prod: options.prod === true,
        subcommand,
        token: options.token,
        url: resolveProductionWorkerUrl({ cwd, prod: options.prod === true, url: options.url }),
        yes: options.yes === true,
    });

    // The orchestrator's own per-shard roll-up is the document.
    return { code: result.code, data: { id, result: result.body, subcommand } };
};

/**
 * `lunora migrate <subcommand>` handler (lazy-loaded via the command's `loader`).
 *
 * The document is assembled here rather than inside each `run*` function: the
 * subcommands are five different operations sharing one command name, and each
 * already returns the structured result its payload is built from.
 */
const execute: CommandHandler<MigrateOptions> = defineHandler<MigrateOptions, MigrateCommandData>(async ({ argument, cwd, logger, options }) => {
    const sub = argument[0];
    const context: MigrateDispatchContext = { argument, cwd, logger, options };

    switch (sub) {
        case "create": {
            return await dispatchCreate(context);
        }
        case "d1-to-hyperdrive": {
            return await dispatchToHyperdrive(context);
        }
        case "down":
        case "status":
        case "up": {
            return await dispatchData(context, sub);
        }
        case "generate": {
            return dispatchGenerate(context);
        }
        default: {
            const message = `unknown migrate subcommand: "${sub ?? ""}" — expected generate | create | up | down | status`;

            context.logger.error(message);

            // Same class as an unknown top-level command, which `cli.ts` already
            // exits USAGE for. A misspelled subcommand is a wrong invocation, not
            // a failed run.
            return { code: EXIT_CODE.USAGE, error: message };
        }
    }
});

export { execute };
export type { MigrateCommandData };
