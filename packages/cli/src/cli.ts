import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { findSolutionByMessage, isLunoraError } from "@lunora/errors";
import { createCerebro } from "@visulima/cerebro";
import completionCommand from "@visulima/cerebro/command/completion";
import versionCommand from "@visulima/cerebro/command/version";

import { addCommand } from "./commands/add";
import { advisorCommand } from "./commands/advisor";
import { analyzeCommand } from "./commands/analyze";
import { backupCommand } from "./commands/backup";
import { buildCommand } from "./commands/build";
import { codegenCommand } from "./commands/codegen";
import { containersCommand } from "./commands/containers";
import { deployCommand } from "./commands/deploy";
import { deploymentsCommand } from "./commands/deployments";
import { devCommand } from "./commands/dev";
import documentationCommand from "./commands/docs";
import { doctorCommand } from "./commands/doctor";
import { envCommand } from "./commands/env";
import { exportCommand } from "./commands/export";
import { importCommand } from "./commands/import";
import { infoCommand } from "./commands/info";
import { initCommand } from "./commands/init";
import { insightsCommand } from "./commands/insights";
import { introspectCommand } from "./commands/introspect";
import { linkCommand } from "./commands/link";
import { logsCommand } from "./commands/logs";
import { mcpCommand } from "./commands/mcp";
import { migrateCommand } from "./commands/migrate";
import { prepareCommand } from "./commands/prepare";
import { registryCommand } from "./commands/registry/command";
import { resetCommand } from "./commands/reset";
import { rulesCommand } from "./commands/rules";
import { runCommand } from "./commands/run";
import { seedCommand } from "./commands/seed";
import { verifyCommand } from "./commands/verify";
import { viewCommand } from "./commands/view";
import { createLogger } from "./util/logger";
import { renderLunoraError } from "./util/render-lunora-error";
import { closestMatch } from "./util/suggest";
import { maybeNotifyUpdate } from "./util/update-notifier";

/** Every command name the CLI registers (drives the `CommandName` type + tests). */
const COMMANDS = [
    "init",
    "add",
    "dev",
    "codegen",
    "build",
    "deploy",
    "containers",
    "prepare",
    "link",
    "deployments",
    "logs",
    "run",
    "insights",
    "reset",
    "migrate",
    "export",
    "import",
    "seed",
    "backup",
    "verify",
    "info",
    "doctor",
    "env",
    "analyze",
    "view",
    "docs",
    "registry",
    "rules",
    "mcp",
] as const;

type CommandName = (typeof COMMANDS)[number];

/**
 * How far up to look before giving up. Deep enough for the worst real layout —
 * a nested `dist/packem_shared/` chunk inside a hoisted `node_modules` — and
 * shallow enough to stop rather than walk to the filesystem root.
 */
const PACKAGE_JSON_SEARCH_DEPTH = 8;

/**
 * The CLI version, read from the package's own `package.json` at load time.
 *
 * It walks up for the manifest rather than resolving a fixed `../package.json`,
 * because this module's depth is not fixed: from `src/` under vitest the
 * manifest is one level up, but packem hoists the built module into a hashed
 * `dist/packem_shared/` chunk where it is two — so the fixed path resolved to a
 * nonexistent `dist/package.json` and every published build reported `0.0.0`.
 *
 * The name check matters: without it the walk would accept the first
 * `package.json` it met, which in a nested install is some dependency's.
 *
 * Falls back to the `0.0.0` dev sentinel, which also keeps the update notifier
 * quiet rather than comparing against a bogus version.
 */
const readCliVersion = (): string => {
    try {
        let directory = dirname(fileURLToPath(import.meta.url));

        for (let depth = 0; depth < PACKAGE_JSON_SEARCH_DEPTH; depth += 1) {
            try {
                const parsed: unknown = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
                const manifest = parsed !== null && typeof parsed === "object" ? (parsed as { name?: unknown; version?: unknown }) : undefined;

                if (manifest?.name === "@lunora/cli" && typeof manifest.version === "string" && manifest.version.length > 0) {
                    return manifest.version;
                }
            } catch {
                // No (or unreadable) package.json at this level — keep climbing.
            }

            const parent = dirname(directory);

            if (parent === directory) {
                break;
            }

            directory = parent;
        }
    } catch {
        // Fall through to the sentinel below.
    }

    return "0.0.0";
};

const VERSION: string = readCliVersion();

/** The command objects, in display order; each lazy-loads its handler. */
const CLI_COMMANDS = [
    initCommand,
    addCommand,
    devCommand,
    codegenCommand,
    advisorCommand,
    buildCommand,
    deployCommand,
    containersCommand,
    prepareCommand,
    linkCommand,
    deploymentsCommand,
    logsCommand,
    runCommand,
    insightsCommand,
    resetCommand,
    migrateCommand,
    exportCommand,
    importCommand,
    seedCommand,
    introspectCommand,
    backupCommand,
    verifyCommand,
    infoCommand,
    doctorCommand,
    envCommand,
    analyzeCommand,
    viewCommand,
    documentationCommand,
    registryCommand,
    rulesCommand,
    mcpCommand,
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

    const cli = createCerebro("lunora", {
        argv: options.argv === undefined ? undefined : [...options.argv],
        cwd: options.cwd,
        exit: (code?: number) => {
            exitCode.value = typeof code === "number" ? code : 0;
        },
        logger: options.logger,
        packageName: "@lunora/cli",
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

/** cerebro's unknown-command error wording — `Command "x" not found`. */
const UNKNOWN_COMMAND = /Command "(?<name>[^"]+)" not found/u;

/**
 * Log a failed `cli.run`. For an unknown command, upgrade cerebro's bare
 * "not found" into a "did you mean …?" suggestion plus a help/docs pointer; any
 * other error is logged verbatim.
 */
const reportRunError = (error: unknown): void => {
    const logger = createLogger();
    const message = error instanceof Error ? error.message : String(error);
    const unknown = UNKNOWN_COMMAND.exec(message);

    if (!unknown?.groups) {
        // A Lunora error (or a plain error whose message matches a known
        // solution, e.g. a codegen failure) renders with its actionable hint
        // block; anything else logs the bare message.
        if (isLunoraError(error) || findSolutionByMessage(message) !== undefined) {
            logger.error(renderLunoraError(error));
        } else {
            logger.error(message);
        }

        return;
    }

    const name = unknown.groups.name ?? "";
    const suggestion = closestMatch(name, COMMANDS);

    logger.error(`Unknown command "${name}".${suggestion === undefined ? "" : ` Did you mean "${suggestion}"?`}`);
    logger.info("Run `lunora --help` to list commands, or `lunora docs` to open the documentation.");
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
        reportRunError(error);

        return 1;
    }

    // Best-effort "update available" notice. A no-op for the unpublished dev
    // version (`0.0.0`), in CI, when stdout isn't a TTY, or when opted out — so
    // it never fires in tests or dev, and never blocks the resolved exit code.
    await maybeNotifyUpdate({ current: VERSION, logger: createLogger() });

    return exitCode.value;
};

export type { CommandName, RunCliOptions };
export { COMMANDS, runCli, VERSION };
