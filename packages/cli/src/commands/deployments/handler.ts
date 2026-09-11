import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { detectPackageManager, execArgsFor } from "../../util/detect-package-manager";
import type { Logger } from "../../util/logger";
import { isJsonFormat, loggerForFormat, validateOutputFormat } from "../../util/output-format";
import type { SpawnDescriptor, Spawner } from "../../util/spawn";
import { defaultSpawner } from "../../util/spawn";
import type { DeploymentsOptions } from "./index";

type DeploymentsSubcommand = "inspect" | "list" | "promote" | "rollback";

interface DeploymentsCommandOptions {
    cwd?: string;
    /** Cloudflare environment name (`--env`). */
    env?: string;
    /** Output format: `pretty` (default) or `json`. Only `list` has a JSON rendering. */
    format?: string;
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
    if (isJsonFormat(options.format)) {
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
    const formatError = validateOutputFormat("deployments", options.format);

    if (formatError !== undefined) {
        options.logger.error(formatError);

        return { code: 1, descriptor: undefined, error: formatError };
    }

    // Only `list` has a document. Refused rather than ignored: a caller that
    // pipes `deployments rollback --format json` into a parser would otherwise
    // get wrangler's prose and a zero exit.
    if (isJsonFormat(options.format) && options.subcommand !== "list") {
        const unsupported = `deployments ${options.subcommand}: --format json is only available for \`deployments list\` — wrangler has no JSON rendering for the others.`;

        options.logger.error(unsupported);

        return { code: 1, descriptor: undefined, error: unsupported };
    }

    const { args, error } = buildArgs(options);

    if (error !== undefined || args === undefined) {
        options.logger.error(error ?? "deployments: nothing to run");

        return { code: 1, descriptor: undefined, error };
    }

    // In json mode the echoed invocation moves to stderr so wrangler's document
    // is the only thing on stdout.
    const logger = loggerForFormat(options.format, options.logger);
    const cwd = options.cwd ?? process.cwd();
    const exec = execArgsFor(detectPackageManager(cwd), "wrangler", args);
    const descriptor: SpawnDescriptor = { args: exec.args, command: exec.command, cwd };

    logger.info(`${descriptor.command} ${descriptor.args.join(" ")}`);

    const spawner = options.spawner ?? defaultSpawner;
    const result = await spawner(descriptor);

    return { code: result.code, descriptor };
};

/** Narrow a raw argument to a known {@link DeploymentsSubcommand}. */
const isDeploymentsSubcommand = (value: unknown): value is DeploymentsSubcommand =>
    value === "list" || value === "inspect" || value === "rollback" || value === "promote";

/** `lunora deployments <subcommand>` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<DeploymentsOptions> = defineHandler<DeploymentsOptions>(({ argument, cwd, logger, options }) => {
    const sub = argument[0];

    if (!isDeploymentsSubcommand(sub)) {
        logger.error(`deployments: unknown subcommand "${sub ?? ""}" — expected list | inspect | rollback | promote`);

        return { code: 1 };
    }

    return runDeploymentsCommand({
        cwd,
        env: options.env,
        format: options.format,
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
