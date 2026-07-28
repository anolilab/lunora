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
 * needs it, because those two must agree: codegen tailors the surface to a
 * target while deploy picks the driver that ships it, and an app generated for
 * one provider and deployed to another fails at runtime with nothing in the
 * build to explain it.
 */
import { DEFAULT_DEPLOY_TARGET, deployTargetIds, resolveDeployDriver, resolveProjectTarget } from "@lunora/config";

/** Human-readable list of registered targets, for help text and errors. */
const TARGET_HELP = `${deployTargetIds().join(" | ")} (default ${DEFAULT_DEPLOY_TARGET})`;

/** The `--target` option descriptor, spread into a command's `options` array. */
const TARGET_OPTION = {
    description: `Deploy target: ${TARGET_HELP}. Also settable as "target" in lunora.json`,
    name: "target",
    type: String,
} as const;

/**
 * Resolve the target for a command and reject an unregistered one.
 *
 * The validation is the point. `resolveProjectTarget` deliberately passes an
 * unknown name through — a typo must not collapse into the default — and the
 * commands that resolve a `DeployDriver` then fail on it naturally. Codegen
 * does not resolve a driver, so without this it would emit the full Cloudflare
 * surface un-gated for a target that does not exist, report it as a warning,
 * and exit `0`. That is the silent fallback the registry was designed to
 * prevent, arriving through the back door.
 *
 * Routing every command through here also means one error message rather than
 * one per entry point.
 * @throws when the resolved target names no registered driver.
 */
const resolveTargetOrThrow = (projectRoot: string, explicit?: string): string => {
    const target = resolveProjectTarget(projectRoot, explicit);

    // Resolved purely to validate — the driver itself is the caller's business.
    resolveDeployDriver(target);

    return target;
};

export { resolveTargetOrThrow, TARGET_HELP, TARGET_OPTION };
