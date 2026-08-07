/**
 * Deploy-target selection (plan 114, §5.3).
 *
 * The CLI resolves a target name — from `--target`, a config field, or the
 * default — to the {@link DeployDriver} that serves it. Kept separate from the
 * drivers themselves so adding a target is a one-line registry entry rather
 * than a change to every call site.
 *
 * The default is `"cloudflare"`, which is what makes target selection a no-op
 * for every existing project: omit the flag and nothing about the command
 * changes.
 *
 * An unknown target throws rather than silently falling back. Quietly deploying
 * to Cloudflare because `--target aws` was not recognized would ship an app to
 * the wrong provider — the one failure mode this resolution must never have.
 */

import CLOUDFLARE_DRIVER from "./cloudflare/cloudflare-driver";
import type { DeployDriver } from "./deploy-driver";
import NODE_DRIVER from "./node/node-driver";

/** The default deploy target — today's behavior for every project. */
const DEFAULT_DEPLOY_TARGET = "cloudflare";

/**
 * Every registered target, keyed by id. One entry per host that ships a
 * driver; other targets land as their per-target platform packages do.
 */
const DEPLOY_DRIVERS: Readonly<Record<string, DeployDriver>> = {
    cloudflare: CLOUDFLARE_DRIVER,
    node: NODE_DRIVER,
};

/** The ids a caller may select, for error messages and `--target` help text. */
const deployTargetIds = (): ReadonlyArray<string> => Object.keys(DEPLOY_DRIVERS).toSorted((a, b) => a.localeCompare(b));

/**
 * Resolve a target name to its driver.
 * @throws when `target` names no registered driver — never falls back to the default.
 */
const resolveDeployDriver = (target: string = DEFAULT_DEPLOY_TARGET): DeployDriver => {
    const driver = DEPLOY_DRIVERS[target];

    if (driver === undefined) {
        throw new Error(`unknown deploy target "${target}" — available targets: ${deployTargetIds().join(", ")}`);
    }

    return driver;
};

export { DEFAULT_DEPLOY_TARGET, deployTargetIds, resolveDeployDriver };
