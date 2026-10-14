import { isRunnableTarget, resolveTargetOrThrow, runnableTargetIds } from "@lunora/config";

import type { LunoraRspackOptions, ResolvedLunoraRspackOptions } from "./types";

/**
 * `resolveTargetOrThrow`, plus the check that the resolved target is one with a
 * command-line toolchain.
 *
 * `isRunnableTarget` is the shared predicate the CLI's `deploy`/`dev` guard uses,
 * so the two cannot drift. `resolveTargetOrThrow` accepts a codegen-only target
 * like `node` — legitimately, since generating for it is meaningful — so without
 * this check the build would go on to emit the wrong surface silently.
 */
const resolveRunnableTargetOrThrow = (projectRoot: string, explicit?: string): string => {
    const target = resolveTargetOrThrow(projectRoot, explicit);

    if (!isRunnableTarget(target)) {
        throw new Error(
            `target "${target}" has no command-line toolchain, so the Lunora Rspack plugin cannot build for it — it can only generate for it (\`lunora codegen --target ${target}\`). Buildable targets: ${runnableTargetIds().join(", ")}`,
        );
    }

    return target;
};

/** Merge the user's options with the defaults, validating the deploy target. */
const resolveOptions = (options: LunoraRspackOptions | undefined): ResolvedLunoraRspackOptions => {
    const input = options ?? {};
    const projectRoot = input.projectRoot ?? process.cwd();

    return {
        apiSpec: input.apiSpec ?? "openapi",
        projectRoot,
        schemaDir: input.schemaDir ?? "lunora",
        // Same resolution AND validation as the CLI — explicit option, then
        // `lunora.config.*`, then the default — so a project that sets `target`
        // once gets it in `rspack build` and `lunora deploy` alike, and a typo
        // fails here rather than emitting the default surface silently.
        target: resolveRunnableTargetOrThrow(projectRoot, input.target),
        validateWrangler: input.validateWrangler ?? true,
    };
};

export { resolveOptions, resolveRunnableTargetOrThrow };
