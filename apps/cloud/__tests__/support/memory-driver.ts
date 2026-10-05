/**
 * The in-memory reference target (MULTIPLATFORM.md Phase 1, item 5).
 *
 * The smallest honest implementation of the contract: tenants are entries in a
 * map, requests are timestamped records. It is what the conformance suite
 * (`./target-conformance.ts`) is written against first, so the suite states
 * the contract rather than one host's behaviour, and it doubles as the fake
 * driver the deploy-path tests override one member of.
 *
 * It answers to `cloudflare-wfp`'s id: what a deploy may bind is the target id's
 * static table, never a driver's, so a fake can only stand in for a real id.
 */
import { tenantSender } from "../../src/backup/tenant-transport";
import type { TargetDriver, TargetFleet, UsageRow } from "../../src/targets/driver";

/** The platform apex memory tenants are served under. */
export const MEMORY_APP_DOMAIN = "memory.test";

/** The memory target's usage scopes: two, so the suite proves each keeps its own checkpoint. */
export const MEMORY_SCOPES = ["memory-a", "memory-b"] as const;

export interface MemoryTarget {
    driver: TargetDriver;
    fleet: TargetFleet;
    /** The aliases the target runs, each with the bundle bytes it serves. */
    running: () => ReadonlyMap<string, ArrayBuffer>;
    /** Record that `alias` served `requests` requests at `atMs`, in usage scope `scope` ({@link MEMORY_SCOPES}). */
    serve: (scope: string, alias: string, requests: number, atMs: number) => void;
}

export const createMemoryTarget = (): MemoryTarget => {
    const tenants = new Map<string, ArrayBuffer>();
    const served: { atMs: number; requests: number; resourceRef: string; scope: string }[] = [];

    const driver: TargetDriver = {
        deploy: async (spec) => {
            tenants.set(spec.alias, spec.bundle);

            return { url: `https://${spec.alias}.${MEMORY_APP_DOMAIN}` };
        },
        destroy: async (alias) => {
            tenants.delete(alias);
        },
        domains: { issue: () => Promise.resolve(undefined), platformTargets: () => [MEMORY_APP_DOMAIN] },
        id: "cloudflare-wfp",
    };

    const fleet: TargetFleet = {
        id: "cloudflare-wfp",
        reach: (tenant) => tenantSender(tenant),
        usage: {
            read: async (scope, sinceMs) => {
                const totals = new Map<string, number>();

                for (const record of served) {
                    if (record.scope === scope && record.atMs > sinceMs) {
                        totals.set(record.resourceRef, (totals.get(record.resourceRef) ?? 0) + record.requests);
                    }
                }

                return [...totals].map(([resourceRef, requests]): UsageRow => {
                    return { requests, resourceRef };
                });
            },
            scopes: async () => [...MEMORY_SCOPES],
        },
    };

    return {
        driver,
        fleet,
        running: () => tenants,
        serve: (scope, alias, requests, atMs) => {
            // A resource is named within its scope, as `cloudflare-workers` names one per account.
            served.push({ atMs, requests, resourceRef: `${scope}/${alias}`, scope });
        },
    };
};

/** The deploy-path tests' fake: the reference driver with some members replaced. */
export const fakeDriver = (overrides: Partial<TargetDriver> = {}): TargetDriver => {
    return { ...createMemoryTarget().driver, ...overrides };
};
