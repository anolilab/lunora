import { describe, expect, it } from "vitest";

import type { ProvisionJob } from "../src/targets/cloudflare-wfp/box-contract";
import { createCloudflareWfpDriver } from "../src/targets/cloudflare-wfp/driver";
import type { ProvisionBox } from "../src/targets/cloudflare-wfp/provision-box";
import { registeredTargets } from "../src/targets/registry";
import { createMemoryTarget } from "./support/memory-driver";
import { describeTargetConformance } from "./support/target-conformance";

/**
 * Every registered target driver against the one contract (MULTIPLATFORM.md
 * Phase 1, item 5). The reference driver runs first: a leg it cannot pass is a
 * leg that describes one host, not the contract.
 */

describeTargetConformance("memory (reference)", () => {
    const target = createMemoryTarget();

    return { driver: target.driver, running: () => [...target.running().keys()], serve: target.serve };
});

/**
 * `cloudflare-wfp` over its real ports with the Cloudflare side faked: a
 * provision box that converges like Alchemy (a deploy upserts the alias's
 * Worker, a destroy removes it and tolerates its absence), and an Analytics
 * Engine reader over the dispatcher's per-request data points.
 */
describeTargetConformance("cloudflare-wfp", () => {
    const workers = new Map<string, string>();
    const dataPoints: { atMs: number; requests: number; scriptName: string }[] = [];
    const box: ProvisionBox = {
        get: () => {
            return {
                fetch: (_path, init) => {
                    const job = JSON.parse(init?.body as string) as ProvisionJob;

                    if (job.action === "deploy") {
                        workers.set(job.spec.alias, job.spec.bundle);
                    } else {
                        workers.delete(job.alias);
                    }

                    return Promise.resolve(new Response('{"type":"result"}\n'));
                },
            };
        },
    };

    return {
        driver: createCloudflareWfpDriver({
            appDomain: "lunora.app",
            box: () => box,
            cell: "default",
            dispatchNamespace: "lunora-production",
            usage: {
                readRequestUsage: (sinceMs) => {
                    // `timestamp > since`, summed per script — the SQL `createHttpAnalyticsReader` runs.
                    const totals = new Map<string, number>();

                    for (const point of dataPoints.filter((candidate) => candidate.atMs > sinceMs)) {
                        totals.set(point.scriptName, (totals.get(point.scriptName) ?? 0) + point.requests);
                    }

                    return Promise.resolve(
                        [...totals].map(([scriptName, requests]) => {
                            return { requests, scriptName };
                        }),
                    );
                },
            },
        }),
        running: () => [...workers.keys()],
        serve: (scriptName, requests, atMs) => {
            dataPoints.push({ atMs, requests, scriptName });
        },
    };
});

describe("the conformance run", () => {
    // Registering a driver without adding it above fails here: a target ships
    // only once it passes the same legs as every other.
    it("covers every registered target", () => {
        expect(registeredTargets()).toStrictEqual(["cloudflare-wfp"]);
    });
});
