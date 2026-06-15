import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { runExportCommand } from "../data-transfer";
import type { ExportOptions } from "./index";

/**
 * `lunora export` handler. The positional path (alias for `--out`) takes
 * precedence over the flag. Streams via {@link runExportCommand}.
 */
const execute: CommandHandler<ExportOptions> = defineHandler<ExportOptions>(({ argument, cwd, logger, options }) =>
    runExportCommand({
        cwd,
        logger,
        out: argument[0] ?? options.out,
        prod: options.prod === true,
        tables: options.tables,
        token: options.token,
        url: options.url,
    }),
);

export { execute };
