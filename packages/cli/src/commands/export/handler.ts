import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { resolveProductionWorkerUrl } from "../../util/resolve-target";
import type { ExportCommandData } from "../data-transfer/export";
import { runExportCommand } from "../data-transfer/export";
import type { ExportOptions } from "./index";

/**
 * `lunora export` handler. The positional path (alias for `--out`) takes
 * precedence over the flag. Streams via {@link runExportCommand}.
 */
const execute: CommandHandler<ExportOptions> = defineHandler<ExportOptions, ExportCommandData>(({ argument, cwd, format, logger, options }) =>
    runExportCommand({
        cwd,
        format,
        logger,
        out: argument[0] ?? options.out,
        prod: options.prod === true,
        tables: options.tables,
        token: options.token,
        url: resolveProductionWorkerUrl({ cwd, prod: options.prod === true, url: options.url }),
    }),
);

export { execute };
