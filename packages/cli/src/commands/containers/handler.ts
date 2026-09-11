import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { detectPackageManager, execArgsFor } from "../../util/detect-package-manager";
import type { DockerProbe } from "../../util/docker";
import { isDockerAvailable } from "../../util/docker";
import { EXIT_CODE } from "../../util/exit-code";
import type { Logger } from "../../util/logger";
import type { OutputFormat } from "../../util/output-format";
import type { SpawnDescriptor, Spawner } from "../../util/spawn";
import { defaultSpawner } from "../../util/spawn";
import type { ContainersOptions } from "./index";

/**
 * The `wrangler containers` subcommands we forward. Image management (`build`,
 * `push`, `images`) is the deploy-adjacent set the docs lean on; instance
 * management (`list`, `info`, `delete`) rounds out day-2 operations.
 */
const SUBCOMMANDS = new Set(["build", "delete", "images", "info", "list", "push"]);

/** Subcommands that drive the local Docker engine and need it running. */
const NEEDS_DOCKER = new Set(["build", "push"]);

/**
 * The read subcommands `wrangler containers` can answer as JSON. They write the
 * document to stdout themselves, so `--format json` forwards `--json` rather than
 * wrapping wrangler's output in a shape of its own — the same thing
 * `deployments list` does. The write subcommands (`build`, `push`, `delete`) have
 * no JSON rendering upstream and nothing structured of Lunora's own to report, so
 * `--format json` is refused there rather than given an invented shape.
 */
const JSON_CAPABLE = new Set(["images list", "info", "list"]);

interface ContainersCommandOptions {
    argument: ReadonlyArray<string>;
    cwd?: string;
    /** Docker-availability probe injected in tests. Defaults to a real `docker info` check. */
    dockerAvailable?: DockerProbe;
    env?: string;
    /** Output format: `pretty` (default) or `json`. */
    format?: OutputFormat;
    logger: Logger;
    push?: boolean;
    spawner?: Spawner;
    tag?: string;
}

interface ContainersCommandResult {
    code: number;
    /** The forwarded wrangler invocation, when one was spawned. */
    descriptor?: SpawnDescriptor;
}

/**
 * Forward a `lunora containers …` invocation to `wrangler containers …`,
 * preserving positional arguments and mapping the curated options. Build/push
 * get a Docker preflight so the failure is a one-line directive instead of a
 * wrangler stack trace.
 */
const runContainersCommand = async (options: ContainersCommandOptions): Promise<ContainersCommandResult> => {
    const [subcommand, ...rest] = options.argument;
    if (subcommand === undefined || !SUBCOMMANDS.has(subcommand)) {
        options.logger.error(
            `lunora containers requires a subcommand: ${[...SUBCOMMANDS].toSorted((a, b) => a.localeCompare(b)).join(" | ")}. Example: lunora containers build ./containers/app --tag app:v1 --push`,
        );

        return { code: EXIT_CODE.USAGE };
    }

    const json = options.format === "json";
    // `images` is a namespace, not a verb: `images list` answers as JSON and
    // `images delete` does not, so the check keys off the full path.
    const verb = subcommand === "images" ? `images ${rest[0] ?? ""}`.trim() : subcommand;

    // Ahead of the Docker preflight, and that order is the contract, not a
    // detail. `containers build --format json` is a refusable invocation on
    // every machine — the flag combination is unsatisfiable whether or not an
    // engine is running. Checking Docker first made the SAME command answer
    // exit 2 on a developer's laptop and exit 1 "start Docker" in a container
    // build step, so automation could not tell "fix the flag" from "provision
    // the runner". Invocation-shaped refusals go before environment probes.
    if (json && !JSON_CAPABLE.has(verb)) {
        options.logger.error(
            `containers ${verb}: --format json is only available for the read subcommands (${[...JSON_CAPABLE].toSorted((a, b) => a.localeCompare(b)).join(" | ")}) — wrangler has no JSON rendering for the rest.`,
        );

        // Same class as an unknown `--format`: a flag value this subcommand
        // cannot honour is a usage error, not a runtime failure.
        return { code: EXIT_CODE.USAGE };
    }

    if (NEEDS_DOCKER.has(subcommand) && !(options.dockerAvailable ?? isDockerAvailable)()) {
        options.logger.error(
            `containers ${subcommand} needs a running Docker-compatible engine (it builds/pushes images locally). Start Docker or Colima and retry. Note: container images must target linux/amd64.`,
        );

        return { code: EXIT_CODE.MISSING_DEPENDENCY };
    }

    const args = ["containers", subcommand, ...rest];

    if (json) {
        args.push("--json");
    }

    if (options.tag !== undefined) {
        args.push("--tag", options.tag);
    }

    if (options.push === true) {
        args.push("--push");
    }

    if (options.env !== undefined) {
        args.push("--env", options.env);
    }

    const cwd = options.cwd ?? process.cwd();
    const exec = execArgsFor(detectPackageManager(cwd), "wrangler", args);
    const descriptor: SpawnDescriptor = { args: exec.args, command: exec.command, cwd };

    // In json mode the echoed invocation moves to stderr so wrangler's document
    // is the only thing on stdout.
    options.logger.info(`running ${descriptor.command} ${descriptor.args.join(" ")}`);

    const spawner = options.spawner ?? defaultSpawner;
    const result = await spawner(descriptor);

    return { code: result.code, descriptor };
};

/** `lunora containers` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<ContainersOptions> = defineHandler<ContainersOptions>(async ({ argument, cwd, format, logger, options }) => {
    const result = await runContainersCommand({
        argument,
        cwd,
        env: options.env,
        format,
        logger,
        push: options.push === true,
        tag: options.tag,
    });

    return { code: result.code };
});

export type { ContainersCommandOptions, ContainersCommandResult };
export { execute, runContainersCommand };
