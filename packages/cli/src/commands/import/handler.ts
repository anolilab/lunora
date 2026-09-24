import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { EXIT_CODE } from "../../util/exit-code";
import { resolveProductionWorkerUrl } from "../../util/resolve-target";
import type { ImportCommandData } from "../data-transfer/import";
import { runImportCommand } from "../data-transfer/import";
import type { ImportSourceName } from "../data-transfer/import-source";
import { IMPORT_SOURCE_NAMES } from "../data-transfer/import-source";
import type { ImportOptions } from "./index";

/**
 * `lunora import <path>` handler. The positional is either an NDJSON file or a
 * `npx convex export --path <dir>` directory; {@link runImportCommand} detects
 * which and bulk-inserts either way.
 */
const execute: CommandHandler<ImportOptions> = defineHandler<ImportOptions, ImportCommandData>(({ argument, cwd, format, logger, options }) => {
    const file = argument[0];

    if (!file) {
        const error = "import requires a path. Usage: lunora import <file.ndjson | convex-export-dir> [--table <name>]";

        logger.error(error);

        return { code: EXIT_CODE.USAGE, error };
    }

    if (options.from !== undefined && !IMPORT_SOURCE_NAMES.includes(options.from as ImportSourceName)) {
        const error = `--from ${options.from} is not a known source. Expected one of: ${IMPORT_SOURCE_NAMES.join(", ")}.`;

        logger.error(error);

        return { code: EXIT_CODE.USAGE, error };
    }

    return runImportCommand({
        batchSize: options.batchSize,
        cwd,
        file,
        format,
        from: options.from as ImportSourceName | undefined,
        logger,
        prod: options.prod === true,
        scan: options.scan === true,
        storageDir: options.storageDir,
        table: options.table,
        token: options.token,
        url: resolveProductionWorkerUrl({ cwd, prod: options.prod === true, url: options.url }),
        verify: options.verify === true,
        withStorage: options.withStorage === true,
        yes: options.yes === true,
    });
});

export { execute };
