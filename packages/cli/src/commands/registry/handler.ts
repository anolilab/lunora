import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { EXIT_CODE } from "../../util/exit-code";
import type { RegistryOptions } from "./command";
import { runAddCommand, runBuildIndexCommand, runRegistryViewCommand } from "./index";
import type { RegistryCommandData } from "./types";

/**
 * `lunora registry` handler — dispatches `add | list | view | build` to the
 * orchestrators in `./index`. The remaining positionals after the subcommand are
 * item names.
 */
const execute: CommandHandler<RegistryOptions> = defineHandler<RegistryOptions, RegistryCommandData>(({ argument, cwd, format, logger, options }) => {
    const subcommand = argument[0];
    const names = argument.slice(1);

    if (subcommand === "add") {
        return runAddCommand({
            allowUnsafeSource: options.allowUnsafeSource === true,
            cwd,
            diff: options.diff === true,
            dryRun: options.dryRun === true,
            format,
            from: options.from,
            logger,
            names,
            overwrite: options.overwrite === true,
            ref: options.ref,
            source: options.source,
            yes: options.yes === true,
        });
    }

    if (subcommand === "list") {
        // Forwarded, like `add` and `view` do: `sourceGateError` is one message and
        // one rule across all three, and dropping the override here made `list` the
        // only subcommand that refused a custom `--source` with no way to accept it.
        return runAddCommand({
            allowUnsafeSource: options.allowUnsafeSource === true,
            cwd,
            format,
            from: options.from,
            list: true,
            logger,
            names: [],
            ref: options.ref,
            source: options.source,
        });
    }

    if (subcommand === "view") {
        return runRegistryViewCommand({
            allowUnsafeSource: options.allowUnsafeSource === true,
            cwd,
            from: options.from,
            logger,
            names,
            ref: options.ref,
            source: options.source,
        });
    }

    if (subcommand === "build") {
        return runBuildIndexCommand({ check: options.check === true, cwd, from: options.from, logger, names: [], out: options.out });
    }

    const message = "registry: unknown subcommand. Usage: lunora registry <add|list|view|build> [names…]";

    logger.error(message);

    return { code: EXIT_CODE.USAGE, error: message };
});

export { execute };
