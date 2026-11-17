import { resolveTargetOrThrow } from "@lunora/config";
import { isRunnableTarget, runnableTargetIds } from "@lunora/config/cli";

/**
 * Resolve and validate a target, reshaped to the return-an-error idiom the CLI
 * handlers already use (see `parseOutputFormat`) rather than throwing.
 *
 * The throwing form is right for `@lunora/config`, whose callers differ; inside
 * a handler it forces a try/catch around what is otherwise a flat sequence of
 * guards, which is both noisier and a different shape from the guard sitting
 * five lines above it.
 *
 * Lives apart from the `--target` option descriptor so that command metadata
 * (which every `lunora` invocation loads) does not pull in the codegen-backed
 * `resolveTargetOrThrow`; only the handlers that resolve a target import this.
 * @param projectRoot Directory containing `lunora.config.*`.
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
 * @param projectRoot Directory containing `lunora.config.*`.
 * @param explicit A caller-supplied target, if any.
 * @returns the resolved target, or the message explaining why it was rejected.
 */
const resolveRunnableTargetOrError = (projectRoot: string, explicit?: string): { error?: string; target?: string } => {
    const resolved = resolveTargetOrError(projectRoot, explicit);

    if (resolved.target === undefined) {
        return resolved;
    }

    if (!isRunnableTarget(resolved.target)) {
        const runnable = runnableTargetIds();

        return {
            error: `deploy target "${resolved.target}" has no command-line toolchain, so the Lunora CLI cannot deploy or serve it — it can only generate for it (\`lunora codegen --target ${resolved.target}\`). Deployable targets: ${runnable.join(", ")}`,
        };
    }

    return resolved;
};

export { resolveRunnableTargetOrError, resolveTargetOrError };
