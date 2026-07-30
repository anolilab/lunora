import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { resolveProductionWorkerUrl } from "../../util/resolve-target";
import { runImportCommand } from "../data-transfer";
import type { ImportOptions } from "./index";

/**
 * `lunora import &lt;path>` handler. The positional is either an NDJSON file or a
 * `npx convex export --path &lt;dir>` directory; {@link runImportCommand} detects
 * which and bulk-inserts either way.
 */
const execute: CommandHandler<ImportOptions> = defineHandler<ImportOptions>(({ argument, cwd, logger, options }) => {
    const file = argument[0];

    if (!file) {
        logger.error("import requires a path. Usage: lunora import <file.ndjson | convex-export-dir> [--table <name>]");

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
        yes: options.yes === true,
    });
});

export { execute };
