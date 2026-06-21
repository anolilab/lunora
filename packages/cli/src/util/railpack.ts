import { containerBuildTag } from "@lunora/container";

import type { DockerProbe } from "./docker";
import { isRailpackAvailable } from "./docker";
import type { Logger } from "./logger";
import type { SpawnDescriptor, Spawner } from "./spawn";
import { defaultSpawner } from "./spawn";

/** One Railpack-built container to build + push before deploy. */
interface RailpackBuildTarget {
    /** Source directory Railpack builds (the `{ build }` value). */
    buildDir: string;
    /** The `lunora/containers.ts` export name. */
    exportName: string;
}

interface RailpackBuildOptions {
    cwd: string;
    logger: Logger;
    /** Railpack-availability probe injected in tests. Defaults to a real `railpack --version` + `BUILDKIT_HOST` check. */
    railpackAvailable?: DockerProbe;
    spawner?: Spawner;
    targets: ReadonlyArray<RailpackBuildTarget>;
}

interface RailpackBuildResult {
    /** Local image tags built + pushed, in target order. */
    builtTags: string[];
    /** Exit code: 0 on success (or no targets), non-zero on the first failure. */
    code: number;
    /** Set when the build was blocked or a step failed. */
    error?: string;
}

/**
 * Build each `{ build }` container with Railpack and push it to the Cloudflare
 * Registry, so `wrangler deploy` can reference the pushed tag. Each target is
 * built under {@link containerBuildTag}'s deterministic tag — the same tag the
 * config reconciler writes as the wrangler `containers[].image`, so the three
 * stay in lockstep.
 *
 * Runs through the injected {@link Spawner} (so it's unit-testable without a
 * real Railpack/BuildKit), and preflights that Railpack + a `BUILDKIT_HOST` are
 * available before touching anything — Railpack needs a BuildKit endpoint, so a
 * missing one is a one-line directive rather than an opaque build failure.
 */
const buildRailpackImages = async (options: RailpackBuildOptions): Promise<RailpackBuildResult> => {
    if (options.targets.length === 0) {
        return { builtTags: [], code: 0 };
    }

    if (!(options.railpackAvailable ?? isRailpackAvailable)()) {
        const message =
            "deploy blocked: a container uses `image: { build }` (Railpack), but Railpack isn't ready. Install the `railpack` CLI and start a BuildKit instance, e.g. " +
            // eslint-disable-next-line no-secrets/no-secrets -- a documented BuildKit setup command, not a credential
            "`docker run --rm --privileged -d --name buildkit moby/buildkit` then `export BUILDKIT_HOST=docker-container://buildkit`. " +
            "Alternatively switch the container's `image` to a Dockerfile path or a pre-built registry reference.";

        options.logger.error(message);

        return { builtTags: [], code: 1, error: message };
    }

    const spawner = options.spawner ?? defaultSpawner;
    const builtTags: string[] = [];

    for (const target of options.targets) {
        const tag = containerBuildTag(target.exportName);

        const build: SpawnDescriptor = { args: ["build", target.buildDir, "--name", tag], command: "railpack", cwd: options.cwd };
        const push: SpawnDescriptor = { args: ["exec", "wrangler", "containers", "push", tag], command: "pnpm", cwd: options.cwd };

        options.logger.info(`railpack: building "${target.exportName}" → ${tag} from ${target.buildDir}`);
        // eslint-disable-next-line no-await-in-loop -- sequential: build must finish before push, and one target before the next
        const buildResult = await spawner(build);

        if (buildResult.code !== 0) {
            const message = `railpack build failed for container "${target.exportName}" (${target.buildDir})`;

            options.logger.error(message);

            return { builtTags, code: buildResult.code, error: message };
        }

        options.logger.info(`railpack: pushing ${tag} to the Cloudflare Registry`);
        // eslint-disable-next-line no-await-in-loop -- sequential: see above
        const pushResult = await spawner(push);

        if (pushResult.code !== 0) {
            const message = `wrangler containers push failed for "${target.exportName}" (${tag})`;

            options.logger.error(message);

            return { builtTags, code: pushResult.code, error: message };
        }

        builtTags.push(tag);
    }

    return { builtTags, code: 0 };
};

export type { RailpackBuildOptions, RailpackBuildResult, RailpackBuildTarget };
export { buildRailpackImages };
