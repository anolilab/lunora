import { spawnSync } from "node:child_process";

import { lunoraLine } from "@lunora/config";
import type { WranglerConfig } from "@lunora/config/cloudflare";
import { assertWranglerSatisfiesSchema, findWranglerFile, readWranglerJsonc } from "@lunora/config/cloudflare";
import type { Plugin } from "vite";

import type { ResolvedLunoraPluginOptions } from "./types";

/** Mirrors the config-layer heuristic: a container image that is a local path. */
const isLocalImagePath = (image: string): boolean => image.startsWith("./") || image.startsWith("../") || image.startsWith("/") || image.includes("Dockerfile");

/**
 * Warn (never throw) when the project declares Dockerfile-built containers but
 * no Docker-compatible engine answers. The Cloudflare plugin builds and runs
 * containers during `vite dev`, so without Docker the dev server would die
 * later with an opaque engine error — surface the actionable hint up front.
 * Containers may also be deliberately disabled (`dev.enable_containers`), so
 * this must stay advisory.
 */
const probeDocker = (): boolean => {
    try {
        // eslint-disable-next-line sonarjs/no-os-command-from-path -- `docker` must resolve from PATH (Docker Desktop/Colima install locations vary); args are fixed and no shell is involved
        return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
    } catch {
        return false;
    }
};

const warnWhenDockerMissing = (wranglerPath: string, dockerAvailable: () => boolean = probeDocker): void => {
    const { parsed } = readWranglerJsonc<WranglerConfig>(wranglerPath);
    const needsDocker = (parsed?.containers ?? []).some((entry) => typeof entry?.image === "string" && isLocalImagePath(entry.image));

    if (!needsDocker || dockerAvailable()) {
        return;
    }

    // eslint-disable-next-line no-console
    console.warn(
        lunoraLine(
            "wrangler.jsonc declares containers built from a local Dockerfile, but no Docker-compatible engine is running. Start Docker (or Colima) before `vite dev`, or the container instances will fail to start.",
        ),
    );
};

/**
 * Vite plugin that validates the project's `wrangler.jsonc` against the
 * bindings implied by `lunora/schema.ts`. Throws (Vite renders nicely) on
 * missing requirements during `configResolved`. Delegates the parsing /
 * validation logic to `@lunora/config` so the rules stay in lockstep with
 * the CLI (`lunora deploy`).
 *
 * Provisioning runs BEFORE this, in `bindingsProvisionPlugin`'s `config` hook,
 * which is the order `lunora dev` uses (infer → reconcile, no validation pass):
 * the bindings this check requires are the ones Lunora writes itself, so
 * validating first killed the dev server the first time a project declared a
 * `.global()` table or a container. That plugin is registered unconditionally and
 * ahead of this one — the write is not optional the way the check is, and it must
 * land in `config` to reach the worker at all (see its docblock).
 *
 * Skipped under `vite preview`, which resolves with `command: "serve"` and so
 * runs `apply: "serve"` plugins: previewing a built app must not probe Docker.
 */
const wranglerValidatorPlugin = (options: ResolvedLunoraPluginOptions): Plugin => {
    let isPreview = false;

    return {
        // `isPreview` is on the config-hook env only — never on the resolved config.
        config(_userConfig, env) {
            isPreview = env.isPreview === true;
        },
        configResolved() {
            if (isPreview) {
                return;
            }

            // Shared with `@lunora/rspack` — same rules, same messages, only the
            // closing remedy differs.
            assertWranglerSatisfiesSchema(
                options,
                (message) => {
                    // eslint-disable-next-line no-console
                    console.warn(message);
                },
                "Update your wrangler.jsonc and restart the dev server.",
            );

            const wranglerPath = findWranglerFile(options.projectRoot);

            if (wranglerPath !== undefined) {
                warnWhenDockerMissing(wranglerPath);
            }
        },
        enforce: "pre",
        name: "lunora:wrangler-validator",
    };
};

// `warnWhenDockerMissing` is exported for tests (the docker probe is injectable there).
export { warnWhenDockerMissing, wranglerValidatorPlugin };
