/**
 * The celld fleets a box runs, as the control plane last knows them (plan 458
 * W9): what its `hostd` reported in `hello.fleets`, kept current between
 * reconnects by the jobs the session sees finish. Pure, so the session and the
 * studio agree on one reading of a job's outcome.
 *
 * Box-reported, so untrusted (plan 458 §8): the protocol decoder already holds
 * `hello.fleets` to {@link HOSTD_PROTOCOL_LIMITS.maxFleets} entries with valid
 * aliases; {@link normaliseFleets} keeps the stored list to that bound and one
 * entry per alias whatever reaches it.
 */
import type { FleetSummary, HostdJob } from "@lunora/hostd/protocol";
import { HOSTD_PROTOCOL_LIMITS } from "@lunora/hostd/protocol";

import type { JobOutcome } from "./jobs";

/** Sorted by alias, one entry per alias (the last one wins), capped at the protocol's fleet limit. */
export const normaliseFleets = (fleets: ReadonlyArray<FleetSummary>): FleetSummary[] => {
    const byAlias = new Map<string, FleetSummary>();

    for (const fleet of fleets) {
        byAlias.set(fleet.alias, {
            alias: fleet.alias,
            ...(fleet.deploymentId === undefined ? {} : { deploymentId: fleet.deploymentId }),
            state: fleet.state,
        });
    }

    return [...byAlias.values()].toSorted((a, b) => (a.alias < b.alias ? -1 : 1)).slice(0, HOSTD_PROTOCOL_LIMITS.maxFleets);
};

/**
 * The fleets after `job` finished with `outcome`, or `undefined` when the job
 * says nothing about them. Only a job that succeeded moves the list: a failed
 * deploy leaves celld serving what it served, and the next `hello` corrects
 * anything else.
 *
 * - `deploy` → the alias runs the job's deployment;
 * - `reload` → the alias is running again (its deployment unchanged);
 * - `destroy` → the alias is gone.
 */
export const fleetsAfterJob = (fleets: ReadonlyArray<FleetSummary>, job: HostdJob, outcome: JobOutcome): FleetSummary[] | undefined => {
    if (!outcome.ok) {
        return undefined;
    }

    switch (job.kind) {
        case "deploy": {
            return normaliseFleets([
                ...fleets.filter((fleet) => fleet.alias !== job.alias),
                { alias: job.alias, deploymentId: job.deploymentId, state: "running" },
            ]);
        }
        case "destroy": {
            return normaliseFleets(fleets.filter((fleet) => fleet.alias !== job.alias));
        }
        case "reload": {
            const current = fleets.find((fleet) => fleet.alias === job.alias);

            return normaliseFleets([...fleets.filter((fleet) => fleet.alias !== job.alias), { ...current, alias: job.alias, state: "running" }]);
        }
        default: {
            return undefined;
        }
    }
};
