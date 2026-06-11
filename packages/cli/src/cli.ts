import { createCerebro } from "@visulima/cerebro";
import completionCommand from "@visulima/cerebro/command/completion";
import versionCommand from "@visulima/cerebro/command/version";

import { analyzeCommand } from "./commands/analyze";
import { backupCommand } from "./commands/backup";
import { codegenCommand } from "./commands/codegen";
import { deployCommand } from "./commands/deploy";
import { devCommand } from "./commands/dev";
import documentationCommand from "./commands/docs";
import { envCommand } from "./commands/env";
import { exportCommand } from "./commands/export";
import { importCommand } from "./commands/import";
import { infoCommand } from "./commands/info";
import { initCommand } from "./commands/init";
import { logsCommand } from "./commands/logs";
import { migrateCommand } from "./commands/migrate";
import { prepareCommand } from "./commands/prepare";
import { registryCommand } from "./commands/registry/command";
import { resetCommand } from "./commands/reset";
import { runCommand } from "./commands/run";
import { verifyCommand } from "./commands/verify";
import { viewCommand } from "./commands/view";
import { createLogger } from "./util/logger";

/** Every command name the CLI registers (drives the `CommandName` type + tests). */
const COMMANDS = [
    "init",
    "dev",
    "codegen",
    "deploy",
    "prepare",
    "logs",
    "run",
    "reset",
    "migrate",
    "export",
    "import",
    "backup",
    "verify",
    "info",
    "env",
    "analyze",
    "view",
    "docs",
    "registry",
] as const;

type CommandName = (typeof COMMANDS)[number];

const VERSION = "0.0.0";

/** The command objects, in display order; each lazy-loads its handler. */
const CLI_COMMANDS = [
    initCommand,
    devCommand,
    codegenCommand,
    deployCommand,
    prepareCommand,
    logsCommand,
    runCommand,
    resetCommand,
    migrateCommand,
    exportCommand,
    importCommand,
    backupCommand,
    verifyCommand,
    infoCommand,
    envCommand,
    analyzeCommand,
    viewCommand,
    documentationCommand,
    registryCommand,
];

interface RunCliOptions {
    argv?: ReadonlyArray<string>;
    cwd?: string;

    /**
     * Inject a console-like logger so callers (tests) can capture cerebro's
     * help / version / usage rendering. Omitted in production, where cerebro
     * uses its default stdout/stderr logger.
     */
    logger?: Console;
}

interface BuildCliResult {
    cli: ReturnType<typeof createCerebro>;
    /** Records the exit code handlers report via `toolbox.process.exit(...)`. */
    exitCode: { value: number };
}

/**
 * Build the cerebro CLI. Every command is registered as a lazy-loaded
 * {@link https://github.com/visulima/visulima cerebro} command (metadata in
 * `commands/&lt;name>/index.ts`, handler in `commands/&lt;name>/handler.ts`). cerebro
 * owns help/version/usage rendering and unknown-command handling; the injected
 * `exit` captures each command's exit code so {@link runCli} can return it
 * without terminating the process (important for in-process tests).
 */
const buildCli = (options: RunCliOptions): BuildCliResult => {
    const exitCode = { value: 0 };

    const cli = createCerebro("cirrus", {
        argv: options.argv === undefined ? undefined : [...options.argv],
        cwd: options.cwd,
        exit: (code?: number) => {
            exitCode.value = typeof code === "number" ? code : 0;
        },
        logger: options.logger,
        packageName: "@cirrus/cli",
        packageVersion: VERSION,
    });

    for (const command of CLI_COMMANDS) {
        cli.addCommand(command);
    }

    // cerebro auto-registers `help` + the `-h`/`--help` flag; `version` and
    // `completion` (shell autocompletions via @bomb.sh/tab) are opt-in.
    cli.addCommand(versionCommand);
    cli.addCommand(completionCommand);

    return { cli, exitCode };
};

/**
 * Run the CLI and resolve to the process exit code. cerebro handles help,
 * version, usage, and unknown commands (the latter throws, caught here as 1).
 * `shouldExitProcess: false` keeps the process alive so callers/tests read the
 * captured exit code.
 */
const runCli = async (options: RunCliOptions = {}): Promise<number> => {
    const { cli, exitCode } = buildCli(options);

    try {
        await cli.run({ shouldExitProcess: false });
    } catch (error: unknown) {
        createLogger().error(error instanceof Error ? error.message : String(error));

        return 1;
    }

    return exitCode.value;
};

export type { CommandName, RunCliOptions };
export { COMMANDS, runCli, VERSION };
