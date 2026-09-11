import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { detectPackageManager, execArgsFor } from "../../util/detect-package-manager";
import { EXIT_CODE } from "../../util/exit-code";
import type { Logger } from "../../util/logger";
import type { OutputFormat } from "../../util/output-format";
import type { SpawnDescriptor, Spawner } from "../../util/spawn";
import { defaultSpawner } from "../../util/spawn";
import type { DeploymentsOptions } from "./index";

type DeploymentsSubcommand = "inspect" | "list" | "promote" | "rollback";

interface DeploymentsCommandOptions {
    cwd?: string;
    /** Cloudflare environment name (`--env`). */
    env?: string;
    /** Output format: `pretty` (default) or `json`. Only `list` has a JSON rendering. */
    format?: OutputFormat;
    logger: Logger;
    /** Reason recorded with rollback / promote. */
    message?: string;
    spawner?: Spawner;
    subcommand: DeploymentsSubcommand;
    /** Worker version id — required for `inspect`/`promote`, optional for `rollback`. */
    versionId?: string;
    /** Confirms rollback / promote (they shift live traffic). */
    yes?: boolean;
}

interface DeploymentsCommandResult {
    code: number;

    /**
     * True once `wrangler deployments list --json` has been spawned: wrangler
     * writes that document to stdout itself, so the CLI must not add a second.
     */
    delegated?: boolean;
    descriptor: SpawnDescriptor | undefined;
    /** Set when the run aborted before spawning wrangler. */
    error?: string;
}

/** Append `--env <env>` when an environment was given. */
const withEnv = (args: string[], env: string | undefined): string[] => {
    if (env !== undefined) {
        args.push("--env", env);
    }

    return args;
};

/** Build the wrangler argv for `list`. */
const buildListArgs = (options: DeploymentsCommandOptions): string[] => {
    const args = withEnv(["deployments", "list"], options.env);

    // `wrangler deployments list --json` writes the document to stdout itself —
    // there is nothing for the CLI to re-serialize, so `--format json` forwards
    // the flag rather than wrapping wrangler output in a shape of its own.
    if (options.format === "json") {
        args.push("--json");
    }

    return args;
};

/**
 * Build the wrangler argv for a subcommand, or an error message when a required
 * argument / confirmation is missing.
 */
const buildArgs = (options: DeploymentsCommandOptions): { args?: string[]; error?: string } => {
    switch (options.subcommand) {
        case "inspect": {
            if (options.versionId === undefined) {
                return { error: "deployments inspect requires a version id. Usage: lunora deployments inspect <version-id>" };
            }

            return { args: withEnv(["versions", "view", options.versionId], options.env) };
        }
        case "list": {
            return { args: buildListArgs(options) };
        }
        case "promote": {
            if (options.versionId === undefined) {
                return { error: "deployments promote requires a version id. Usage: lunora deployments promote <version-id> --yes" };
            }

            if (!options.yes) {
                return { error: "deployments promote shifts 100% of live traffic. Re-run with --yes to confirm." };
            }

            // `versions deploy <id>@100%` makes one version fully live; `-y` accepts the prompts.
            const args = withEnv(["versions", "deploy", `${options.versionId}@100%`, "--yes"], options.env);

            if (options.message !== undefined) {
                args.push("--message", options.message);
            }

            return { args };
        }
        case "rollback": {
            if (!options.yes) {
                return { error: "deployments rollback changes the live version. Re-run with --yes to confirm." };
            }

            const args = withEnv(["rollback"], options.env);

            if (options.versionId !== undefined) {
                args.push(options.versionId);
            }

            args.push("--yes");

            if (options.message !== undefined) {
                args.push("--message", options.message);
            }

            return { args };
        }
        default: {
            return { error: `deployments: unknown subcommand "${options.subcommand as string}"` };
        }
    }
};

const runDeploymentsCommand = async (options: DeploymentsCommandOptions): Promise<DeploymentsCommandResult> => {
    // Only `list` has a document. Refused rather than ignored: a caller that
    // pipes `deployments rollback --format json` into a parser would otherwise
    // get wrangler's prose and a zero exit.
    if (options.format === "json" && options.subcommand !== "list") {
        const unsupported = `deployments ${options.subcommand}: --format json is only available for \`deployments list\` — wrangler has no JSON rendering for the others.`;

        options.logger.error(unsupported);

        // Same class as an unknown `--format`: the invocation asks for something
        // this subcommand cannot do, so it exits USAGE like every other refusal
        // of a flag value.
        return { code: EXIT_CODE.USAGE, descriptor: undefined, error: unsupported };
    }

    const { args, error } = buildArgs(options);

    if (error !== undefined || args === undefined) {
        options.logger.error(error ?? "deployments: nothing to run");

        return { code: 1, descriptor: undefined, error };
    }

    // In json mode the echoed invocation moves to stderr so wrangler's document
    // is the only thing on stdout.
    const { logger } = options;
    const cwd = options.cwd ?? process.cwd();
    const exec = execArgsFor(detectPackageManager(cwd), "wrangler", args);
    const descriptor: SpawnDescriptor = { args: exec.args, command: exec.command, cwd };

    logger.info(`${descriptor.command} ${descriptor.args.join(" ")}`);

    const spawner = options.spawner ?? defaultSpawner;
    const result = await spawner(descriptor);

    // `list --json` puts wrangler's own document on stdout (see `buildListArgs`),
    // so this run's stdout is already spoken for.
    return { code: result.code, delegated: options.format === "json", descriptor };
};

/** Narrow a raw argument to a known {@link DeploymentsSubcommand}. */
const isDeploymentsSubcommand = (value: unknown): value is DeploymentsSubcommand =>
    value === "list" || value === "inspect" || value === "rollback" || value === "promote";

/** `lunora deployments <subcommand>` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<DeploymentsOptions> = defineHandler<DeploymentsOptions>(({ argument, cwd, format, logger, options }) => {
    const sub = argument[0];

    if (!isDeploymentsSubcommand(sub)) {
        const message = `deployments: unknown subcommand "${sub ?? ""}" — expected list | inspect | rollback | promote`;

        logger.error(message);

        return { code: EXIT_CODE.USAGE, error: message };
    }

    return runDeploymentsCommand({
        cwd,
        env: options.env,
        format,
        logger,
        message: options.message,
        subcommand: sub,
        versionId: argument[1],
        yes: options.yes === true,
    });
});

export { execute };
export type { DeploymentsCommandOptions, DeploymentsCommandResult, DeploymentsSubcommand };
export { runDeploymentsCommand };
