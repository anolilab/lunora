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
 * must agree. The resolvers themselves live in `./deploy-target-resolve`.
 */
import { DEFAULT_DEPLOY_TARGET, deployTargetIds } from "@lunora/config/cli";

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
    description: `Deploy target: ${TARGET_HELP}. Also settable as "target" in lunora.config.*`,
    name: "target",
    type: String,
} as const;

export default TARGET_OPTION;
