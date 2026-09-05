import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { RegistryOptions } from "./command";
import { runAddCommand, runBuildIndexCommand, runRegistryViewCommand } from "./index";

/**
 * `lunora registry` handler — dispatches `add | list | view | build` to the
 * orchestrators in `./index`. The remaining positionals after the subcommand are
 * item names.
 */
const execute: CommandHandler<RegistryOptions> = defineHandler<RegistryOptions>(({ argument, cwd, logger, options }) => {
    const subcommand = argument[0];
    const names = argument.slice(1);

    if (subcommand === "add") {
        return runAddCommand({
            allowUnsafeSource: options.allowUnsafeSource === true,
            cwd,
            diff: options.diff === true,
            dryRun: options.dryRun === true,
            from: options.from,
            json: options.json === true,
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
            from: options.from,
            json: options.json === true,
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

    logger.error("registry: unknown subcommand. Usage: lunora registry <add|list|view|build> [names…]");

    return { code: 1 };
});

export { execute };
