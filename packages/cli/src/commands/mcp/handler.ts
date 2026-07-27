import { VERSION } from "../../cli";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { McpScope } from "../../util/mcp-clients";
import type { McpOptions } from "./index";
import { runMcpInstall, runMcpInstallList } from "./install";
import { runMcpServe } from "./serve";
import { runMcpUninstall } from "./uninstall";

/**
 * `lunora mcp &lt;install|serve>` handler (lazy-loaded via the command's `loader`).
 *
 * `serve` never returns while the client holds the connection open: the stdio
 * transport keeps the process alive, so the `{ code: 0 }` below is reached only
 * once the client disconnects (or immediately, on a startup failure).
 */
/** `--global` / `--project` override each server's preferred scope; neither means "let each go where it belongs". */
const resolveScope = (options: McpOptions): McpScope | undefined => {
    if (options.global === true) {
        return "global";
    }

    return options.project === true ? "project" : undefined;
};

const serve = async (cwd: string, options: McpOptions): Promise<{ code: number }> => {
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
};

/** The `lunora mcp` subcommand dispatcher (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<McpOptions> = defineHandler<McpOptions>(async ({ argument, cwd, logger, options }) => {
    const [subcommand, ...rest] = argument;

    if (subcommand === "serve") {
        return serve(cwd, options);
    }

    if (subcommand === "uninstall") {
        const { code } = runMcpUninstall({
            clients: rest,
            cwd,
            docsOnly: options.docsOnly === true,
            localOnly: options.localOnly === true,
            logger,
        });

        return { code };
    }

    if (subcommand === "install") {
        if (options.list === true) {
            return runMcpInstallList({ cwd, logger });
        }

        const scope = resolveScope(options);

        const { code } = runMcpInstall({
            clients: rest,
            cwd,
            docsOnly: options.docsOnly === true,
            force: options.force === true,
            localOnly: options.localOnly === true,
            logger,
            print: options.print === true,
            ...(scope === undefined ? {} : { scope }),
            ...(options.docsUrl === undefined ? {} : { docsUrl: options.docsUrl }),
        });

        return { code };
    }

    logger.error("mcp: unknown subcommand. Usage: lunora mcp <install|uninstall|serve>");

    return { code: 1 };
});

export { execute };
