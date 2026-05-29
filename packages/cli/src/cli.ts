import { pathToFileURL } from "node:url";

import { boxen } from "@visulima/boxen";
import { Cerebro } from "@visulima/cerebro";
import colorize from "@visulima/colorize";

import { runCodegenCommand } from "./commands/codegen.js";
import { runDeployCommand } from "./commands/deploy.js";
import { runDevCommand } from "./commands/dev.js";
import type { Template } from "./commands/init.js";
import { runInitCommand } from "./commands/init.js";
import { runMigrateCreateCommand, runMigrateDataCommand, runMigrateGenerateCommand } from "./commands/migrate.js";
import { runResetCommand } from "./commands/reset.js";
import { runRpcCommand } from "./commands/run.js";
import { createLogger } from "./util/logger.js";

export const COMMANDS = ["init", "dev", "codegen", "deploy", "run", "reset", "migrate"] as const;

export type CommandName = (typeof COMMANDS)[number];

export const VERSION = "0.0.0";

export interface RunCliOptions {
    argv?: ReadonlyArray<string>;
    cwd?: string;
}

const isTemplate = (value: unknown): value is Template => {
    return value === "vite" || value === "standalone" || value === "next";
};

const toStringOrUndefined = (value: unknown): string | undefined => {
    return typeof value === "string" && value.length > 0 ? value : undefined;
};

const toNumberOrUndefined = (value: unknown): number | undefined => {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === "string") {
        const parsed = Number(value);

        return Number.isFinite(parsed) ? parsed : undefined;
    }

    return undefined;
};

const renderBanner = (): string => {
    const title = `${colorize.bold.cyan("cirrus")} ${colorize.dim(`v${VERSION}`)}`;

    return boxen(`${title}\n${colorize.dim("Cirrus framework CLI")}`, {
        borderColor: (border) => colorize.cyan(border),
        borderStyle: "round",
        padding: { left: 2, right: 2, top: 0, bottom: 0 },
        margin: 0,
    });
};

interface BuildCliResult {
    cli: Cerebro;
    exitCode: { value: number };
}

/**
 * Boolean options that should NOT consume the next token as their value.
 * (cerebro 2.1.5 has a quirk where options placed after a positional argument
 * are swallowed into the positional array; we sidestep that by moving all
 * options to the front of argv. We need to know which options take a value
 * so we can keep "option value" pairs together during the reorder.)
 */
const BOOLEAN_OPTIONS = new Set<string>(["all", "dry-run", "no-vite", "prod"]);

const isOptionToken = (token: string): boolean => {
    return token.startsWith("-");
};

const optionTakesValue = (token: string): boolean => {
    // "--foo=bar" is self-contained, never consumes the next token.
    if (token.includes("=")) {
        return false;
    }

    // Strip leading dashes and look up against the boolean set.
    const name = token.replace(/^-+/u, "");

    return !BOOLEAN_OPTIONS.has(name);
};

/**
 * Reorder argv so options appear before positionals, preserving the command
 * name in position 0. Keeps `option value` pairs together. Boolean options
 * are tracked in {@link BOOLEAN_OPTIONS} so they don't grab the following
 * positional as their value.
 *
 * Examples:
 *   ["init", "my-app", "-t", "vite"]   -> ["init", "-t", "vite", "my-app"]
 *   ["init", "my-app", "--template=v"] -> ["init", "--template=v", "my-app"]
 *   ["dev", "--no-vite", "--port", "1"] unchanged.
 */
const reorderArgvOptionsFirst = (argv: ReadonlyArray<string>): string[] => {
    if (argv.length <= 1) {
        return [...argv];
    }

    const [head, ...rest] = argv;
    const options: string[] = [];
    const positionals: string[] = [];

    for (let index = 0; index < rest.length; index += 1) {
        const token = rest[index];

        if (token === undefined) {
            continue;
        }

        if (token === "--") {
            // Everything after `--` is verbatim positional.
            positionals.push(...rest.slice(index));
            break;
        }

        if (isOptionToken(token)) {
            options.push(token);

            if (optionTakesValue(token)) {
                const next = rest[index + 1];

                if (next !== undefined && !isOptionToken(next)) {
                    options.push(next);
                    index += 1;
                }
            }
        } else {
            positionals.push(token);
        }
    }

    return [head as string, ...options, ...positionals];
};

const buildCli = (options: RunCliOptions): BuildCliResult => {
    const rawArgv = options.argv ?? process.argv.slice(2);
    const argv = reorderArgvOptionsFirst(rawArgv);
    const cwd = options.cwd ?? process.cwd();
    const logger = createLogger();
    const exitCode = { value: 0 };

    const cli = new Cerebro("cirrus", {
        argv: [...argv],
        cwd,
        packageName: "@cirrus/cli",
        packageVersion: VERSION,
    });

    cli.setCommandSection({
        header: renderBanner(),
        footer: colorize.dim("Run `cirrus help <command>` for details on a specific command."),
    });

    cli.addCommand({
        name: "init",
        description: "Scaffold a new Cirrus project",
        argument: { name: "name", description: "Project name", type: String },
        options: [
            {
                name: "template",
                alias: "t",
                type: String,
                description: "Template to scaffold (vite | standalone | next)",
                defaultValue: "vite",
            },
            {
                name: "from",
                type: String,
                description: "Local templates root to copy from (offline-friendly; expects <type>/ subdirs)",
            },
            {
                name: "source",
                type: String,
                description: "Override the remote template source (e.g. gh:owner/repo/sub#ref)",
            },
        ],
        execute: async ({ argument, options: parsed }) => {
            const name = argument[0];
            const templateRaw = parsed.template ?? "vite";
            const template: Template = isTemplate(templateRaw) ? templateRaw : "vite";
            const from = typeof parsed.from === "string" && parsed.from.length > 0 ? parsed.from : undefined;
            const source = typeof parsed.source === "string" && parsed.source.length > 0 ? parsed.source : undefined;

            const result = await runInitCommand({ cwd, from, logger, name, source, templateType: template });

            exitCode.value = result.code;
        },
    });

    cli.addCommand({
        name: "dev",
        description: "Run the dev server (Vite + wrangler, or wrangler alone)",
        options: [
            { name: "port", type: Number, description: "Port for the dev server" },
            { name: "no-vite", type: Boolean, description: "Skip the Vite frontend dev server" },
        ],
        execute: async ({ options: parsed }) => {
            const port = toNumberOrUndefined(parsed.port);

            const result = await runDevCommand({
                cwd,
                logger,
                noVite: parsed.noVite === true,
                port,
            });

            exitCode.value = result.code;
        },
    });

    cli.addCommand({
        name: "codegen",
        description: "Run codegen for cirrus/ functions and schema",
        execute: () => {
            try {
                runCodegenCommand({ cwd, logger });
                exitCode.value = 0;
            } catch (error: unknown) {
                logger.error(error instanceof Error ? error.message : String(error));
                exitCode.value = 1;
            }
        },
    });

    cli.addCommand({
        name: "deploy",
        description: "Codegen, validate wrangler, then wrangler deploy",
        options: [{ name: "env", type: String, description: "Cloudflare environment name" }],
        execute: async ({ options: parsed }) => {
            const result = await runDeployCommand({
                cwd,
                env: toStringOrUndefined(parsed.env),
                logger,
            });

            exitCode.value = result.code;
        },
    });

    cli.addCommand({
        name: "run",
        description: "Send a single RPC to a running Cirrus Worker",
        argument: { name: "functionPath", description: "Function path (e.g. messages:send)", type: String },
        options: [
            { name: "args", type: String, description: "JSON-encoded args object" },
            { name: "shard", type: String, description: "Explicit shard key" },
            { name: "url", type: String, description: "Worker URL (default http://localhost:8787)" },
        ],
        execute: async ({ argument, options: parsed }) => {
            const fn = argument[0];

            if (!fn) {
                logger.error("missing function path. Usage: cirrus run <functionPath> [--args <json>]");
                exitCode.value = 1;

                return;
            }

            try {
                const result = await runRpcCommand({
                    args: toStringOrUndefined(parsed.args),
                    cwd,
                    functionPath: fn,
                    logger,
                    shard: toStringOrUndefined(parsed.shard),
                    url: toStringOrUndefined(parsed.url),
                });

                exitCode.value = result.code;
            } catch (error: unknown) {
                logger.error(error instanceof Error ? error.message : String(error));
                exitCode.value = 1;
            }
        },
    });

    cli.addCommand({
        name: "reset",
        description: "Clear local Miniflare state (and .cirrus-cache with --all)",
        options: [{ name: "all", type: Boolean, description: "Also remove .cirrus-cache" }],
        execute: ({ options: parsed }) => {
            runResetCommand({
                all: parsed.all === true,
                cwd,
                logger,
            });

            exitCode.value = 0;
        },
    });

    cli.addCommand({
        name: "migrate",
        description: "Schema (generate) and online data (create | up | down | status) migrations",
        argument: { name: "subcommand", description: "generate | create | up | down | status [name|id]", type: String },
        options: [
            { name: "name", type: String, description: "Migration name slug (e.g. add_users_email)" },
            { name: "table", type: String, description: "Target table for `create`" },
            { name: "dry-run", type: Boolean, description: "Preview a data migration without rewriting rows" },
            { name: "batch-size", type: Number, description: "Rows per batch for a data migration" },
            { name: "steps", type: Number, description: "Cap batches processed this run (maps to the runner's maxBatches)" },
            { name: "prod", type: Boolean, description: "Target production — requires an explicit --url" },
            { name: "url", type: String, description: "Worker URL (default http://localhost:8787)" },
            { name: "token", type: String, description: "Admin bearer token (or CIRRUS_ADMIN_TOKEN)" },
        ],
        execute: async ({ argument, options: parsed }) => {
            const sub = argument[0];

            if (sub === "generate") {
                const result = runMigrateGenerateCommand({ cwd, logger, name: argument[1] ?? toStringOrUndefined(parsed.name) });

                exitCode.value = result.code;

                return;
            }

            if (sub === "create") {
                const name = argument[1] ?? toStringOrUndefined(parsed.name);

                if (!name) {
                    logger.error("migrate create requires a name. Usage: cirrus migrate create <name> [--table <table>]");
                    exitCode.value = 1;

                    return;
                }

                const result = runMigrateCreateCommand({ cwd, logger, name, table: toStringOrUndefined(parsed.table) });

                exitCode.value = result.code;

                return;
            }

            if (sub === "up" || sub === "down" || sub === "status") {
                const id = argument[1] ?? toStringOrUndefined(parsed.name);

                if (!id) {
                    logger.error(`migrate ${sub} requires a migration id. Usage: cirrus migrate ${sub} <id>`);
                    exitCode.value = 1;

                    return;
                }

                try {
                    const result = await runMigrateDataCommand({
                        batchSize: toNumberOrUndefined(parsed.batchSize),
                        cwd,
                        dryRun: parsed.dryRun === true,
                        id,
                        logger,
                        maxBatches: toNumberOrUndefined(parsed.steps),
                        prod: parsed.prod === true,
                        subcommand: sub,
                        token: toStringOrUndefined(parsed.token),
                        url: toStringOrUndefined(parsed.url),
                    });

                    exitCode.value = result.code;
                } catch (error: unknown) {
                    logger.error(error instanceof Error ? error.message : String(error));
                    exitCode.value = 1;
                }

                return;
            }

            logger.error(`unknown migrate subcommand: "${sub ?? ""}" — expected generate | create | up | down | status`);
            exitCode.value = 1;
        },
    });

    return { cli, exitCode };
};

const HELP = `cirrus — Cirrus framework CLI

Usage: cirrus <command> [options]

Commands:
  init [name] [-t <template>]   Scaffold a new Cirrus project (templates: vite, standalone, next)
       [--from <path>] [--source <src>]  Use a local templates dir or override the remote source
  dev  [--port <n>] [--no-vite] Run the dev server (Vite + wrangler, or wrangler alone)
  codegen                       Run codegen for cirrus/ functions and schema
  deploy [--env <name>]         Codegen, validate wrangler, then wrangler deploy
  run <fn> [--args <json>]      Send a single RPC to a running Cirrus Worker
       [--shard <key>] [--url <url>]
  migrate generate [name]       Diff cirrus/schema.ts against the snapshot and emit migration SQL
  migrate create <name>         Scaffold a defineMigration block in cirrus/migrations.ts
          [--table <table>]
  migrate up|down <id>          Run a data migration across shards (forward/reverse)
          [--dry-run] [--batch-size <n>] [--steps <n>] [--prod] [--url <url>] [--token <t>]
  migrate status <id>           Report a data migration's per-shard status
          [--url <url>] [--token <t>]
  reset [--all]                 Clear local Miniflare state (and .cirrus-cache with --all)

Global options:
  -h, --help                    Show this help and exit
  -v, --version                 Print the CLI version
`;

const printHelp = (): void => {
    process.stdout.write(HELP);
};

export const runCli = async (options: RunCliOptions = {}): Promise<number> => {
    const argv = options.argv ?? process.argv.slice(2);

    // Cerebro owns help/version rendering at runtime, but the unit tests
    // assert on the plain-text HELP block (and on a "Usage:" prefix when
    // no args are given). Keep those fast paths here so tests don't have
    // to depend on cerebro's exact ANSI/box layout.
    if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help") {
        printHelp();

        return 0;
    }

    if (argv[0] === "-v" || argv[0] === "--version") {
        process.stdout.write(`${VERSION}\n`);

        return 0;
    }

    const head = argv[0];

    if (head !== undefined && !COMMANDS.includes(head as CommandName)) {
        const logger = createLogger();

        logger.error(`unknown command: ${head}`);
        printHelp();

        return 1;
    }

    const { cli, exitCode } = buildCli(options);

    try {
        await cli.run({ shouldExitProcess: false });
    } catch (error: unknown) {
        const logger = createLogger();

        logger.error(error instanceof Error ? error.message : String(error));

        return 1;
    }

    return exitCode.value;
};

const isMain = (): boolean => {
    const entry = process.argv[1];

    if (!entry) {
        return false;
    }

    try {
        if (import.meta.url === pathToFileURL(entry).href) {
            return true;
        }
    } catch {
        /* pathToFileURL may throw for unusual argv[1] values — fall through */
    }

    // Fallback for edge cases (tsx loader, symlinked bin, etc).
    return entry.endsWith("cli.ts") || entry.endsWith("cli.js") || entry.endsWith("cirrus.mjs");
};

if (isMain()) {
    runCli().then(
        (code) => {
            process.exit(code);
        },
        (error: unknown) => {
            process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
            process.exit(1);
        },
    );
}
