import { pathToFileURL } from "node:url";

import { boxen } from "@visulima/boxen";
import { Cerebro } from "@visulima/cerebro";
import { bold, cyan, dim } from "@visulima/colorize";

import { runAnalyzeCommand } from "./commands/analyze.js";
import type { BackupSubcommand } from "./commands/backup.js";
import { runBackupCommand } from "./commands/backup.js";
import { runCodegenCommand } from "./commands/codegen.js";
import { runExportCommand, runImportCommand } from "./commands/data-transfer.js";
import { runDeployCommand } from "./commands/deploy.js";
import { runDevCommand } from "./commands/dev.js";
// eslint-disable-next-line unicorn/prevent-abbreviations -- "docs" is the user-facing CLI command name (cirrus docs); the handler matches it
import { runDocsCommand } from "./commands/docs.js";
import type { EnvSubcommand } from "./commands/env.js";
import { runEnvCommand } from "./commands/env.js";
import { runInfoCommand } from "./commands/info.js";
import type { Template } from "./commands/init.js";
import { runInitCommand } from "./commands/init.js";
import { runLogsCommand } from "./commands/logs.js";
import { runMigrateCreateCommand, runMigrateDataCommand, runMigrateGenerateCommand } from "./commands/migrate.js";
import { runResetCommand } from "./commands/reset.js";
import { runRpcCommand } from "./commands/run.js";
import { runVerifyCommand } from "./commands/verify.js";
import { runViewCommand } from "./commands/view.js";
import { createLogger } from "./util/logger.js";

const COMMANDS = [
    "init",
    "dev",
    "codegen",
    "deploy",
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
] as const;

type CommandName = (typeof COMMANDS)[number];

const VERSION = "0.0.0";

interface RunCliOptions {
    argv?: ReadonlyArray<string>;
    cwd?: string;
}

const isTemplate = (value: unknown): value is Template => value === "vite" || value === "standalone" || value === "next" || value === "tanstack-start";

const isEnvSubcommand = (value: unknown): value is EnvSubcommand =>
    value === "list" || value === "get" || value === "set" || value === "unset" || value === "push";

const isBackupSubcommand = (value: unknown): value is BackupSubcommand => value === "create" || value === "list" || value === "restore";

const toStringOrUndefined = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

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
    const title = `${bold.cyan("cirrus")} ${dim(`v${VERSION}`)}`;

    return boxen(`${title}\n${dim("Cirrus framework CLI")}`, {
        borderColor: (border) => cyan(border),
        borderStyle: "round",
        margin: 0,
        padding: { bottom: 0, left: 2, right: 2, top: 0 },
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
const BOOLEAN_OPTIONS = new Set<string>(["all", "allow-unsafe-source", "dry-run", "json", "no-vite", "prod", "remote", "yes"]);

const LEADING_DASHES = /^-+/u;

const isOptionToken = (token: string): boolean => token.startsWith("-");

const optionTakesValue = (token: string): boolean => {
    // "--foo=bar" is self-contained, never consumes the next token.
    if (token.includes("=")) {
        return false;
    }

    // Strip leading dashes and look up against the boolean set.
    const name = token.replace(LEADING_DASHES, "");

    return !BOOLEAN_OPTIONS.has(name);
};

/**
 * Reorder argv so options appear before positionals, preserving the command
 * name in position 0. Keeps `option value` pairs together. Boolean options
 * are tracked in {@link BOOLEAN_OPTIONS} so they don't grab the following
 * positional as their value.
 *
 * For example `["init", "my-app", "-t", "vite"]` becomes
 * `["init", "-t", "vite", "my-app"]`, while `["dev", "--no-vite", "--port", "1"]`
 * is unchanged.
 */
interface ArgvBuckets {
    options: string[];
    positionals: string[];
}

/**
 * Classify one argv token into `buckets`. Returns how many entries it consumed
 * (1, or 2 when an option grabbed its value).
 */
const classifyArgvToken = (token: string, next: string | undefined, buckets: ArgvBuckets): number => {
    if (!isOptionToken(token)) {
        buckets.positionals.push(token);

        return 1;
    }

    buckets.options.push(token);

    // A value-taking option consumes the very next token as its value, even
    // when that value is dash-leading (e.g. `--search -foo`) — standard getopt
    // semantics. The `--` separator is the one exception: it's handled by the
    // caller and never belongs to an option. Boolean options (and the `=` form)
    // report `optionTakesValue === false`, so they never grab the next token.
    if (optionTakesValue(token) && next !== undefined && next !== "--") {
        buckets.options.push(next);

        return 2;
    }

    return 1;
};

const reorderArgvOptionsFirst = (argv: ReadonlyArray<string>): string[] => {
    if (argv.length <= 1) {
        return [...argv];
    }

    const [head, ...rest] = argv;
    const buckets: ArgvBuckets = { options: [], positionals: [] };

    for (let index = 0; index < rest.length; index += 1) {
        const token = rest[index];

        if (token === undefined) {
            continue;
        }

        if (token === "--") {
            // Everything after `--` is verbatim positional.
            buckets.positionals.push(...rest.slice(index));
            break;
        }

        index += classifyArgvToken(token, rest[index + 1], buckets) - 1;
    }

    return [head as string, ...buckets.options, ...buckets.positionals];
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
        footer: dim("Run `cirrus help <command>` for details on a specific command."),
        header: renderBanner(),
    });

    cli.addCommand({
        argument: { description: "Project name", name: "name", type: String },
        description: "Scaffold a new Cirrus project",
        execute: async ({ argument, options: parsed }) => {
            const name = argument[0];
            const templateRaw = parsed.template ?? "vite";
            const template: Template = isTemplate(templateRaw) ? templateRaw : "vite";
            const from = typeof parsed.from === "string" && parsed.from.length > 0 ? parsed.from : undefined;
            const source = typeof parsed.source === "string" && parsed.source.length > 0 ? parsed.source : undefined;

            const result = await runInitCommand({
                allowUnsafeSource: parsed.allowUnsafeSource === true,
                cwd,
                from,
                logger,
                name,
                source,
                templateType: template,
            });

            exitCode.value = result.code;
        },
        name: "init",
        options: [
            {
                alias: "t",
                defaultValue: "vite",
                description: "Template to scaffold (vite | standalone | tanstack-start | next)",
                name: "template",
                type: String,
            },
            {
                description: "Local templates root to copy from (offline-friendly; expects <type>/ subdirs)",
                name: "from",
                type: String,
            },
            {
                description: "Override the remote template source (e.g. gh:owner/repo/sub#ref)",
                name: "source",
                type: String,
            },
            {
                description: "Permit --source values outside gh:/github:/https:// (e.g. local file://)",
                name: "allow-unsafe-source",
                type: Boolean,
            },
        ],
    });

    cli.addCommand({
        description: "Run the dev server (Vite + wrangler, or wrangler alone)",
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
        name: "dev",
        options: [
            { description: "Port for the dev server", name: "port", type: Number },
            { description: "Skip the Vite frontend dev server", name: "no-vite", type: Boolean },
        ],
    });

    cli.addCommand({
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
        name: "codegen",
    });

    cli.addCommand({
        description: "Codegen, validate wrangler, then wrangler deploy",
        execute: async ({ options: parsed }) => {
            const result = await runDeployCommand({
                cwd,
                env: toStringOrUndefined(parsed.env),
                logger,
            });

            exitCode.value = result.code;
        },
        name: "deploy",
        options: [{ description: "Cloudflare environment name", name: "env", type: String }],
    });

    cli.addCommand({
        argument: { description: "Worker name (defaults to wrangler config)", name: "worker", type: String },
        description: "Stream live logs from a deployed Worker via wrangler tail",
        execute: async ({ argument, options: parsed }) => {
            const result = await runLogsCommand({
                cwd,
                env: toStringOrUndefined(parsed.env),
                format: toStringOrUndefined(parsed.format),
                logger,
                search: toStringOrUndefined(parsed.search),
                status: toStringOrUndefined(parsed.status),
                worker: argument[0] ?? toStringOrUndefined(parsed.worker),
            });

            exitCode.value = result.code;
        },
        name: "logs",
        options: [
            { description: "Cloudflare environment name", name: "env", type: String },
            { description: "Output format: pretty (default) | json", name: "format", type: String },
            { description: "Filter by status: ok | error | canceled", name: "status", type: String },
            { description: "Substring filter on log messages", name: "search", type: String },
        ],
    });

    cli.addCommand({
        argument: { description: "create | list | restore <id|file>", name: "subcommand", type: String },
        description: "Managed snapshot backups: create | list | restore over the export/import endpoints",
        execute: async ({ argument, options: parsed }) => {
            const sub = argument[0];

            if (!isBackupSubcommand(sub)) {
                logger.error(`backup: unknown subcommand "${sub ?? ""}" — expected create | list | restore`);
                exitCode.value = 1;

                return;
            }

            try {
                const result = await runBackupCommand({
                    cwd,
                    dir: toStringOrUndefined(parsed.dir),
                    logger,
                    prod: parsed.prod === true,
                    subcommand: sub,
                    tables: toStringOrUndefined(parsed.tables),
                    target: argument[1],
                    to: toStringOrUndefined(parsed.to),
                    token: toStringOrUndefined(parsed.token),
                    url: toStringOrUndefined(parsed.url),
                });

                exitCode.value = result.code;
            } catch (error: unknown) {
                logger.error(error instanceof Error ? error.message : String(error));
                exitCode.value = 1;
            }
        },
        name: "backup",
        options: [
            { description: "Backup directory (default .cirrus-backups)", name: "dir", type: String },
            { description: "Comma-separated table allowlist (create)", name: "tables", type: String },
            { description: "Point-in-time recovery: replay CDC up to an ISO time (restore)", name: "to", type: String },
            { description: "Target production — requires an explicit --url", name: "prod", type: Boolean },
            { description: "Worker URL (default http://localhost:8787)", name: "url", type: String },
            { description: "Admin bearer token (or CIRRUS_ADMIN_TOKEN)", name: "token", type: String },
        ],
    });

    cli.addCommand({
        argument: { description: "Function path (e.g. messages:send)", name: "functionPath", type: String },
        description: "Send a single RPC to a running Cirrus Worker",
        execute: async ({ argument, options: parsed }) => {
            const functionPathArgument = argument[0];

            if (!functionPathArgument) {
                logger.error("missing function path. Usage: cirrus run <functionPath> [--args <json>]");
                exitCode.value = 1;

                return;
            }

            try {
                const result = await runRpcCommand({
                    args: toStringOrUndefined(parsed.args),
                    cwd,
                    functionPath: functionPathArgument,
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
        name: "run",
        options: [
            { description: "JSON-encoded args object", name: "args", type: String },
            { description: "Explicit shard key", name: "shard", type: String },
            { description: "Worker URL (default http://localhost:8787)", name: "url", type: String },
        ],
    });

    cli.addCommand({
        description: "Clear local Miniflare state (and .cirrus-cache with --all)",
        execute: async ({ options: parsed }) => {
            const result = await runResetCommand({
                all: parsed.all === true,
                cwd,
                logger,
                yes: parsed.yes === true,
            });

            exitCode.value = result.code;
        },
        name: "reset",
        options: [
            { description: "Also remove .cirrus-cache", name: "all", type: Boolean },
            { description: "Skip the confirmation prompt (required when stdin is not a TTY)", name: "yes", type: Boolean },
        ],
    });

    cli.addCommand({
        argument: { description: "generate | create | up | down | status [name|id]", name: "subcommand", type: String },
        description: "Schema (generate) and online data (create | up | down | status) migrations",
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
                        yes: parsed.yes === true,
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
        name: "migrate",
        options: [
            { description: "Migration name slug (e.g. add_users_email)", name: "name", type: String },
            { description: "Target table for `create`", name: "table", type: String },
            { description: "Preview a data migration without rewriting rows", name: "dry-run", type: Boolean },
            { description: "Rows per batch for a data migration", name: "batch-size", type: Number },
            { description: "Cap batches processed this run (maps to the runner's maxBatches)", name: "steps", type: Number },
            { description: "Target production — requires an explicit --url", name: "prod", type: Boolean },
            { description: "Worker URL (default http://localhost:8787)", name: "url", type: String },
            { description: "Admin bearer token (or CIRRUS_ADMIN_TOKEN)", name: "token", type: String },
            { description: "Required with --prod for up/down — confirms running against production", name: "yes", type: Boolean },
        ],
    });

    cli.addCommand({
        argument: { description: "Optional path (alias for --out)", name: "path", type: String },
        description: "Stream NDJSON of every shard-local + global table from the worker",
        execute: async ({ argument, options: parsed }) => {
            try {
                const out = argument[0] ?? toStringOrUndefined(parsed.out);
                const result = await runExportCommand({
                    cwd,
                    logger,
                    out,
                    prod: parsed.prod === true,
                    tables: toStringOrUndefined(parsed.tables),
                    token: toStringOrUndefined(parsed.token),
                    url: toStringOrUndefined(parsed.url),
                });

                exitCode.value = result.code;
            } catch (error: unknown) {
                logger.error(error instanceof Error ? error.message : String(error));
                exitCode.value = 1;
            }
        },
        name: "export",
        options: [
            { description: "Output file path (`-` for stdout, default)", name: "out", type: String },
            { description: "Comma-separated table allowlist", name: "tables", type: String },
            { description: "Target production — requires an explicit --url", name: "prod", type: Boolean },
            { description: "Worker URL (default http://localhost:8787)", name: "url", type: String },
            { description: "Admin bearer token (or CIRRUS_ADMIN_TOKEN)", name: "token", type: String },
        ],
    });

    cli.addCommand({
        argument: { description: "Source NDJSON file", name: "file", type: String },
        description: "Bulk-insert rows from an NDJSON file via the worker's admin endpoint",
        execute: async ({ argument, options: parsed }) => {
            const file = argument[0] ?? toStringOrUndefined(parsed.file);

            if (!file) {
                logger.error("import requires a file. Usage: cirrus import <path> [--table <name>]");
                exitCode.value = 1;

                return;
            }

            try {
                const result = await runImportCommand({
                    batchSize: toNumberOrUndefined(parsed.batchSize),
                    cwd,
                    file,
                    logger,
                    prod: parsed.prod === true,
                    table: toStringOrUndefined(parsed.table),
                    token: toStringOrUndefined(parsed.token),
                    url: toStringOrUndefined(parsed.url),
                });

                exitCode.value = result.code;
            } catch (error: unknown) {
                logger.error(error instanceof Error ? error.message : String(error));
                exitCode.value = 1;
            }
        },
        name: "import",
        options: [
            { description: "Wrap each bare doc as `{table:<name>,doc:...}`", name: "table", type: String },
            { description: "Rows per HTTP request (default 500)", name: "batch-size", type: Number },
            { description: "Target production — requires an explicit --url", name: "prod", type: Boolean },
            { description: "Worker URL (default http://localhost:8787)", name: "url", type: String },
            { description: "Admin bearer token (or CIRRUS_ADMIN_TOKEN)", name: "token", type: String },
        ],
    });

    cli.addCommand({
        description: "Validate wrangler.jsonc + run codegen in dry-run mode (no files written)",
        execute: () => {
            const result = runVerifyCommand({ cwd, logger });

            exitCode.value = result.code;
        },
        name: "verify",
    });

    cli.addCommand({
        description: "Print resolved project config: @cirrus/* versions, wrangler summary, schema overview",
        execute: ({ options: parsed }) => {
            const result = runInfoCommand({ cwd, json: parsed.json === true, logger });

            exitCode.value = result.code;
        },
        name: "info",
        options: [{ description: "Emit a JSON snapshot instead of human text", name: "json", type: Boolean }],
    });

    cli.addCommand({
        argument: { description: "list | get <KEY> | set <KEY> <VALUE> | unset <KEY> | push", name: "subcommand", type: String },
        description: "Manage .dev.vars and push secrets via wrangler (list | get | set | unset | push)",
        execute: async ({ argument, options: parsed }) => {
            const sub = argument[0];

            if (!isEnvSubcommand(sub)) {
                logger.error(`env: unknown subcommand "${sub ?? ""}" — expected list | get | set | unset | push`);
                exitCode.value = 1;

                return;
            }

            try {
                const result = await runEnvCommand({
                    cwd,
                    key: argument[1],
                    logger,
                    prod: parsed.prod === true,
                    subcommand: sub,
                    value: argument[2],
                    yes: parsed.yes === true,
                });

                exitCode.value = result.code;
            } catch (error: unknown) {
                logger.error(error instanceof Error ? error.message : String(error));
                exitCode.value = 1;
            }
        },
        name: "env",
        options: [
            { description: "Target production for `push` (passes --env production to wrangler)", name: "prod", type: Boolean },
            { description: "Required for `push` — confirms uploading secrets to Cloudflare", name: "yes", type: Boolean },
        ],
    });

    cli.addCommand({
        description: "Run wrangler dry-run and report bundle size, top modules, and _generated files",
        execute: async ({ options: parsed }) => {
            try {
                const result = await runAnalyzeCommand({ cwd, json: parsed.json === true, logger });

                exitCode.value = result.code;
            } catch (error: unknown) {
                logger.error(error instanceof Error ? error.message : String(error));
                exitCode.value = 1;
            }
        },
        name: "analyze",
        options: [{ description: "Emit a JSON report instead of human text", name: "json", type: Boolean }],
    });

    cli.addCommand({
        description: "Open the Cirrus dashboard in your browser (local dev by default, --remote for production)",
        execute: async ({ options: parsed }) => {
            try {
                const result = await runViewCommand({ cwd, logger, remote: parsed.remote === true });

                exitCode.value = result.code;
            } catch (error: unknown) {
                logger.error(error instanceof Error ? error.message : String(error));
                exitCode.value = 1;
            }
        },
        name: "view",
        options: [{ description: "Open the deployed worker URL instead of localhost", name: "remote", type: Boolean }],
    });

    cli.addCommand({
        argument: { description: "Optional path under the docs site (e.g. addons/dashboard)", name: "section", type: String },
        description: "Open the Cirrus docs in your browser (optional [section] path)",
        execute: async ({ argument }) => {
            try {
                const result = await runDocsCommand({ logger, section: argument[0] });

                exitCode.value = result.code;
            } catch (error: unknown) {
                logger.error(error instanceof Error ? error.message : String(error));
                exitCode.value = 1;
            }
        },
        name: "docs",
    });

    return { cli, exitCode };
};

const HELP = `cirrus — Cirrus framework CLI

Usage: cirrus <command> [options]

Commands:
  init [name] [-t <template>]   Scaffold a new Cirrus project (templates: vite, standalone, tanstack-start, next)
       [--from <path>] [--source <src>]  Use a local templates dir or override the remote source
  dev  [--port <n>] [--no-vite] Run the dev server (Vite + wrangler, or wrangler alone)
  codegen                       Run codegen for cirrus/ functions and schema
  deploy [--env <name>]         Codegen, validate wrangler, then wrangler deploy
  logs [worker]                 Stream live logs from a deployed Worker via wrangler tail
       [--env <name>] [--format <pretty|json>] [--status <s>] [--search <q>]
  run <fn> [--args <json>]      Send a single RPC to a running Cirrus Worker
       [--shard <key>] [--url <url>]
  migrate generate [name]       Diff cirrus/schema.ts against the snapshot and emit migration SQL
  migrate create <name>         Scaffold a defineMigration block in cirrus/migrations.ts
          [--table <table>]
  migrate up|down <id>          Run a data migration across shards (forward/reverse)
          [--dry-run] [--batch-size <n>] [--steps <n>] [--prod --yes] [--url <url>] [--token <t>]
  migrate status <id>           Report a data migration's per-shard status
          [--url <url>] [--token <t>]
  export [--out <path>]         Stream NDJSON of every table from the worker
          [--tables <t1,t2,...>] [--prod] [--url <url>] [--token <t>]
  import <path> [--table <n>]   Bulk-insert NDJSON rows via the admin endpoint
          [--batch-size <n>] [--prod] [--url <url>] [--token <t>]
  backup create|list           Managed snapshot backups (export/import based);
         | restore <id|file>   restore --to <iso-time> replays CDC for point-in-time recovery
         [--to <time>]         [--dir <d>] [--tables <t1,t2>] [--prod] [--url <url>] [--token <t>]
  reset [--all] [--yes]         Clear local Miniflare state (and .cirrus-cache with --all)
  verify                        Validate wrangler.jsonc + run codegen in dry-run mode
  info [--json]                 Print resolved project config (packages, wrangler, schema)
  env <sub> [args]              Manage .dev.vars (list | get <K> | set <K> <V> | unset <K> | push --yes [--prod])
  analyze [--json]              Run wrangler dry-run and report bundle size + top modules
  view [--remote]               Open the dashboard in your browser
  docs [section]                Open the Cirrus docs in your browser

Global options:
  -h, --help                    Show this help and exit
  -v, --version                 Print the CLI version
`;

const printHelp = (): void => {
    process.stdout.write(HELP);
};

const runCli = async (options: RunCliOptions = {}): Promise<number> => {
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
    try {
        const code = await runCli();

        // eslint-disable-next-line unicorn/no-process-exit -- CLI entrypoint: propagate the resolved exit code to the shell
        process.exit(code);
    } catch (error: unknown) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        // eslint-disable-next-line unicorn/no-process-exit -- CLI entrypoint: a top-level failure must exit non-zero
        process.exit(1);
    }
}

export type { CommandName, RunCliOptions };
export { COMMANDS, runCli, VERSION };
