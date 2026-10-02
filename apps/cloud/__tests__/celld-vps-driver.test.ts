import type { HostdJob } from "@lunora/hostd/protocol";
import { describe, expect, it } from "vitest";

import type { BoxSession } from "../src/boxes/session-client";
import { BoxSessionError } from "../src/boxes/session-client";
import type { DeployBackend } from "../src/deploy/handler";
import { startRelease } from "../src/deploy/handler";
import { CellScheduler } from "../src/deploy/scheduler";
import { teardownPorts } from "../src/deploy/sweeps";
import { runTeardownSweep } from "../src/deploy/teardown";
import { TokenBucket } from "../src/deploy/token-bucket";
import type { TenantDeploymentSpec } from "../src/provision-contract";
import type { CelldVpsPorts } from "../src/targets/celld-vps/driver";
import { boxForAliasIn, boxUsageIn, celldVpsCanConverge, createCelldVpsDriver } from "../src/targets/celld-vps/driver";
import memoryReleaseStore from "./_helpers/memory-release-store";
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
        close: () => Promise.resolve(),
        dispatch: (job, options) => {
            jobs.push(job);
            options?.onProgress?.(`${job.kind} started`);

            return answer(job);
        },
        pushRoutes: () => {
            pushes += 1;

            return Promise.resolve(true);
        },
    };

    return { jobs, pushes: () => pushes, session };
};

const driverWith = (session: BoxSession, overrides: Partial<CelldVpsPorts> = {}) =>
    createCelldVpsDriver({
        box: BOX,
        boxById: () => Promise.resolve({ ...BOX, revoked: false }),
        boxDomain: "boxes.test",
        boxForAlias: () => Promise.resolve({ ...BOX, revoked: false }),
        boxForSlug: () => Promise.resolve(null),
        controlPlaneOrigin: "https://cloud.test",
        session: () => session,
        ...overrides,
    });

describe("the celld-vps driver", () => {
    it("hands the box a deploy job: the signed release URL, vars with secrets merged in, and native crons", async () => {
        const { jobs, pushes, session } = recordingSession();
        const progress: string[] = [];

        const result = await driverWith(session, { onProgress: (line) => progress.push(line) }).deploy(spec());

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
        const { session } = recordingSession(() => Promise.reject(new BoxSessionError("BOX_OFFLINE", "the box is not connected")));

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

    it("tears an alias down with its data, on the box it lives on", async () => {
        const { jobs, session } = recordingSession();
        const seen: string[] = [];

        await driverWith(session, {
            box: undefined,
            boxForAlias: (alias) => {
                seen.push(alias);

                return Promise.resolve({ ...BOX, revoked: false });
            },
        }).destroy({ alias: "web" });

        expect(seen).toStrictEqual(["web"]);
        expect(jobs).toStrictEqual([{ alias: "web", deleteData: true, kind: "destroy" }]);
    });

    it("tears down on the box the deployment row names, without asking the project", async () => {
        const { jobs, session } = recordingSession();
        const asked: string[] = [];

        await driverWith(session, {
            box: undefined,
            boxById: (id) => {
                asked.push(id);

                return Promise.resolve({ ...BOX, revoked: false });
            },
            boxForAlias: () => Promise.reject(new Error("the project is gone")),
        }).destroy({ alias: "web", boxId: "box_1" });

        expect(asked).toStrictEqual(["box_1"]);
        expect(jobs).toStrictEqual([{ alias: "web", deleteData: true, kind: "destroy" }]);
    });

    it("throws, keeping the alias claimed, when no box can be resolved for it", async () => {
        const { jobs, session } = recordingSession();

        await expect(driverWith(session, { box: undefined, boxForAlias: () => Promise.resolve(null) }).destroy({ alias: "web" })).rejects.toThrow(
            /no box this control plane can resolve/u,
        );
        expect(jobs).toStrictEqual([]);
    });

    it("leaves an alias on a revoked or deleted box alone, and says so", async () => {
        const { jobs, session } = recordingSession();
        const logged: string[] = [];
        const onLog = (line: string): void => {
            logged.push(line);
        };

        await driverWith(session, { box: undefined, boxForAlias: () => Promise.resolve({ ...BOX, revoked: true }), onLog }).destroy({ alias: "web" });
        await driverWith(session, { box: undefined, boxById: () => Promise.resolve({ ...BOX, revoked: true }), onLog }).destroy({
            alias: "web",
            boxId: "box_1",
        });
        await driverWith(session, { box: undefined, boxById: () => Promise.resolve(null), onLog }).destroy({ alias: "web", boxId: "box_gone" });

        expect(jobs).toStrictEqual([]);
        expect(logged).toStrictEqual([
            'alias "web": box "bslug000001" is revoked; its fleet and data stay on the machine, releasing the alias',
            'alias "web": box "bslug000001" is revoked; its fleet and data stay on the machine, releasing the alias',
            'alias "web": box box_gone no longer exists; nothing to stop, releasing the alias',
        ]);
    });

    it("routes default hostnames of any box by slug, and custom domains by lookup", async () => {
        const { session } = recordingSession();
        const driver = driverWith(session, {
            box: undefined,
            boxForSlug: (slug) => Promise.resolve(slug === "bother00000" ? { id: "box_2", revoked: false, slug } : null),
        });
        const lookup = {
            customDomain: (host: string) => Promise.resolve(host === "www.example.com" ? "web" : null),
            live: (ref: string) => Promise.resolve(ref === "web"),
        };

        await expect(driver.route("web.bother00000.boxes.test", lookup)).resolves.toStrictEqual({ resourceRef: "web" });
        await expect(driver.route("web.bnobody0000.boxes.test", lookup)).resolves.toBeNull();
        await expect(driver.route("a.b.bother00000.boxes.test", lookup)).resolves.toBeNull();
        await expect(driver.route("www.example.com", lookup)).resolves.toStrictEqual({ resourceRef: "web" });
    });

    it("needs the project's box to name a tenant URL, and points custom domains at the box", () => {
        const { session } = recordingSession();

        expect(() => driverWith(session, { box: undefined }).tenantUrl("web", "production")).toThrow("built without one");
        expect(driverWith(session).domains.platformTargets()).toStrictEqual(["bslug000001.boxes.test"]);
        expect(driverWith(session).capabilities).toStrictEqual({ fanout: "native", metering: "pushed" });
        expect(driverWith(session).dispatch).toBeUndefined();
        expect(driverWith(session).logs).toStrictEqual({ kind: "otlp" });
    });

    it("converges only where a box session, the D1 and the public origin are all bound", () => {
        expect(celldVpsCanConverge({})).toBe(false);
        expect(
            celldVpsCanConverge({
                BOX_SESSION: {
                    get: () => {
                        return { fetch: () => Promise.reject(new Error("x")) };
                    },
                    idFromName: () => "",
                },
                DB: {},
            }),
        ).toBe(false);
        expect(
            celldVpsCanConverge({
                BOX_SESSION: {
                    get: () => {
                        return { fetch: () => Promise.reject(new Error("x")) };
                    },
                    idFromName: () => "",
                },
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

    const sweep = async (store: ReturnType<typeof memoryStore>, session: BoxSession) => {
        const driver = createCelldVpsDriver({
            boxById: async (id) => {
                const row = (await store.get(id, "boxes")) as null | { _id: string; slug: string; status: string };

                return row ? { id: row._id, revoked: row.status === "revoked", slug: row.slug } : null;
            },
            boxDomain: "boxes.test",
            boxForAlias: (alias) => boxForAliasIn(store)(alias),
            boxForSlug: () => Promise.resolve(null),
            controlPlaneOrigin: "https://cloud.test",
            session: () => session,
        });

        return runTeardownSweep(
            teardownPorts(store, { deleteRelease: () => Promise.resolve(), destroy: (_target, reference) => driver.destroy(reference) }, 1000, () => true),
        );
    };

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
        const { session } = recordingSession(() => Promise.reject(new BoxSessionError("BOX_OFFLINE", "the box is not connected")));

        await expect(sweep(store, session)).resolves.toStrictEqual({ failed: 1, tornDown: 0 });
        await expect(claimed(store)).resolves.toBe(1);
    });

    it("frees the alias of a fleet on a revoked box, which nothing can reach", async () => {
        const store = world({ status: "revoked" });
        const { jobs, session } = recordingSession();

        await expect(sweep(store, session)).resolves.toStrictEqual({ failed: 0, tornDown: 1 });
        expect(jobs).toStrictEqual([]);
        await expect(claimed(store)).resolves.toBe(0);
    });
});

describe("celld-vps store reads", () => {
    it("finds an alias's box through its owning project", async () => {
        const store = memoryStore({
            aliasOwnership: [{ _id: "own_1", alias: "web", projectId: "proj_1" }],
            boxes: [{ _id: "box_1", slug: "bslug000001", status: "revoked" }],
            projects: [
                { _id: "proj_1", boxId: "box_1" },
                { _id: "proj_2", boxId: null },
            ],
        });

        await expect(boxForAliasIn(store)("web")).resolves.toStrictEqual({ id: "box_1", revoked: true, slug: "bslug000001" });
        await expect(boxForAliasIn(store)("nobody")).resolves.toBeNull();
    });

    it("reads box-reported requests per alias by report window, ignoring non-box rows", async () => {
        const store = memoryStore({
            deployments: [{ _id: "dep_1", alias: "web", scriptName: "web" }],
            platformUsage: [
                { _id: "u1", boxId: "box_1", deploymentId: "dep_1", kind: "requests", quantity: 3, windowStart: 1000 },
                { _id: "u2", boxId: "box_1", deploymentId: "dep_1", kind: "requests", quantity: 4, windowStart: 2000 },
                { _id: "u3", boxId: null, deploymentId: "dep_1", kind: "requests", quantity: 100, windowStart: null },
            ],
        });

        await expect(boxUsageIn(store)(1000)).resolves.toStrictEqual([{ requests: 4, resourceRef: "web" }]);
        await expect(boxUsageIn(store)(0)).resolves.toStrictEqual([{ requests: 7, resourceRef: "web" }]);
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
                driverFor: (placement, options) => driverWith(session, { ...(placement.box ? { box: placement.box } : {}), onProgress: options?.onProgress }),
                releases: memoryReleaseStore().store,
                scheduler: new CellScheduler({ bucket: new TokenBucket({ capacity: 10, refillPerWindow: 10, windowMs: 1000 }) }),
            },
        );
        const frames: Record<string, unknown>[] = [];

        expect("run" in started).toBe(true);

        const outcome = "run" in started ? await started.run((frame) => frames.push(frame)) : undefined;

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
