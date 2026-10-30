import { detectPackageManager, execArgsFor } from "../../../util/detect-package-manager";
import { EXIT_CODE } from "../../../util/exit-code";
import type { Logger } from "../../../util/logger";
import type { OutputFormat } from "../../../util/output-format";
import type { SpawnDescriptor, Spawner } from "../../../util/spawn";
import { defaultSpawner } from "../../../util/spawn";

type DeploymentsSubcommand = "inspect" | "list" | "promote" | "rollback" | "status";

interface DeploymentsCommandOptions {
    /** `promote --percent` below 100: confirms both versions can share one Durable Object database. */
    confirmSharedState?: boolean;
    cwd?: string;
    /** Cloudflare environment name (`--env`). */
    env?: string;
    /** Output format: `pretty` (default) or `json`. `list` and `status` have a JSON rendering. */
    format?: OutputFormat;
    /** `promote --percent` below 100: the live version that keeps the remaining traffic. */
    from?: string;
    logger: Logger;
    /** Reason recorded with rollback / promote. */
    message?: string;
    /** `promote`: whole-number share of traffic for the version, 1–100 (default 100). */
    percent?: number;
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
     * True once `wrangler deployments list|status --json` has been spawned: wrangler
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

/**
 * Build the wrangler argv for `list` or `status`. Both print a document that
 * wrangler can render as JSON itself, so `--format json` forwards the flag
 * rather than wrapping wrangler output in a shape of its own.
 */
const buildReadArgs = (options: DeploymentsCommandOptions, subcommand: "list" | "status"): string[] => {
    const args = withEnv(["deployments", subcommand], options.env);

    if (options.format === "json") {
        args.push("--json");
    }

    return args;
};

/** The wrangler argv for one subcommand, or the refusal that stops it from running. */
interface ArgsResult {
    args?: string[];
    error?: string;
}

/**
 * `versions deploy <id>@N% <live>@(100-N)%`: the promoted version takes N% of
 * traffic and the named live version keeps the rest. Both versions run against
 * one Durable Object database during the split, and wrangler does not say whether
 * their schemas or migrations match, so the split waits for an explicit
 * `--confirm-shared-state`.
 */
const buildSplitArgs = (options: DeploymentsCommandOptions, versionId: string, percent: number): ArgsResult => {
    if (options.from === undefined) {
        return {
            error: `deployments promote --percent below 100 needs --from <live-version-id>, the version that keeps the other ${String(100 - percent)}% of traffic. List them with \`lunora cloudflare deployments list\`.`,
        };
    }

    if (options.from === versionId) {
        return { error: "deployments promote --from must name a different version than the one being promoted." };
    }

    if (options.confirmSharedState !== true) {
        return {
            error: "A partial promote runs two versions against one Durable Object database. Wrangler does not report whether their schemas or migrations match, so re-run with --confirm-shared-state once you have checked both. Durable Object class migrations must go out at 100%.",
        };
    }

    return {
        args: withEnv(["versions", "deploy", `${versionId}@${String(percent)}%`, `${options.from}@${String(100 - percent)}%`, "--yes"], options.env),
    };
};

/** `promote`: the whole-version move at 100%, or a split of traffic between two versions. */
const buildPromoteArgs = (options: DeploymentsCommandOptions, versionId: string): ArgsResult => {
    const percent = options.percent ?? 100;

    if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
        return { error: `deployments promote --percent must be a whole number from 1 to 100, got ${String(percent)}.` };
    }

    if (!options.yes) {
        return { error: `deployments promote shifts ${String(percent)}% of live traffic. Re-run with --yes to confirm.` };
    }

    if (percent < 100) {
        return buildSplitArgs(options, versionId, percent);
    }

    if (options.from !== undefined) {
        return { error: "deployments promote --from applies only to a partial promote (--percent below 100)." };
    }

    // `versions deploy <id>@100%` makes one version fully live; `-y` accepts the prompts.
    return { args: withEnv(["versions", "deploy", `${versionId}@100%`, "--yes"], options.env) };
};

/** `--percent`, `--from` and `--confirm-shared-state` only mean something to `promote`. */
const splitFlagOutsidePromote = (options: DeploymentsCommandOptions): string | undefined => {
    if (options.subcommand === "promote" || (options.percent === undefined && options.from === undefined && options.confirmSharedState !== true)) {
        return undefined;
    }

    return `deployments ${options.subcommand}: --percent, --from and --confirm-shared-state apply to deployments promote only.`;
};

/**
 * Build the wrangler argv for a subcommand, or an error message when a required
 * argument / confirmation is missing.
 */
const buildArgs = (options: DeploymentsCommandOptions): ArgsResult => {
    const misplaced = splitFlagOutsidePromote(options);

    if (misplaced !== undefined) {
        return { error: misplaced };
    }

    switch (options.subcommand) {
        case "inspect": {
            if (options.versionId === undefined) {
                return { error: "deployments inspect requires a version id. Usage: lunora cloudflare deployments inspect <version-id>" };
            }

            return { args: withEnv(["versions", "view", options.versionId], options.env) };
        }
        case "list":
        case "status": {
            return { args: buildReadArgs(options, options.subcommand) };
        }
        case "promote": {
            if (options.versionId === undefined) {
                return { error: "deployments promote requires a version id. Usage: lunora cloudflare deployments promote <version-id> --yes" };
            }

            const { args, error } = buildPromoteArgs(options, options.versionId);

            if (args === undefined || options.message === undefined) {
                return { args, error };
            }

            args.push("--message", options.message);

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

/** The version ids in `wrangler deployments status --json` (`versions[].version_id`), or `undefined` when the document is not that shape. */
const liveVersionIds = (stdout: string | undefined): string[] | undefined => {
    let document: unknown;

    try {
        document = JSON.parse(stdout ?? "");
    } catch {
        return undefined;
    }

    const versions = (document as { versions?: unknown } | null)?.versions;

    if (!Array.isArray(versions)) {
        return undefined;
    }

    return versions.flatMap((entry: unknown) => {
        const id = (entry as { version_id?: unknown } | null)?.version_id;

        return typeof id === "string" ? [id] : [];
    });
};

/**
 * A partial promote hands `--from` the rest of the traffic, so it must be live now: a stale id
 * would split traffic onto a version that no longer serves it. Refuses when the current
 * deployment cannot be read, rather than splitting blind.
 */
const checkFromIsLive = async (options: DeploymentsCommandOptions, spawner: Spawner, cwd: string): Promise<DeploymentsCommandResult | undefined> => {
    const exec = execArgsFor(detectPackageManager(cwd), "wrangler", withEnv(["deployments", "status", "--json"], options.env));
    const status = await spawner({ args: exec.args, captureStdoutSilently: true, command: exec.command, cwd });
    const live = status.code === 0 ? liveVersionIds(status.stdout) : undefined;

    if (live === undefined) {
        const error =
            "deployments promote --from: could not read the live deployment (`wrangler deployments status`), so --from cannot be verified. Nothing was changed.";

        options.logger.error(error);

        return { code: EXIT_CODE.FAILURE, descriptor: undefined, error };
    }

    if (options.from !== undefined && !live.includes(options.from)) {
        const error = `deployments promote --from ${options.from} is not a live version (live: ${live.join(", ") || "none"}). Check \`lunora cloudflare deployments status\`.`;

        options.logger.error(error);

        return { code: EXIT_CODE.USAGE, descriptor: undefined, error };
    }

    return undefined;
};

const runDeploymentsCommand = async (options: DeploymentsCommandOptions): Promise<DeploymentsCommandResult> => {
    // Only `list` and `status` have a document. Refused rather than ignored: a caller that
    // pipes `deployments rollback --format json` into a parser would otherwise
    // get wrangler's prose and a zero exit.
    if (options.format === "json" && options.subcommand !== "list" && options.subcommand !== "status") {
        const unsupported = `deployments ${options.subcommand}: --format json is only available for \`deployments list\` and \`deployments status\` — wrangler has no JSON rendering for the others.`;

        options.logger.error(unsupported);

        // Same class as an unknown `--format`: the invocation asks for something
        // this subcommand cannot do, so it exits USAGE like every other refusal
        // of a flag value.
        return { code: EXIT_CODE.USAGE, descriptor: undefined, error: unsupported };
    }

    const { args, error } = buildArgs(options);

    if (error !== undefined || args === undefined) {
        options.logger.error(error ?? "deployments: nothing to run");

        return { code: EXIT_CODE.USAGE, descriptor: undefined, error };
    }

    // In json mode the echoed invocation moves to stderr so wrangler's document
    // is the only thing on stdout.
    const { logger } = options;
    const cwd = options.cwd ?? process.cwd();

    if (options.subcommand === "promote" && options.from !== undefined) {
        const refusal = await checkFromIsLive(options, options.spawner ?? defaultSpawner, cwd);

        if (refusal !== undefined) {
            return refusal;
        }
    }

    const exec = execArgsFor(detectPackageManager(cwd), "wrangler", args);
    const descriptor: SpawnDescriptor = { args: exec.args, command: exec.command, cwd };

    logger.info(`${descriptor.command} ${descriptor.args.join(" ")}`);

    const spawner = options.spawner ?? defaultSpawner;
    const result = await spawner(descriptor);

    // `list --json` and `status --json` put wrangler's own document on stdout
    // (see `buildReadArgs`), so this run's stdout is already spoken for.
    return { code: result.code, delegated: options.format === "json", descriptor };
};

/** Narrow a raw argument to a known {@link DeploymentsSubcommand}. */
const isDeploymentsSubcommand = (value: unknown): value is DeploymentsSubcommand =>
    value === "list" || value === "inspect" || value === "rollback" || value === "promote" || value === "status";

export type { DeploymentsCommandOptions, DeploymentsCommandResult, DeploymentsSubcommand };
export { isDeploymentsSubcommand, runDeploymentsCommand };
