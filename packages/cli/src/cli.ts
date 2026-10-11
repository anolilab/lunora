import { findSolutionByMessage, isLunoraError } from "@lunora/errors";
import type { Command } from "@visulima/cerebro";
import { createCerebro } from "@visulima/cerebro";
import completionCommand from "@visulima/cerebro/command/completion";
import versionCommand from "@visulima/cerebro/command/version";

import { addCommand } from "./commands/add";
import { advisorCommand } from "./commands/advisor";
import { analyzeCommand } from "./commands/analyze";
import { backupCommand } from "./commands/backup";
import { buildCommand } from "./commands/build";
import { cloudflareCommand } from "./commands/cloudflare";
import { codegenCommand } from "./commands/codegen";
import { deployCommand } from "./commands/deploy";
import { devCommand } from "./commands/dev";
import documentationCommand from "./commands/docs";
import { doctorCommand } from "./commands/doctor";
import { envCommand } from "./commands/env";
import { evalCommand } from "./commands/eval";
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
import { profileCommand } from "./commands/profile";
import { registryCommand } from "./commands/registry/command";
import { resetCommand } from "./commands/reset";
import { rulesCommand } from "./commands/rules";
import { runCommand } from "./commands/run";
import { sdkCommand } from "./commands/sdk";
import { seedCommand } from "./commands/seed";
import { shardsCommand } from "./commands/shards";
import { verifyCommand } from "./commands/verify";
import viewCommand from "./commands/view";
import { resolveCliVersion } from "./util/cli-manifest";
import { detectPackageManager } from "./util/detect-package-manager";
import { EXIT_CODE, exitCodeForError } from "./util/exit-code";
import type { Logger } from "./util/logger";
import { createLogger, setCommandLogger } from "./util/logger";
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
    "prepare",
    "link",
    "cloudflare",
    "logs",
    "run",
    "insights",
    "profile",
    "reset",
    "migrate",
    "export",
    "import",
    "seed",
    "shards",
    "backup",
    "eval",
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

const VERSION: string = resolveCliVersion();

/** The command objects, in display order; each lazy-loads its handler. */
const CLI_COMMANDS = [
    initCommand,
    addCommand,
    devCommand,
    codegenCommand,
    advisorCommand,
    buildCommand,
    deployCommand,
    prepareCommand,
    linkCommand,
    cloudflareCommand,
    logsCommand,
    runCommand,
    insightsCommand,
    profileCommand,
    resetCommand,
    migrateCommand,
    exportCommand,
    importCommand,
    seedCommand,
    shardsCommand,
    introspectCommand,
    backupCommand,
    evalCommand,
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
    sdkCommand,
];

/**
 * Every command actually handed to cerebro — the project's own, plus the two
 * opt-in built-ins. (`help` and the `-h`/`--help` flag are auto-registered by
 * cerebro itself, so they are not here.)
 *
 * One collection, because the brace-escaping pass and the help-rendering guard
 * must not disagree about what is registered: escaping `CLI_COMMANDS` alone
 * would leave `version`/`completion` unescaped, and deriving the guard's names
 * from it would leave them untested.
 */
const REGISTERED_COMMANDS: ReadonlyArray<Command> = [...CLI_COMMANDS, versionCommand, completionCommand];

/**
 * Every registered command's name. A superset of {@link COMMANDS}, which is the
 * user-facing list driving "did you mean …?" suggestions — `advisor`,
 * `introspect`, `version` and `completion` are all reachable but deliberately
 * absent from it. Exported so the help-rendering guard covers what is actually
 * reachable, not what is advertised.
 */
const REGISTERED_COMMAND_NAMES: ReadonlyArray<string> = REGISTERED_COMMANDS.map((command) => command.name);

/**
 * Escape `{` / `}` so cerebro's help renderer prints them literally.
 *
 * cerebro renders help text through chalk's tagged-template parser, which reads
 * `{style ...}` as markup — so a description or example carrying a real brace
 * (a JSON `--args` sample, or the import line's `table`/`doc` envelope) does not
 * render wrong, it throws: `Found extraneous } in template literal`, and that
 * command's help becomes unreachable. `lunora import --help` and `lunora run
 * --help` both died this way, so the documented shape of the import line had to
 * be read out of the package's `.d.ts` instead.
 *
 * Escaping at registration rather than policing every string keeps help text
 * written the way it reads, and means a future command carrying a brace cannot
 * reintroduce the bug. Nothing here uses chalk styling in help text deliberately,
 * so there is no markup to preserve.
 *
 * The same upstream defect breaks `vis sort-package-json --help`.
 * @see {@link https://github.com/visulima/visulima/issues/741}
 */
const escapeHelpBraces = (text: string): string => text.replaceAll("{", String.raw`\{`).replaceAll("}", String.raw`\}`);

/**
 * Escape a command's `examples`, which cerebro types `string[] | string[][]` —
 * either a list of bare invocations or a list of `[invocation, caption]` rows.
 */
const escapeExamples = (examples: string[] | string[][]): string[] | string[][] => {
    // Branch per element, not once on the list. cerebro's type says the array is
    // homogeneous, but this runs at CLI construction for every command on every
    // invocation — a mixed array would throw `row.map is not a function` and take
    // down the whole CLI, not just that command's help.
    if (examples.every((example) => typeof example === "string")) {
        return examples.map((example) => escapeHelpBraces(example));
    }

    return examples.map((row) => (typeof row === "string" ? [escapeHelpBraces(row)] : row.map((part) => escapeHelpBraces(part))));
};

/** Apply {@link escapeHelpBraces} to every field of a command that reaches the help renderer. */
const escapeCommandHelpBraces = (command: Command): Command => {
    return {
        ...command,
        ...(command.argument === undefined ? {} : { argument: { ...command.argument, description: escapeHelpBraces(command.argument.description ?? "") } }),
        ...(command.description === undefined ? {} : { description: escapeHelpBraces(command.description) }),
        ...(command.examples === undefined ? {} : { examples: escapeExamples(command.examples) }),
        ...(command.options === undefined
            ? {}
            : {
                  options: command.options.map((option) => {
                      return { ...option, description: escapeHelpBraces(option.description ?? "") };
                  }),
              }),
    };
};

interface RunCliOptions {
    argv?: ReadonlyArray<string>;
    cwd?: string;

    /**
     * Inject a console-like logger so callers (tests) can capture cerebro's
     * help / version / usage rendering AND the commands' own output. Omitted in
     * production, where cerebro uses its default stdout/stderr logger and the
     * commands log through the shared pail.
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
 * `commands/<name>/index.ts`, handler in `commands/<name>/handler.ts`). cerebro
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

    for (const command of REGISTERED_COMMANDS) {
        cli.addCommand(escapeCommandHelpBraces(command));
    }

    return { cli, exitCode };
};

/** cerebro's unknown-command error wording — `Command "x" not found`. */
const UNKNOWN_COMMAND = /Command "(?<name>[^"]+)" not found/u;

/** A command that moved: where it went, and an old subcommand word the new one no longer takes. */
interface MovedCommand {
    absorbs?: string;
    to: string;
}

/**
 * Commands that moved, keyed by their old first word. Consulted only once
 * cerebro has refused the name (or for `lunora help <name>`), so an old
 * spelling is an error that says where the command went — never an alias that
 * runs it. `absorbs`: `ai gateway` became one tool, `ai-gateway`.
 */
const MOVED_COMMANDS: Readonly<Record<string, MovedCommand>> = {
    ai: { absorbs: "gateway", to: "cloudflare ai-gateway" },
    alerts: { to: "cloudflare alerts" },
    containers: { to: "cloudflare containers" },
    deployments: { to: "cloudflare deployments" },
};

/**
 * The options of `lunora cloudflare` that take a value, so the word after one
 * is read as that value and not as a positional (`--id gateway`).
 */
const VALUE_FLAGS: ReadonlySet<string> = new Set(
    (cloudflareCommand.options ?? []).filter((option) => option.type !== Boolean).map((option) => `--${option.name}`),
);

/** Arguments a POSIX shell passes through unchanged when left unquoted. */
const SHELL_SAFE = /^[\w@%+=:,./-]+$/u;

/**
 * Quote `value` for a POSIX shell so a printed command pastes back as the same
 * argv: anything beyond a conservative safe set is single-quoted, with an
 * embedded `'` written as `'\''`. Without it, `--message 'bad deploy'` came
 * back as `--message bad deploy` — a live rollback with a truncated message.
 */
const shellQuote = (value: string): string => (SHELL_SAFE.test(value) ? value : `'${value.replaceAll("'", String.raw`'\''`)}'`);

/** `list` without its first `value`. */
const withoutFirst = (list: ReadonlyArray<string>, value: string): string[] => {
    const index = list.indexOf(value);

    return index === -1 ? [...list] : [...list.slice(0, index), ...list.slice(index + 1)];
};

/** The index of the first positional `value` in `argv` — not a flag, and not a value-taking flag's value. */
const positionalIndex = (argv: ReadonlyArray<string>, value: string): number =>
    argv.findIndex((token, index) => token === value && (index === 0 || !VALUE_FLAGS.has(argv[index - 1] ?? "")));

/**
 * The moved command a typed word names, exactly or as a typo of it. A typo
 * resolves with the same distance rule as "did you mean", against the real
 * commands too, so a word nearer a real command is left to that suggestion.
 */
const movedCommandFor = (typed: string): string | undefined => {
    const match = closestMatch(typed, [...COMMANDS, ...Object.keys(MOVED_COMMANDS)]);

    return match !== undefined && Object.hasOwn(MOVED_COMMANDS, match) ? match : undefined;
};

/**
 * The "moved to" message when the command word `typed` is (or is a typo of) a
 * moved command, or `undefined`. `argv` is everything after `typed`; the
 * suggested command keeps all of it, shell-quoted, so it re-runs as printed
 * (cerebro's error carries only the positionals, so the argv is read instead).
 * `runInstead` replaces that suggestion — `lunora help <moved>` points at the
 * group's help rather than at a run.
 */
const movedCommandMessage = (typed: string, argv: ReadonlyArray<string>, runInstead?: string): string | undefined => {
    const name = movedCommandFor(typed);
    const moved = name === undefined ? undefined : MOVED_COMMANDS[name];

    if (name === undefined || moved === undefined) {
        return undefined;
    }

    const typo = typed === name ? "" : `\`lunora ${typed}\` is not a command. `;
    let rest = [...argv];

    if (moved.absorbs !== undefined) {
        const index = positionalIndex(rest, moved.absorbs);

        // Without the old subcommand there is nothing to translate: bare
        // `lunora ai` was a usage error, and the tool it would map to creates a
        // gateway and edits wrangler.jsonc — not something to hand over ready to run.
        if (index === -1 && runInstead === undefined) {
            return `${typo}\`lunora ${name}\` had one subcommand, \`${moved.absorbs}\`; it moved to \`lunora ${moved.to}\`.`;
        }

        rest = index === -1 ? rest : [...rest.slice(0, index), ...rest.slice(index + 1)];
    }

    const old = moved.absorbs === undefined ? name : `${name} ${moved.absorbs}`;
    const run = runInstead ?? ["lunora", moved.to, ...rest.map((argument) => shellQuote(argument))].join(" ");

    return `${typo}\`lunora ${old}\` moved to \`lunora ${moved.to}\`. Run: ${run}`;
};

/**
 * Log a failed `cli.run` and resolve the exit code it should carry. For an
 * unknown command, say where a moved command went, or else upgrade cerebro's
 * bare "not found" into a "did you mean …?" suggestion plus a help/docs
 * pointer; any other error is logged verbatim.
 */
const reportRunError = (error: unknown, argv: ReadonlyArray<string>): number => {
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

        return exitCodeForError(error);
    }

    const name = unknown.groups.name ?? "";
    const typed = name.split(" ")[0] ?? "";
    const moved = movedCommandMessage(typed, withoutFirst(argv, typed));

    if (moved !== undefined) {
        logger.error(moved);

        return EXIT_CODE.USAGE;
    }

    const suggestion = closestMatch(name, COMMANDS);

    logger.error(`Unknown command "${name}".${suggestion === undefined ? "" : ` Did you mean "${suggestion}"?`}`);
    logger.info("Run `lunora --help` to list commands, or `lunora docs` to open the documentation.");

    // A name the CLI does not have is bad usage, not a failed run.
    return EXIT_CODE.USAGE;
};

/**
 * Adapt an injected `Console` to the commands' {@link Logger} shape. `success`
 * has no Console equivalent, so it lands on `info` — the channel a Console-based
 * caller already reads for it.
 */
const asCommandLogger = (console_: Console): Logger => {
    return {
        debug: (message) => {
            console_.debug(message);
        },
        error: (message) => {
            console_.error(message);
        },
        info: (message) => {
            console_.info(message);
        },
        success: (message) => {
            console_.info(message);
        },
        warn: (message) => {
            console_.warn(message);
        },
    };
};

/**
 * Run the CLI and resolve to the process exit code. cerebro handles help,
 * version, usage, and unknown commands (the latter throws, caught here as 1).
 * `shouldExitProcess: false` keeps the process alive so callers/tests read the
 * captured exit code.
 */
const runCli = async (options: RunCliOptions = {}): Promise<number> => {
    const { cli, exitCode } = buildCli(options);

    // An injected logger has to reach the command bodies too, not just cerebro's
    // own rendering: they log through the shared pail, so without this a
    // command's output went to the real stdout/stderr regardless — unassertable,
    // and interleaved with the caller's own output. Cleared afterwards so one
    // call cannot leave the override installed for the next.
    if (options.logger !== undefined) {
        setCommandLogger(asCommandLogger(options.logger));
    }

    const argv = options.argv ?? process.argv.slice(2);

    try {
        // cerebro's `help` answers an unknown name with "not found" and exit 0,
        // so `lunora help containers` would tell nobody where it went.
        const helpMoved = argv[0] === "help" && argv[1] !== undefined ? movedCommandMessage(argv[1], argv.slice(2), "lunora help cloudflare") : undefined;

        if (helpMoved !== undefined) {
            createLogger().error(helpMoved);

            return EXIT_CODE.USAGE;
        }

        await cli.run({ shouldExitProcess: false });
    } catch (error: unknown) {
        return reportRunError(error, argv);
    } finally {
        setCommandLogger(undefined);
    }

    // Best-effort "update available" notice. A no-op for the unpublished dev
    // version (`0.0.0`), in CI, when stdout isn't a TTY, or when opted out — so
    // it never fires in tests or dev, and never blocks the resolved exit code.
    // The manager detection is itself best-effort — undetectable just means the
    // notice falls back to naming no specific install command.
    let manager: ReturnType<typeof detectPackageManager> | undefined;

    try {
        manager = detectPackageManager(process.cwd());
    } catch {
        // best-effort — leave `manager` undefined
    }

    await maybeNotifyUpdate({ current: VERSION, logger: createLogger(), manager });

    return exitCode.value;
};

export type { CommandName, RunCliOptions };

export { COMMANDS, REGISTERED_COMMAND_NAMES, runCli, VERSION };
