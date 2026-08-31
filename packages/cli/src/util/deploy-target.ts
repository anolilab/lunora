/**
 * The `--target` flag, shared by every command that resolves a deploy target
 * (plan 114 §5.3/§5.5).
 *
 * One descriptor rather than a copy per command, so the help text can list the
 * targets actually registered instead of a hand-maintained string that drifts
 * the moment a driver lands.
 *
 * A command that omits the flag is not target-neutral — it is pinned to the
 * default. Anything that resolves a `DeployDriver` or emits a `ctx.*` surface
 * needs it; see `resolveProjectTarget` in `@lunora/config` for why those two
 * must agree.
 */
import { DEFAULT_DEPLOY_TARGET, deployTargetIds, resolveDeployDriver, resolveTargetOrThrow } from "@lunora/config";

/**
 * Human-readable list of registered targets, for help text and errors.
 *
 * The `(default …)` suffix is dropped while only one target is registered,
 * where it would render as the redundant `cloudflare (default cloudflare)`.
 */
const TARGET_HELP = (() => {
    const ids = deployTargetIds();

    return ids.length > 1 ? `${ids.join(" | ")} (default ${DEFAULT_DEPLOY_TARGET})` : ids.join(" | ");
})();

/** The `--target` option descriptor, spread into a command's `options` array. */
const TARGET_OPTION = {
    description: `Deploy target: ${TARGET_HELP}. Also settable as "target" in lunora.json`,
    name: "target",
    type: String,
} as const;

/**
 * Resolve and validate a target, reshaped to the return-an-error idiom the CLI
 * handlers already use (see `validateOutputFormat`) rather than throwing.
 *
 * The throwing form is right for `@lunora/config`, whose callers differ; inside
 * a handler it forces a try/catch around what is otherwise a flat sequence of
 * guards, which is both noisier and a different shape from the guard sitting
 * five lines above it.
 * @param projectRoot Directory containing `lunora.json`.
 * @param explicit A caller-supplied target, if any.
 * @returns the resolved target, or the message explaining why it was rejected.
 */
const resolveTargetOrError = (projectRoot: string, explicit?: string): { error?: string; target?: string } => {
    try {
        return { target: resolveTargetOrThrow(projectRoot, explicit) };
    } catch (error: unknown) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
};

/**
 * Resolve a target for a command that must shell out to the host's CLI —
 * `lunora deploy` and `lunora dev`.
 *
 * A registered target is not necessarily a *runnable* one. `DeployDriver`
 * models the toolchain as optional, and the Node driver genuinely has none:
 * there is no control plane to deploy to and no local runtime the CLI can
 * spawn. Rejecting that here, at selection, is the whole point — the deploy
 * path rewrites `_generated/*` (tailored to the target's capability matrix) and
 * reconciles `wrangler.jsonc` long before anything asks the driver for a
 * command, so a check at the point of use fails after the side effects, and
 * `lunora dev` did not check at all: `toolchain?.dev(...)` fell through to
 * wrangler, silently serving a Node-target app on Cloudflare's runtime.
 * @param projectRoot Directory containing `lunora.json`.
 * @param explicit A caller-supplied target, if any.
 * @returns the resolved target, or the message explaining why it was rejected.
 */
const resolveRunnableTargetOrError = (projectRoot: string, explicit?: string): { error?: string; target?: string } => {
    const resolved = resolveTargetOrError(projectRoot, explicit);

    if (resolved.target === undefined) {
        return resolved;
    }

    if (resolveDeployDriver(resolved.target).toolchain === undefined) {
        const runnable = deployTargetIds().filter((id) => resolveDeployDriver(id).toolchain !== undefined);

        return {
            error: `deploy target "${resolved.target}" has no command-line toolchain, so the Lunora CLI cannot deploy or serve it — it can only generate for it (\`lunora codegen --target ${resolved.target}\`). Deployable targets: ${runnable.join(", ")}`,
        };
    }

    return resolved;
};

export { resolveRunnableTargetOrError, resolveTargetOrError, TARGET_OPTION };
