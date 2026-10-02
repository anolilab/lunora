import { describe, expect, it } from "vitest";

import type { BoxSession } from "../src/boxes/session-client";
import { boxSession } from "../src/boxes/session-client";
import { recordBoxReport } from "../src/boxes/usage";
import { boxUsageIn, createCelldVpsDriver } from "../src/targets/celld-vps/driver";
import type { ProvisionJob } from "../src/targets/cloudflare-wfp/box-contract";
import { createCloudflareWfpDriver } from "../src/targets/cloudflare-wfp/driver";
import type { ProvisionBox } from "../src/targets/cloudflare-wfp/provision-box";
import { registeredTargets } from "../src/targets/registry";
import { boxKey, boxRow, fakeHostd, fakeState, handshake, namespaceOver, TestBoxSession } from "./support/box-session-fakes";
import { createMemoryTarget } from "./support/memory-driver";
import { memoryStore } from "./support/memory-store";
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

/**
 * `celld-vps` over the real control-plane path: the driver hands its jobs to a
 * real `BoxSessionDO` through the session client, the session sends them down
 * an authenticated socket, and a fake `lunora-hostd` on the far end runs them
 * against its fleets and answers. What the box runs is what it reports.
 * Usage is recorded by the real box-report write path and read back from the
 * `platformUsage` rows it writes, as production does.
 */
describeTargetConformance("celld-vps", () => {
    const box = { id: "box_1", slug: "bslug000001" };
    const fleets = new Map<string, string>();
    // The project behind alias `app`, placed on the box, with a live deployment its reports attribute to.
    const store = memoryStore({
        aliasOwnership: [{ _id: "own_app", alias: "app", projectId: "proj_app" }],
        deployments: [{ _id: "dep_app", alias: "app", projectId: "proj_app", status: "live" }],
        domains: [],
        platformUsage: [],
        projects: [{ _id: "proj_app", boxId: "box_1", organizationId: "org_1" }],
    });
    const reported: Promise<unknown>[] = [];
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
            await client.close(code, message);
        },
        dispatch: async (job, options) => {
            await connected;

            return client.dispatch(job, options);
        },
        pushRoutes: async () => {
            await connected;

            return client.pushRoutes();
        },
    };

    return {
        driver: createCelldVpsDriver({
            box,
            boxById: () => Promise.resolve({ ...box, revoked: false }),
            boxDomain: "boxes.test",
            boxForAlias: () => Promise.resolve({ ...box, revoked: false }),
            boxForSlug: (slug) => Promise.resolve(slug === box.slug ? { ...box, revoked: false } : null),
            controlPlaneOrigin: "https://cloud.test",
            session: () => connectedSession,
            usage: async (sinceMs) => {
                await Promise.all(reported);

                return boxUsageIn(store)(sinceMs);
            },
        }),
        running: () => [...fleets.keys()],
        serve: (resourceRef, requests, atMs) => {
            // A box's report, through the real write path, received the moment its window closed.
            reported.push(
                recordBoxReport(
                    store,
                    { _id: box.id, organizationId: "org_1" },
                    { perAlias: [{ alias: resourceRef, errors: 0, requests }], type: "report", windowEnd: atMs, windowStart: atMs },
                    atMs,
                ),
            );
        },
    };
});

describe("the conformance run", () => {
    // Registering a driver without adding it above fails here: a target ships
    // only once it passes the same legs as every other.
    it("covers every registered target", () => {
        expect(registeredTargets()).toStrictEqual(["celld-vps", "cloudflare-wfp"]);
    });
});
