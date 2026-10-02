import { describe, expect, it } from "vitest";

import type { BoxSession } from "../src/boxes/session-client";
import { boxSession } from "../src/boxes/session-client";
import { createCelldVpsDriver } from "../src/targets/celld-vps/driver";
import type { ProvisionJob } from "../src/targets/cloudflare-wfp/box-contract";
import { createCloudflareWfpDriver, createCloudflareWfpFleet } from "../src/targets/cloudflare-wfp/driver";
import type { ProvisionBox } from "../src/targets/cloudflare-wfp/provision-box";
import { registeredTargets } from "../src/targets/registry";
import { boxKey, boxRow, fakeHostd, fakeState, handshake, namespaceOver, TestBoxSession } from "./support/box-session-fakes";
import { createMemoryTarget } from "./support/memory-driver";
import { memoryStore } from "./support/memory-store";
import { describeTargetConformance, describeUsageReadbackConformance } from "./support/target-conformance";

/**
 * Every registered target driver against the one contract (MULTIPLATFORM.md
 * Phase 1, item 5). The reference driver runs first: a leg it cannot pass is a
 * leg that describes one host, not the contract.
 */

describeTargetConformance("memory (reference)", () => {
    const target = createMemoryTarget();

    return { driver: target.driver, running: () => [...target.running().keys()] };
});

describeUsageReadbackConformance("memory (reference)", () => {
    const { fleet, serve } = createMemoryTarget();

    if (fleet.usage === undefined) {
        throw new Error("the memory fleet reads usage back");
    }

    return { read: fleet.usage, serve };
});

/**
 * `cloudflare-wfp` over its real ports with the Cloudflare side faked: a
 * provision box that converges like Alchemy (a deploy upserts the alias's
 * Worker, a destroy removes it and tolerates its absence), and an Analytics
 * Engine reader over the dispatcher's per-request data points.
 */
describeTargetConformance("cloudflare-wfp", () => {
    const workers = new Map<string, string>();
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
        driver: createCloudflareWfpDriver({ appDomain: "lunora.app", box: () => box, cell: "default", dispatchNamespace: "lunora-production" }),
        running: () => [...workers.keys()],
    };
});

describeUsageReadbackConformance("cloudflare-wfp", () => {
    const dataPoints: { atMs: number; requests: number; scriptName: string }[] = [];
    const { usage } = createCloudflareWfpFleet({
        cell: "default",
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
    });

    if (usage === undefined) {
        throw new Error("the fleet was built with a usage reader");
    }

    return {
        read: usage,
        // One scope, the cell: the dispatcher writes every tenant's requests to its one dataset.
        serve: (_scope, scriptName, requests, atMs) => {
            dataPoints.push({ atMs, requests, scriptName });
        },
    };
});

/**
 * `celld-vps` over the real control-plane path: the driver hands its jobs to a
 * real `BoxSessionDO` through the session client, the session sends them down
 * an authenticated socket, and a fake `lunora-hostd` on the far end runs them
 * against its fleets and answers. What the box runs is what it reports. Its
 * usage is pushed (a box's `report` frames, `src/boxes/usage.ts`), never read
 * back, so it runs no readback legs.
 */
describeTargetConformance("celld-vps", () => {
    const box = { id: "box_1", slug: "bslug000001" };
    const fleets = new Map<string, string>();
    // The project behind alias `app`, placed on the box, with a live deployment.
    const store = memoryStore({
        aliasOwnership: [{ _id: "own_app", alias: "app", projectId: "proj_app" }],
        deployments: [{ _id: "dep_app", alias: "app", projectId: "proj_app", status: "live" }],
        domains: [],
        projects: [{ _id: "proj_app", boxId: "box_1", organizationId: "org_1" }],
    });
    const state = fakeState();
    const session = new TestBoxSession(state, store, { LUNORA_BOX_DOMAIN: "boxes.test" });
    const connected = (async () => {
        const key = await boxKey();

        store.tables["boxes"] = [boxRow(key)];

        await handshake(session, state, key, box.id, { onSend: fakeHostd(session, fleets) });
    })();
    const client = boxSession(namespaceOver(session), box.id);
    // The box connects before the first job reaches it, as a live box would have.
    const connectedSession: BoxSession = {
        claimNonce: async (nonce, expiresAt) => {
            await connected;

            return client.claimNonce(nonce, expiresAt);
        },
        close: async (code, message) => {
            await connected;

            return client.close(code, message);
        },
        dispatch: async (job, options) => {
            await connected;

            return client.dispatch(job, options);
        },
        fetch: (request) => client.fetch(request),
        pushRoutes: async () => {
            await connected;

            return client.pushRoutes();
        },
    };

    return {
        driver: createCelldVpsDriver({ box, boxDomain: "boxes.test", controlPlaneOrigin: "https://cloud.test", session: () => connectedSession }),
        running: () => [...fleets.keys()],
    };
});

describe("the conformance run", () => {
    // Registering a driver without adding it above fails here: a target ships
    // only once it passes the same legs as every other.
    it("covers every registered target", () => {
        expect(registeredTargets()).toStrictEqual(["cloudflare-wfp", "celld-vps"]);
    });
});
