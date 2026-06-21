import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { resolveProductionWorkerUrl } from "../../util/resolve-target";
import { runImportCommand } from "../data-transfer";
import type { ImportOptions } from "./index";

/**
 * `lunora import &lt;file>` handler. Requires a source NDJSON file (positional).
 * Bulk-inserts via {@link runImportCommand}.
 */
const execute: CommandHandler<ImportOptions> = defineHandler<ImportOptions>(({ argument, cwd, logger, options }) => {
    const file = argument[0];

    if (!file) {
        logger.error("import requires a file. Usage: lunora import <path> [--table <name>]");

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
        url: resolveProductionWorkerUrl({ cwd, prod: options.prod === true, url: options.url }),
    });
});

export { execute };
