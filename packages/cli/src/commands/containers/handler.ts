import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { DockerProbe } from "../../util/docker";
import { isDockerAvailable } from "../../util/docker";
import type { Logger } from "../../util/logger";
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

interface ContainersCommandOptions {
    argument: ReadonlyArray<string>;
    cwd?: string;
    /** Docker-availability probe injected in tests. Defaults to a real `docker info` check. */
    dockerAvailable?: DockerProbe;
    env?: string;
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

        return { code: 1 };
    }

    if (NEEDS_DOCKER.has(subcommand) && !(options.dockerAvailable ?? isDockerAvailable)()) {
        options.logger.error(
            `containers ${subcommand} needs a running Docker-compatible engine (it builds/pushes images locally). Start Docker or Colima and retry. Note: container images must target linux/amd64.`,
        );

        return { code: 1 };
    }

    const args = ["exec", "wrangler", "containers", subcommand, ...rest];

    if (options.tag !== undefined) {
        args.push("--tag", options.tag);
    }

    if (options.push === true) {
        args.push("--push");
    }

    if (options.env !== undefined) {
        args.push("--env", options.env);
    }

    const descriptor: SpawnDescriptor = { args, command: "pnpm", cwd: options.cwd ?? process.cwd() };

    options.logger.info(`running ${descriptor.command} ${descriptor.args.join(" ")}`);

    const spawner = options.spawner ?? defaultSpawner;
    const result = await spawner(descriptor);

    return { code: result.code, descriptor };
};

/** `lunora containers` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<ContainersOptions> = defineHandler<ContainersOptions>(async ({ argument, cwd, logger, options }) => {
    const result = await runContainersCommand({
        argument,
        cwd,
        env: options.env,
        logger,
        push: options.push === true,
        tag: options.tag,
    });

    return { code: result.code };
});

export type { ContainersCommandOptions, ContainersCommandResult };
export { execute, runContainersCommand };
