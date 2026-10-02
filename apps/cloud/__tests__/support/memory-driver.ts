/**
 * The in-memory reference {@link TargetDriver} (MULTIPLATFORM.md Phase 1, item 5).
 *
 * The smallest honest implementation of the contract: tenants are entries in a
 * map, requests are timestamped records. It is what the conformance suite
 * (`./target-conformance.ts`) is written against first, so the suite states
 * the contract rather than one host's behaviour, and it doubles as the fake
 * driver the deploy-path tests override one member of.
 */
import { tenantSender } from "../../src/backup/tenant-transport";
import { sha256HexBytes } from "../../src/deploy/keys";
import type { TargetDriver, UsageRow } from "../../src/targets/driver";

/** The platform apex memory tenants are served under. */
export const MEMORY_APP_DOMAIN = "memory.test";

export interface MemoryTarget {
    driver: TargetDriver;
    /** The aliases the target runs, each with the bundle hash it serves. */
    running: () => ReadonlyMap<string, string>;
    /** Record that `resourceRef` served `requests` requests at `atMs`. */
    serve: (resourceRef: string, requests: number, atMs: number) => void;
}

export const createMemoryTarget = (): MemoryTarget => {
    const tenants = new Map<string, string>();
    const served: { atMs: number; requests: number; resourceRef: string }[] = [];
    const tenantUrl = (alias: string): string => `https://${alias}.${MEMORY_APP_DOMAIN}`;

    const driver: TargetDriver = {
        capabilities: { fanout: "native", metering: "readback" },
        deploy: async (spec) => {
            const bundleHash = await sha256HexBytes(spec.bundle);

            tenants.set(spec.alias, bundleHash);

            return { bundleHash, url: tenantUrl(spec.alias) };
        },
        destroy: async (reference) => {
            tenants.delete(reference.alias);
        },
        domains: { platformTargets: () => [MEMORY_APP_DOMAIN] },
        id: "memory",
        logs: { kind: "otlp" },
        reach: (tenant) => tenantSender(tenant),
        route: async (hostname, lookup) => {
            const host = hostname.toLowerCase();
            const suffix = `.${MEMORY_APP_DOMAIN}`;
            let resourceRef: null | string;

            if (host.endsWith(suffix)) {
                const label = host.slice(0, -suffix.length);

                // Single-label subdomains only, like every platform hostname grammar.
                resourceRef = label === "" || label.includes(".") ? null : label;
            } else {
                resourceRef = await lookup.customDomain(host);
            }

            return resourceRef !== null && (await lookup.live(resourceRef)) ? { resourceRef } : null;
        },
        tenantUrl,
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
        running: () => tenants,
        serve: (resourceRef, requests, atMs) => {
            served.push({ atMs, requests, resourceRef });
        },
    };
};

/** The reference driver with some members replaced — the deploy-path tests' fake. */
export const fakeDriver = (overrides: Partial<TargetDriver> = {}): TargetDriver => {
    return { ...createMemoryTarget().driver, ...overrides };
};
