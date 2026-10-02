import type { HostdJob } from "@lunora/hostd/protocol";
import { describe, expect, it } from "vitest";

import type { BoxSession } from "../src/boxes/session-client";
import type { DeployBackend } from "../src/deploy/release-core";
import { startRelease } from "../src/deploy/release-core";
import { CellScheduler } from "../src/deploy/scheduler";
import { teardownPorts } from "../src/deploy/sweeps";
import { runTeardownSweep } from "../src/deploy/teardown";
import { TokenBucket } from "../src/deploy/token-bucket";
import type { TenantDeploymentSpec } from "../src/provision-contract";
import type { CelldVpsPorts } from "../src/targets/celld-vps/driver";
import { celldVpsCanConverge, celldVpsFleet, createCelldVpsDriver } from "../src/targets/celld-vps/driver";
import { boxLookupsIn } from "../src/targets/placement";
import memoryReleaseStore from "./_helpers/memory-release-store";
import { fakeSessionNamespace } from "./support/box-session-fakes";
import { memoryStore } from "./support/memory-store";

const BOX = { id: "box_1", slug: "bslug000001" };

const spec = (overrides: Partial<TenantDeploymentSpec> = {}): TenantDeploymentSpec => {
    return {
        alias: "web",
        bundle: new TextEncoder().encode("export default {}").buffer,
        crons: ["*/5 * * * *"],
        deploymentId: "dep_1",
        kind: "production",
        manifest: { bindings: [], compatibilityDate: "2026-06-10" },
        secrets: { API_KEY: "s3cret", LUNORA_ADMIN_TOKEN: "admin" },
        tags: [],
        vars: { LUNORA_ADMIN_TOKEN: "from-vars", LUNORA_OTLP_ENDPOINT: "https://cloud.test" },
        ...overrides,
    };
};

/** A session that records every job and answers with `answer`. */
const recordingSession = (answer: (job: HostdJob) => Promise<Awaited<ReturnType<BoxSession["dispatch"]>>> = () => Promise.resolve({ ok: true })) => {
    const jobs: HostdJob[] = [];
    let pushes = 0;
    const session: BoxSession = {
        claimNonce: () => Promise.resolve(true),
        close: () => Promise.resolve(0),
        dispatch: (job, options) => {
            jobs.push(job);
            options?.onProgress?.(`${job.kind} started`);

            return answer(job);
        },
        fetch: () => Promise.reject(new Error("no upgrade in this test")),
        pushRoutes: () => {
            pushes += 1;

            return Promise.resolve(true);
        },
    };

    return { jobs, pushes: () => pushes, session };
};

const driverWith = (session: BoxSession, overrides: Partial<CelldVpsPorts> = {}) =>
    createCelldVpsDriver({ box: BOX, boxDomain: "boxes.test", controlPlaneOrigin: "https://cloud.test", session: () => session, ...overrides });

describe("the celld-vps driver", () => {
    it("hands the box a deploy job: the signed release URL, vars with secrets merged in, and native crons", async () => {
        const { jobs, pushes, session } = recordingSession();
        const progress: string[] = [];

        const result = await driverWith(session).deploy(spec(), { onProgress: (line) => progress.push(line) });

        expect(jobs).toStrictEqual([
            {
                alias: "web",
                compatibilityDate: "2026-06-10",
                crons: ["*/5 * * * *"],
                deploymentId: "dep_1",
                kind: "deploy",
                releaseUrl: "https://cloud.test/v1/boxes/releases/dep_1",
                vars: { API_KEY: "s3cret", LUNORA_ADMIN_TOKEN: "admin", LUNORA_OTLP_ENDPOINT: "https://cloud.test" },
            },
        ]);
        expect(result.url).toBe("https://web.bslug000001.boxes.test");
        expect(progress).toStrictEqual(["deploy started"]);
        expect(pushes()).toBe(1);
    });

    it("fails fast and says so when the box is offline", async () => {
        const { session } = recordingSession(() => Promise.resolve({ error: { code: "BOX_OFFLINE", message: "the box is not connected" }, ok: false }));

        await expect(driverWith(session).deploy(spec())).rejects.toThrow(
            'box "bslug000001" is offline (BOX_OFFLINE): start lunora-hostd on it and deploy again',
        );
    });

    it("fails with the box's own reason when its job fails", async () => {
        const { pushes, session } = recordingSession(() =>
            Promise.resolve({ error: { code: "CELLD_DEPLOY_FAILED", message: "bucket unreachable" }, ok: false }),
        );

        await expect(driverWith(session).deploy(spec())).rejects.toThrow("CELLD_DEPLOY_FAILED: bucket unreachable");
        expect(pushes()).toBe(0);
    });

    it("tears an alias down with its data, on its box", async () => {
        const { jobs, session } = recordingSession();

        await driverWith(session).destroy("web");

        expect(jobs).toStrictEqual([{ alias: "web", deleteData: true, kind: "destroy" }]);
    });

    it("points custom domains at the box, and pushes the box its routes once one verifies", async () => {
        const { pushes, session } = recordingSession();
        const driver = driverWith(session);

        expect(driver.domains.platformTargets()).toStrictEqual(["bslug000001.boxes.test"]);

        await driver.domains.onVerified?.();

        expect(pushes()).toBe(1);
    });

    it("reaches every tenant on its public hostname, with no in-network path or readback", () => {
        expect(celldVpsFleet.dispatch).toBeUndefined();
        expect(celldVpsFleet.usage).toBeUndefined();
    });

    it("converges only where a box session, the D1 and the public origin are all bound", () => {
        expect(celldVpsCanConverge({})).toBe(false);
        expect(
            celldVpsCanConverge({
                BOX_SESSION: fakeSessionNamespace(() => {
                    return {};
                }),
                DB: {},
            }),
        ).toBe(false);
        expect(
            celldVpsCanConverge({
                BOX_SESSION: fakeSessionNamespace(() => {
                    return {};
                }),
                DB: {},
                LUNORA_ORIGIN_URL: "https://c",
            }),
        ).toBe(true);
    });
});

describe("celld-vps teardown after the project is gone", () => {
    /**
     * The world after `projects.remove` (or a preview's expiry): the deployment
     * rows are `destroyed` and still name their box, the alias is still claimed,
     * and — for a deleted project — the project row is gone.
     */
    const world = (box: Record<string, unknown>, projects: Record<string, unknown>[] = []) =>
        memoryStore({
            aliasOwnership: [{ _id: "own_1", alias: "web", projectId: "proj_1" }],
            boxes: [{ _id: "box_1", slug: "bslug000001", ...box }],
            deployments: [
                { _id: "dep_1", alias: "web", boxId: "box_1", createdAt: 1, kind: "production", scriptName: "web", status: "destroyed", target: "celld-vps" },
            ],
            projects,
        });

    const sweep = async (store: ReturnType<typeof memoryStore>, session: BoxSession, log: string[] = []) =>
        runTeardownSweep(
            teardownPorts(
                store,
                {
                    accounts: () => Promise.resolve(null),
                    boxes: boxLookupsIn(store),
                    deleteRelease: () => Promise.resolve(),
                    driverFor: (placement) =>
                        createCelldVpsDriver({
                            box: "box" in placement ? placement.box : BOX,
                            boxDomain: "boxes.test",
                            controlPlaneOrigin: "https://cloud.test",
                            session: () => session,
                        }),
                    log: (line) => log.push(line),
                },
                1000,
                () => true,
            ),
        );

    const claimed = async (store: ReturnType<typeof memoryStore>): Promise<number> => {
        const { page } = await store.findMany("aliasOwnership", { where: { alias: "web" } });

        return page.length;
    };

    it("stops a deleted project's fleet and its data on its box, then frees the alias", async () => {
        const store = world({ status: "online" });
        const { jobs, session } = recordingSession();

        await expect(sweep(store, session)).resolves.toStrictEqual({ failed: 0, tornDown: 1 });
        expect(jobs).toStrictEqual([{ alias: "web", deleteData: true, kind: "destroy" }]);
        await expect(claimed(store)).resolves.toBe(0);
    });

    it("stops an expired preview's fleet on its box while the project lives on", async () => {
        const store = world({ status: "online" }, [{ _id: "proj_1", boxId: "box_1", organizationId: "org_1" }]);
        const { jobs, session } = recordingSession();

        await sweep(store, session);

        expect(jobs).toStrictEqual([{ alias: "web", deleteData: true, kind: "destroy" }]);
    });

    it("keeps the alias claimed, and the row pending, while the box cannot be reached", async () => {
        const store = world({ status: "offline" });
        const { session } = recordingSession(() => Promise.resolve({ error: { code: "BOX_OFFLINE", message: "the box is not connected" }, ok: false }));

        await expect(sweep(store, session)).resolves.toStrictEqual({ failed: 1, tornDown: 0 });
        await expect(claimed(store)).resolves.toBe(1);
    });

    it("frees the alias of a fleet on a revoked box, which nothing can reach, and says so", async () => {
        const store = world({ status: "revoked" });
        const { jobs, session } = recordingSession();
        const log: string[] = [];

        await expect(sweep(store, session, log)).resolves.toStrictEqual({ failed: 0, tornDown: 1 });
        expect(jobs).toStrictEqual([]);
        expect(log).toStrictEqual(['alias "web": box "bslug000001" is revoked; its fleet and data stay on the machine, releasing the alias']);
        await expect(claimed(store)).resolves.toBe(0);
    });

    it("frees the alias of a fleet whose box was deleted with its organization", async () => {
        const store = memoryStore({
            aliasOwnership: [{ _id: "own_1", alias: "web", projectId: "proj_1" }],
            boxes: [],
            deployments: [
                {
                    _id: "dep_1",
                    alias: "web",
                    boxId: "box_gone",
                    createdAt: 1,
                    kind: "production",
                    scriptName: "web",
                    status: "destroyed",
                    target: "celld-vps",
                },
            ],
            projects: [],
        });
        const { jobs, session } = recordingSession();
        const log: string[] = [];

        await expect(sweep(store, session, log)).resolves.toStrictEqual({ failed: 0, tornDown: 1 });
        expect(jobs).toStrictEqual([]);
        expect(log).toStrictEqual(['alias "web": box box_gone no longer exists; nothing to stop, releasing the alias']);
        await expect(claimed(store)).resolves.toBe(0);
    });

    it("keeps the alias claimed when a row that predates deployments.boxId has no box to resolve", async () => {
        const store = memoryStore({
            aliasOwnership: [{ _id: "own_1", alias: "web", projectId: "proj_1" }],
            boxes: [],
            deployments: [{ _id: "dep_1", alias: "web", createdAt: 1, kind: "production", scriptName: "web", status: "destroyed", target: "celld-vps" }],
            projects: [],
        });
        const { jobs, session } = recordingSession();

        await expect(sweep(store, session)).resolves.toStrictEqual({ failed: 1, tornDown: 0 });
        expect(jobs).toStrictEqual([]);
        await expect(claimed(store)).resolves.toBe(1);
    });
});

describe("celld-vps box lookups", () => {
    it("finds an alias's box through its owning project", async () => {
        const store = memoryStore({
            aliasOwnership: [{ _id: "own_1", alias: "web", projectId: "proj_1" }],
            boxes: [{ _id: "box_1", slug: "bslug000001", status: "revoked" }],
            projects: [
                { _id: "proj_1", boxId: "box_1" },
                { _id: "proj_2", boxId: null },
            ],
        });

        await expect(boxLookupsIn(store).forAlias("web")).resolves.toStrictEqual({ id: "box_1", revoked: true, slug: "bslug000001" });
        await expect(boxLookupsIn(store).forAlias("nobody")).resolves.toBeNull();
    });
});

describe("the deploy stream", () => {
    it("carries a driver's progress lines as log frames, between the release's own phases", async () => {
        const backend: DeployBackend = {
            createDeployment: () => Promise.resolve({ deploymentId: "dep_1" }),
            placement: () => Promise.resolve({ box: BOX, target: "celld-vps" }),
            releaseTarget: () => Promise.reject(new Error("unused")),
            rollbackDeployment: () => Promise.reject(new Error("unused")),
            updateStatus: () => Promise.resolve(),
            verifyKey: () => Promise.resolve(null),
        };
        const { session } = recordingSession();
        const started = await startRelease(
            { bundle: btoa("export default {}"), kind: "production", projectId: "proj_1", scriptName: "web" },
            { key: "k", organizationId: "org_1" },
            {
                backend,
                driverFor: (placement) => driverWith(session, "box" in placement ? { box: placement.box } : {}),
                releases: memoryReleaseStore().store,
                scheduler: new CellScheduler({ bucket: new TokenBucket({ capacity: 10, refillPerWindow: 10, windowMs: 1000 }) }),
            },
        );
        const frames: Record<string, unknown>[] = [];

        expect("run" in started).toBe(true);

        const outcome = "run" in started ? await started.run((frame) => frames.push({ ...frame })) : undefined;

        expect(outcome).toMatchObject({ status: "live", url: "https://web.bslug000001.boxes.test" });
        expect(frames.map((frame) => frame["phase"] ?? frame["log"] ?? frame["event"] ?? (frame["done"] === true ? "done" : "?"))).toStrictEqual([
            "accepted",
            "queued",
            "provisioning",
            "deploy started",
            "live",
            "done",
        ]);
    });
});
