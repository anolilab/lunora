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

export interface MemoryTarget {
    driver: TargetDriver;
    fleet: TargetFleet;
    /** The aliases the target runs, each with the bundle bytes it serves. */
    running: () => ReadonlyMap<string, ArrayBuffer>;
    /** Record that `resourceRef` served `requests` requests at `atMs`. */
    serve: (resourceRef: string, requests: number, atMs: number) => void;
}

export const createMemoryTarget = (): MemoryTarget => {
    const tenants = new Map<string, ArrayBuffer>();
    const served: { atMs: number; requests: number; resourceRef: string }[] = [];

    const driver: TargetDriver = {
        deploy: async (spec) => {
            tenants.set(spec.alias, spec.bundle);

            return { url: `https://${spec.alias}.${MEMORY_APP_DOMAIN}` };
        },
        destroy: async (alias) => {
            tenants.delete(alias);
        },
        domains: { platformTargets: () => [MEMORY_APP_DOMAIN] },
        id: "cloudflare-wfp",
    };

    const fleet: TargetFleet = {
        id: "cloudflare-wfp",
        reach: (tenant) => tenantSender(tenant),
        usage: async (sinceMs) => {
            const totals = new Map<string, number>();

            for (const record of served) {
                if (record.atMs > sinceMs) {
                    totals.set(record.resourceRef, (totals.get(record.resourceRef) ?? 0) + record.requests);
                }
            }

            return [...totals].map(([resourceRef, requests]): UsageRow => {
                return { requests, resourceRef };
            });
        },
    };

    return {
        driver,
        fleet,
        running: () => tenants,
        serve: (resourceRef, requests, atMs) => {
            served.push({ atMs, requests, resourceRef });
        },
    };
};

/** The deploy-path tests' fake: the reference driver with some members replaced. */
export const fakeDriver = (overrides: Partial<TargetDriver> = {}): TargetDriver => {
    return { ...createMemoryTarget().driver, ...overrides };
};
