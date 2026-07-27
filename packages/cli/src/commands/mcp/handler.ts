import { VERSION } from "../../cli";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { McpOptions } from "./index";
import { runMcpInstall, runMcpInstallList } from "./install";
import { runMcpServe } from "./serve";

/**
 * `lunora mcp &lt;install|serve>` handler (lazy-loaded via the command's `loader`).
 *
 * `serve` never returns while the client holds the connection open: the stdio
 * transport keeps the process alive, so the `{ code: 0 }` below is reached only
 * once the client disconnects (or immediately, on a startup failure).
 */
const execute: CommandHandler<McpOptions> = defineHandler<McpOptions>(async ({ argument, cwd, logger, options }) => {
    const [subcommand, ...rest] = argument;

    if (subcommand === "serve") {
        const { code } = await runMcpServe({
            allowWrites: options.allowWrites === true,
            cwd,
            // cerebro exposes `--no-docs` as `docs: false`.
            noDocs: options.docs === false,
            version: VERSION,
            ...(options.docsUrl === undefined ? {} : { docsUrl: options.docsUrl }),
            ...(options.token === undefined ? {} : { token: options.token }),
            ...(options.url === undefined ? {} : { url: options.url }),
        });

        return { code };
    }

    if (subcommand === "install") {
        if (options.list === true) {
            return runMcpInstallList({ cwd, logger });
        }

        const { code } = runMcpInstall({
            clients: rest,
            cwd,
            docsOnly: options.docsOnly === true,
            force: options.force === true,
            localOnly: options.localOnly === true,
            logger,
            print: options.print === true,
            ...(options.docsUrl === undefined ? {} : { docsUrl: options.docsUrl }),
        });

        return { code };
    }

    logger.error("mcp: unknown subcommand. Usage: lunora mcp <install|serve>");

    return { code: 1 };
});

export { execute };
