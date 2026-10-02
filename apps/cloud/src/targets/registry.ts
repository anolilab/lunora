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
 * {@link TARGET_DRIVERS}. Its binding table lands first, in
 * `src/provision-contract.ts`, so the deploy handler can already refuse what it
 * cannot run.
 */
import { LunoraError } from "@lunora/server";

import type { TargetId } from "../provision-contract";
import { DEFAULT_TARGET, isTargetId, TARGET_IDS } from "../provision-contract";
import type { CelldVpsEnvironment } from "./celld-vps/driver";
import { celldVpsCanConverge, celldVpsDriverFromEnv } from "./celld-vps/driver";
import type { CloudflareWfpEnvironment } from "./cloudflare-wfp/driver";
import { cloudflareWfpCanConverge, cloudflareWfpDriverFromEnv } from "./cloudflare-wfp/driver";
import type { TargetDriver } from "./driver";
import type { BoxPlacement } from "./placement";

/** Everything any registered driver reads off the control plane's Worker env. */
export type TargetEnvironment = CelldVpsEnvironment & CloudflareWfpEnvironment;

export interface TargetDriverOptions {
    /** The box a `celld-vps` project is placed on (`Placement.box`); a driver built without one resolves a box per alias. */
    box?: BoxPlacement;
    /** Receives the driver's converge log lines, for Workers Logs (the provision box's log, for `cloudflare-wfp`). */
    onLog?: (line: string) => void;
    /** Receives converge progress meant for the deploy stream itself (`celld-vps`: the box's job progress). */
    onProgress?: (line: string) => void;
}

interface TargetDriverEntry {
    /** Whether this deployment of the control plane holds what converging and tearing down needs. */
    canConverge: (environment: TargetEnvironment) => boolean;
    create: (environment: TargetEnvironment, options: TargetDriverOptions) => TargetDriver;
}

/** Every target with a driver. A {@link TargetId} missing here has a binding table and no driver yet. */
const TARGET_DRIVERS: Readonly<Partial<Record<TargetId, TargetDriverEntry>>> = {
    "celld-vps": { canConverge: celldVpsCanConverge, create: celldVpsDriverFromEnv },
    "cloudflare-wfp": { canConverge: cloudflareWfpCanConverge, create: cloudflareWfpDriverFromEnv },
};

/**
 * A stored `target` column → its id, or `undefined` for a value no target
 * answers to. Absent (`undefined`, or SQL NULL off a `.global()` row) means the
 * row predates targets, and is `cloudflare-wfp`.
 */
export const storedTarget = (stored: null | string | undefined): TargetId | undefined => {
    if (stored == null) {
        return DEFAULT_TARGET;
    }

    return isTargetId(stored) ? stored : undefined;
};

/**
 * Parse a stored `target` column like {@link storedTarget}, refusing a value no target answers to.
 * @throws {LunoraError} `CONFLICT` for an unknown target.
 */
export const targetOf = (stored: null | string | undefined): TargetId => {
    const target = storedTarget(stored);

    if (target === undefined) {
        throw new LunoraError("CONFLICT", `unknown deploy target "${String(stored)}" — known targets: ${TARGET_IDS.join(", ")}`);
    }

    return target;
};

/**
 * The driver for `target`, built over `environment`.
 * @throws {LunoraError} `NOT_IMPLEMENTED` when the target has no driver yet.
 */
export const resolveTargetDriver = (target: TargetId, environment: TargetEnvironment, options: TargetDriverOptions = {}): TargetDriver => {
    const entry = TARGET_DRIVERS[target];

    if (entry === undefined) {
        throw new LunoraError("NOT_IMPLEMENTED", `deploy target "${target}" has no driver on this control plane yet`);
    }

    return entry.create(environment, options);
};

/** Whether `target` has a driver here that can converge and tear down — the teardown sweep leaves the rest pending. */
export const targetCanConverge = (target: TargetId, environment: TargetEnvironment): boolean => TARGET_DRIVERS[target]?.canConverge(environment) ?? false;

/** The targets that have a driver, in id order — what the sweeps iterate. */
export const registeredTargets = (): TargetId[] => TARGET_IDS.filter((id) => TARGET_DRIVERS[id] !== undefined);
