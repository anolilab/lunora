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

import CELLD_DRIVER from "./celld/celld-driver";
import CLOUDFLARE_DRIVER from "./cloudflare/cloudflare-driver";
import type { DeployDriver, ProjectionPurpose, ToolchainCommand } from "./deploy-driver";
import NODE_DRIVER from "./node/node-driver";

/** The default deploy target — today's behavior for every project. */
const DEFAULT_DEPLOY_TARGET = "cloudflare";

/**
 * Every registered target, keyed by id. One entry per host that ships a
 * driver; other targets land as their per-target platform packages do.
 */
const DEPLOY_DRIVERS: Readonly<Record<string, DeployDriver>> = {
    celld: CELLD_DRIVER,
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

/**
 * Whether `target`'s driver ships a `toolchain` — i.e. whether any tool can
 * actually build, serve or deploy it, as opposed to merely generate for it.
 *
 * One predicate rather than one per caller: the CLI (`deploy`, `dev`) and the
 * Vite plugin (`build`, `dev`) must refuse the same set, and a second copy
 * fails silently — the tool that forgot runs the WRONG pipeline for the target
 * instead of rejecting it.
 * @param target A target id already resolved by `resolveTargetOrThrow`. Unknown
 * ids answer `false` rather than throwing, so this is safe to ask about
 * arbitrary input.
 * @returns `true` when the target can be run.
 */
const isRunnableTarget = (target: string): boolean => Object.hasOwn(DEPLOY_DRIVERS, target) && resolveDeployDriver(target).toolchain !== undefined;

/**
 * The subset of {@link deployTargetIds} that {@link isRunnableTarget} accepts,
 * in the same (alphabetical) order.
 * @returns every target id a tool can build, serve or deploy — used to name the
 * alternatives when one is refused.
 */
const runnableTargetIds = (): ReadonlyArray<string> => deployTargetIds().filter((id) => isRunnableTarget(id));

/**
 * Whether `lunora dev` serves `target`'s worker with the host's own dev server
 * (`DriverToolchain.devServer === "own"`) instead of workerd. The CLI's flavor
 * choice and the Vite plugin's warning both ask this, so it is answered once.
 */
const targetRunsOwnDevServer = (target: string): boolean => resolveDeployDriver(target).toolchain?.devServer === "own";

/** A toolchain command planned against the driver's config projection, with nothing written yet. */
interface ToolchainInvocation {
    command: ToolchainCommand;
    /** Write the projection, if the driver has one. Call only once the command is going to run. */
    commit: () => void;
    /** The projection the command reads, and every key it left out — `undefined` when the host reads the project config as-is. */
    projection: { configPath: string; dropped: ReadonlyArray<string> } | undefined;
}

/**
 * Plan a toolchain call in the one safe order: project the config (in memory),
 * build the argv against the projection's path — which is where a host refuses
 * an option it cannot honour, so a refusal throws here — and only then offer the
 * write. A refused command therefore leaves nothing on disk, and `configPath`
 * is set on every request whose driver projects.
 */
const planToolchainInvocation = (
    driver: DeployDriver,
    projectRoot: string,
    purpose: ProjectionPurpose,
    build: (configPath: string | undefined) => ToolchainCommand,
): ToolchainInvocation => {
    const projected = driver.projectConfig?.(projectRoot, purpose);
    const command = build(projected?.configPath);

    return {
        command,
        commit: () => projected?.write(),
        projection: projected === undefined ? undefined : { configPath: projected.configPath, dropped: projected.dropped },
    };
};

export type { ToolchainInvocation };
export { DEFAULT_DEPLOY_TARGET, deployTargetIds, isRunnableTarget, planToolchainInvocation, resolveDeployDriver, runnableTargetIds, targetRunsOwnDevServer };
