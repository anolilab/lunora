/**
 * Target selection: a project's `target` → the {@link TargetDriver} that serves
 * it, built for this control-plane deployment's env.
 *
 * Shaped after `@lunora/config`'s `driver-registry.ts` (plan 114 §5.3) so the
 * two stay conceptually aligned: one table keyed by id, a default that makes
 * selection a no-op for every existing row, and an unknown or unbuilt target
 * that throws rather than falls back. Quietly converging a `celld-vps` project
 * onto Workers for Platforms because its driver was missing would ship it to the
 * wrong host — the one failure this lookup must never have.
 *
 * Adding a target is one driver directory under `src/targets/` and one entry in
 * {@link TARGET_DRIVERS}. Its descriptor and binding table land first, in
 * `src/provision-contract.ts`, so the deploy handler can already refuse what it
 * cannot run.
 */
import { LunoraError } from "@lunora/server";

import type { TargetId } from "../provision-contract";
import { TARGET_IDS, TARGETS } from "../provision-contract";
import type { CelldVpsEnvironment } from "./celld-vps/driver";
import { celldVpsCanConverge, celldVpsDriverFromEnv, celldVpsFleet } from "./celld-vps/driver";
import type { CloudflareWfpEnvironment } from "./cloudflare-wfp/driver";
import { cloudflareWfpCanConverge, cloudflareWfpDriverFromEnv, cloudflareWfpFleetFromEnv } from "./cloudflare-wfp/driver";
import type { CloudflareWorkersEnvironment } from "./cloudflare-workers/driver";
import { cloudflareWorkersCanConverge, cloudflareWorkersDriverFromEnv, cloudflareWorkersFleetFromEnv } from "./cloudflare-workers/driver";
import type { TargetDriver, TargetFleet } from "./driver";
import type { Placement } from "./placement";

/** Everything any registered driver reads off the control plane's Worker env. */
export type TargetEnvironment = CelldVpsEnvironment & CloudflareWfpEnvironment & CloudflareWorkersEnvironment;

/** The placement of target `T`. */
type PlacementOf<T extends TargetId> = Extract<Placement, { target: T }>;

interface TargetEntry<T extends TargetId> {
    /** Whether this deployment of the control plane holds what converging and tearing down needs. */
    canConverge: (environment: TargetEnvironment) => boolean;
    driver: (placement: PlacementOf<T>, environment: TargetEnvironment) => TargetDriver;
    fleet: (environment: TargetEnvironment) => TargetFleet;
}

/** Every target with a driver. A {@link TargetId} missing here has a binding table and no driver yet. */
const TARGET_DRIVERS: { readonly [T in TargetId]?: TargetEntry<T> } = {
    "celld-vps": {
        canConverge: celldVpsCanConverge,
        driver: (placement, environment) => celldVpsDriverFromEnv(placement.host, environment),
        fleet: () => celldVpsFleet,
    },
    "cloudflare-wfp": {
        canConverge: cloudflareWfpCanConverge,
        driver: (_placement, environment) => cloudflareWfpDriverFromEnv(environment),
        fleet: cloudflareWfpFleetFromEnv,
    },
    "cloudflare-workers": {
        canConverge: cloudflareWorkersCanConverge,
        driver: (placement, environment) => cloudflareWorkersDriverFromEnv(placement.host, environment),
        fleet: cloudflareWorkersFleetFromEnv,
    },
};

/** `target`'s entry, refusing one with no driver here. */
const entryOf = <T extends TargetId>(target: T): TargetEntry<T> => {
    const entry: TargetEntry<T> | undefined = TARGET_DRIVERS[target];

    if (entry === undefined) {
        throw new LunoraError("NOT_IMPLEMENTED", `deploy target "${target}" has no driver on this control plane yet`);
    }

    return entry;
};

/**
 * The driver of a placement of target `T`, from `T`'s own entry. Generic so the
 * entry's `driver` takes exactly that target's placement: `TARGET_DRIVERS` is
 * mapped over every {@link TargetId}, so a new target without a matching entry
 * shape fails to compile here rather than at a switch someone forgot to extend.
 */
const driverOf = <T extends TargetId>(placement: PlacementOf<T>, environment: TargetEnvironment): TargetDriver =>
    entryOf<T>(placement.target).driver(placement, environment);

/**
 * The driver for one placement, built over `environment`.
 * @throws {LunoraError} `NOT_IMPLEMENTED` when the target has no driver yet.
 */
export const resolveTargetDriver = (placement: Placement, environment: TargetEnvironment): TargetDriver => driverOf(placement, environment);

/**
 * `target`'s fleet-wide surface, built over `environment`.
 * @throws {LunoraError} `NOT_IMPLEMENTED` when the target has no driver yet.
 */
export const targetFleet = (target: TargetId, environment: TargetEnvironment): TargetFleet => entryOf(target).fleet(environment);

/** Whether `target` has a driver here that can converge and tear down — the teardown sweep leaves the rest pending. */
export const targetCanConverge = (target: TargetId, environment: TargetEnvironment): boolean => TARGET_DRIVERS[target]?.canConverge(environment) ?? false;

/** The targets that have a driver, in id order. */
export const registeredTargets = (): TargetId[] => TARGET_IDS.filter((id) => TARGET_DRIVERS[id] !== undefined);

/**
 * The fleets of every registered target whose descriptor matches — what the
 * sweeps iterate (`{ fanout: "dispatcher" }` for the cron fan-out and the queue
 * consumer, `{ metering: "readback" }` for the usage rollback).
 */
export const registeredFleets = (environment: TargetEnvironment, where: Partial<Pick<(typeof TARGETS)[TargetId], "fanout" | "metering">> = {}): TargetFleet[] =>
    registeredTargets()
        .filter(
            (id) =>
                (where.fanout === undefined || TARGETS[id].fanout === where.fanout) &&
                (where.metering === undefined || TARGETS[id].metering === where.metering),
        )
        .map((id) => targetFleet(id, environment));
