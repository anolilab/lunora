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

import CLOUDFLARE_DRIVER from "./cloudflare-driver";
import type { DeployDriver } from "./deploy-driver";

/** The default deploy target — today's behavior for every project. */
const DEFAULT_DEPLOY_TARGET = "cloudflare";

/**
 * Every registered target, keyed by id. One entry per host that ships a
 * driver; other targets land as their per-target platform packages do.
 */
const DEPLOY_DRIVERS: Record<string, DeployDriver> = {
    cloudflare: CLOUDFLARE_DRIVER,
};

/**
 * Register a driver that lives outside this package.
 *
 * Mutable on purpose: not every driver can be imported from here. A driver
 * backed by an IaC engine carries a Node-shaped dependency tree — `alchemy@0.93`
 * alone brings `wrangler`, `miniflare`, `esbuild` and `execa` — and this package
 * is imported by `@lunora/vite`, so a static import would push that weight into
 * every consumer that only wanted to read `lunora.json`. Such drivers ship as
 * their own package and register here, keeping the cost on projects that opt in.
 *
 * Idempotent by id, so a module that registers on import is safe to import
 * twice. Re-registering a *different* driver under a live id throws rather than
 * silently winning: two packages disagreeing about what `"aws"` means is a
 * configuration error, and picking one at random would deploy somewhere the
 * caller did not choose.
 * @param driver The driver to register.
 * @throws when `driver.id` is already held by a different driver.
 */
const registerDeployDriver = (driver: DeployDriver): void => {
    const existing = DEPLOY_DRIVERS[driver.id];

    if (existing !== undefined && existing !== driver) {
        throw new Error(`deploy target "${driver.id}" is already registered by a different driver`);
    }

    DEPLOY_DRIVERS[driver.id] = driver;
};

/**
 * Whether a driver can run in the calling process.
 *
 * A `"node"` driver in a Worker fails at bundle time if you are lucky and at
 * request time if you are not, so a control plane running in a Worker asks this
 * before reaching for converge-shaped work — and splits it: the pure half
 * (routing, secret writes, teardown calls) in the Worker, convergence in a
 * container.
 * @param driver The driver to check.
 * @returns `true` when the driver declares itself runnable anywhere.
 */
const isWorkerdSafeDriver = (driver: DeployDriver): boolean => driver.runtime === "any";

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

export { DEFAULT_DEPLOY_TARGET, deployTargetIds, isWorkerdSafeDriver, registerDeployDriver, resolveDeployDriver };
