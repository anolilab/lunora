import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { runImportCommand } from "../data-transfer";
import type { ImportOptions } from "./index";

/**
 * `cirrus import &lt;file>` handler. Requires a source NDJSON file (positional).
 * Bulk-inserts via {@link runImportCommand}.
 */
const execute: CommandHandler<ImportOptions> = defineHandler<ImportOptions>(({ argument, cwd, logger, options }) => {
    const file = argument[0];

    if (!file) {
        logger.error("import requires a file. Usage: cirrus import <path> [--table <name>]");

        return { code: 1 };
    }

    return runImportCommand({
        batchSize: options.batchSize,
        cwd,
        file,
        logger,
        prod: options.prod === true,
        table: options.table,
        token: options.token,
        url: options.url,
    });
});

export { execute };
