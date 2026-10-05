import { describe, expect, it, vi } from "vitest";

import { runReadbackUsageSweep, teardownPorts, USAGE_SCOPE_CONCURRENCY, usageAttributionOf, usageRollbackPorts } from "../src/deploy/sweeps";
import { runTeardownSweep } from "../src/deploy/teardown";
import type { TargetId } from "../src/provision-contract";
import type { ControlPlaneDatabase } from "../src/store";
import { drainTable } from "../src/store";
import type { UsageRow } from "../src/targets/driver";
import fakeControlPlaneDb from "./_helpers/fake-control-plane-db";
import { fakeDriver } from "./support/memory-driver";
import { memoryStore } from "./support/memory-store";

describe(teardownPorts, () => {
    const noop = {
        deleteRelease: () => Promise.resolve(),
        driverFor: () => fakeDriver(),
        log: () => undefined,
        read: () => Promise.resolve(null),
    };
    const everyTarget = (): boolean => true;

    it("destroys the Worker of an alias with no deployment left, once, and skips torn-down rows", async () => {
        const database = fakeControlPlaneDb({
            deployments: [
                { _id: "d1", alias: "a", kind: "preview", projectId: "prj_1", scriptName: "a", status: "destroyed" },
                { _id: "d3", alias: "a", kind: "preview", projectId: "prj_1", scriptName: "a", status: "destroyed" },
                { _id: "d2", alias: "b", kind: "production", projectId: "prj_1", scriptName: "b", status: "destroyed", teardownAt: 123 },
            ],
        });

        const pending = await teardownPorts(database, noop, 1000, everyTarget).listPending();

        // One destroy job per dead alias; the other row only drops its stored bundle.
        expect(pending).toStrictEqual([
            { alias: "a", destroyWorker: true, id: "d1", projectId: "prj_1", target: "cloudflare-wfp" },
            { alias: "a", destroyWorker: false, id: "d3", projectId: "prj_1", target: "cloudflare-wfp" },
        ]);
    });

    it("prunes stored bundles beyond retention but never the Worker the live release runs on", async () => {
        const database = fakeControlPlaneDb({
            deployments: [
                { _id: "v1", alias: "app", kind: "production", projectId: "prj_1", scriptName: "app", status: "destroyed" }, // pruned
                { _id: "v2", alias: "app", kind: "production", projectId: "prj_1", scriptName: "app", status: "failed" }, // never a rollback target
                { _id: "v3", alias: "app", kind: "production", projectId: "prj_1", scriptName: "app", status: "superseded" }, // retained
                { _id: "v4", alias: "app", kind: "production", projectId: "prj_1", scriptName: "app", status: "live" },
            ],
        });

        const pending = await teardownPorts(database, noop, 1000, everyTarget).listPending();

        expect(pending).toStrictEqual([
            { alias: "app", destroyWorker: false, id: "v1", projectId: "prj_1", target: "cloudflare-wfp" },
            { alias: "app", destroyWorker: false, id: "v2", projectId: "prj_1", target: "cloudflare-wfp" },
        ]);
    });

    it("keeps the Worker of an alias whose only other deployment failed", async () => {
        const database = fakeControlPlaneDb({
            deployments: [
                { _id: "v1", alias: "app", kind: "production", projectId: "prj_1", scriptName: "app", status: "destroyed" },
                { _id: "v2", alias: "app", kind: "production", projectId: "prj_1", scriptName: "app", status: "failed" },
            ],
        });

        const pending = await teardownPorts(database, noop, 1000, everyTarget).listPending();

        expect(pending.map((row) => row.destroyWorker)).toStrictEqual([false, false]);
    });

    it("leaves the rows of a target that cannot converge here pending, and acts on the rest", async () => {
        const database = fakeControlPlaneDb({
            deployments: [
                { _id: "wfp", alias: "a", kind: "production", projectId: "prj_1", scriptName: "a", status: "destroyed" },
                { _id: "box", alias: "b", kind: "production", projectId: "prj_1", scriptName: "b", status: "destroyed", target: "celld-vps" },
                // An id no target answers to waits too, rather than failing the sweep.
                { _id: "odd", alias: "c", kind: "production", projectId: "prj_1", scriptName: "c", status: "destroyed", target: "aws-lambda" },
            ],
        });

        const pending = await teardownPorts(database, noop, 1000, (target) => target === "cloudflare-wfp").listPending();

        expect(pending).toStrictEqual([{ alias: "a", destroyWorker: true, id: "wfp", projectId: "prj_1", target: "cloudflare-wfp" }]);
    });

    it("hands each row to its own target, reading a NULL target as cloudflare-wfp", async () => {
        const database = fakeControlPlaneDb({
            deployments: [
                { _id: "old", alias: "a", kind: "production", projectId: "prj_1", scriptName: "a", status: "destroyed", target: null },
                { _id: "box", alias: "b", kind: "production", projectId: "prj_1", scriptName: "b", status: "destroyed", target: "celld-vps" },
            ],
        });

        const pending = await teardownPorts(database, noop, 1000, everyTarget).listPending();

        expect(pending.map((row) => [row.id, row.target])).toStrictEqual([
            ["old", "cloudflare-wfp"],
            ["box", "celld-vps"],
        ]);
    });

    it("hands a celld-vps alias's teardown the box its newest deployment names, whatever became of the project", async () => {
        const database = fakeControlPlaneDb({
            deployments: [
                {
                    _id: "old",
                    alias: "web",
                    createdAt: 1,
                    placementRef: "box_old",
                    kind: "production",
                    projectId: "prj_1",
                    scriptName: "web",
                    status: "destroyed",
                    target: "celld-vps",
                },
                {
                    _id: "new",
                    alias: "web",
                    createdAt: 2,
                    placementRef: "box_new",
                    kind: "production",
                    projectId: "prj_1",
                    scriptName: "web",
                    status: "destroyed",
                    target: "celld-vps",
                },
                { _id: "wfp", alias: "a", kind: "production", projectId: "prj_1", scriptName: "a", status: "destroyed" },
            ],
        });

        const pending = await teardownPorts(database, noop, 1000, everyTarget).listPending();

        expect(pending).toStrictEqual([
            { alias: "web", destroyWorker: true, id: "old", placementRef: "box_new", projectId: "prj_1", target: "celld-vps" },
            { alias: "web", destroyWorker: false, id: "new", placementRef: "box_new", projectId: "prj_1", target: "celld-vps" },
            { alias: "a", destroyWorker: true, id: "wfp", projectId: "prj_1", target: "cloudflare-wfp" },
        ]);
    });

    it("tears a cloudflare-workers alias down in the account its newest deployment names", async () => {
        const database = fakeControlPlaneDb({
            deployments: [
                {
                    _id: "byo",
                    alias: "web",
                    createdAt: 1,
                    kind: "production",
                    placementRef: "cfa_1",
                    projectId: "prj_1",
                    scriptName: "web",
                    status: "destroyed",
                    target: "cloudflare-workers",
                },
            ],
        });
        const destroyed: unknown[] = [];
        const account = { accountId: "a".repeat(32), id: "cfa_1", workersSubdomain: "acme" };
        const row = { _id: "cfa_1", accountId: account.accountId, organizationId: "org_1", workersSubdomain: "acme" };
        const ports = teardownPorts(
            database,
            {
                ...noop,
                read: (table, id) => Promise.resolve(table === "cloudflareAccounts" && id === "cfa_1" ? row : null),
                driverFor: (placement) =>
                    fakeDriver({
                        destroy: (alias) => {
                            destroyed.push({ alias, placement });

                            return Promise.resolve();
                        },
                    }),
            },
            1000,
            everyTarget,
        );
        const [pending] = await ports.listPending();

        expect(pending).toStrictEqual({
            alias: "web",
            destroyWorker: true,
            id: "byo",
            placementRef: "cfa_1",
            projectId: "prj_1",
            target: "cloudflare-workers",
        });

        await ports.destroy(pending);

        expect(destroyed).toStrictEqual([{ alias: "web", placement: { host: account, target: "cloudflare-workers" } }]);
    });

    it("releases a cloudflare-workers alias whose account is gone — its Worker and data stay in the customer's account", async () => {
        const log: string[] = [];
        const ports = teardownPorts(
            fakeControlPlaneDb({ deployments: [] }),
            {
                ...noop,
                driverFor: () => {
                    throw new Error("nothing to reach");
                },
                log: (line) => log.push(line),
            },
            1000,
            everyTarget,
        );

        await ports.destroy({ alias: "web", destroyWorker: true, id: "byo", placementRef: "cfa_gone", projectId: "prj_1", target: "cloudflare-workers" });

        expect(log).toStrictEqual([
            'alias "web": its Cloudflare account is no longer connected; the Worker and its data stay in that account, releasing the alias',
        ]);
    });

    it("stamps teardownAt + updatedAt on the deployments table when marking torn down", async () => {
        const patch = vi.fn<ControlPlaneDatabase["patch"]>(() => Promise.resolve(undefined));
        const ports = teardownPorts(fakeControlPlaneDb({}, { patch }), noop, 5000, everyTarget);

        await ports.markTornDown("dep_1");

        expect(patch).toHaveBeenCalledWith("dep_1", { teardownAt: 5000, updatedAt: 5000 }, "deployments");
    });

    it("releaseAlias deletes the torn-down project's own claim on the alias", async () => {
        const deleteRow = vi.fn<ControlPlaneDatabase["delete"]>(() => Promise.resolve(undefined));
        const database = fakeControlPlaneDb({ aliasOwnership: [{ _id: "ao_1", alias: "app", projectId: "prj_1" }] }, { delete: deleteRow });
        const ports = teardownPorts(database, noop, 1000, everyTarget);

        await ports.releaseAlias("app", "prj_1");

        expect(deleteRow).toHaveBeenCalledWith("ao_1", "aliasOwnership");
    });

    it("releaseAlias is a no-op when no ownership row exists (already released)", async () => {
        const deleteRow = vi.fn<ControlPlaneDatabase["delete"]>(() => Promise.resolve(undefined));
        const ports = teardownPorts(fakeControlPlaneDb({ aliasOwnership: [] }, { delete: deleteRow }), noop, 1000, everyTarget);

        await ports.releaseAlias("ghost", "prj_1");

        expect(deleteRow).not.toHaveBeenCalled();
    });

    it("never releases another project's reservation of the alias: A deletes `shop`, B reserves it, the sweep runs", async () => {
        // B's project reserved `shop` (`projects.create` claims before any
        // deployment exists) after A's was deleted; A's destroyed row is the
        // one the sweep tears down.
        const database = memoryStore({
            aliasOwnership: [{ _id: "ao_b", alias: "shop", organizationId: "org_b", projectId: "prj_b" }],
            deployments: [{ _id: "dep_a", alias: "shop", kind: "production", projectId: "prj_a", scriptName: "shop", status: "destroyed" }],
        });
        const ports = teardownPorts(database, noop, 1000, everyTarget);

        const result = await runTeardownSweep({ ...ports, deleteRelease: () => Promise.resolve() });

        expect(result).toStrictEqual({ failed: 0, tornDown: 1 });
        expect(database.tables["aliasOwnership"]).toStrictEqual([{ _id: "ao_b", alias: "shop", organizationId: "org_b", projectId: "prj_b" }]);
    });
});

const reader =
    (rows: UsageRow[]): ((sinceMs: number) => Promise<UsageRow[]>) =>
    () =>
        Promise.resolve(rows);

/** The attribution map the sweep builds, over the test's deployments. */
const attributionOf = async (database: ControlPlaneDatabase, target: TargetId) => usageAttributionOf(await drainTable(database, "deployments"), target);

describe(usageRollbackPorts, () => {
    it("resolves a script to its owning org/deployment from the deployments table", async () => {
        const database = fakeControlPlaneDb({
            deployments: [
                { _id: "dep_old", organizationId: "org_a", scriptName: "a", status: "superseded" },
                { _id: "dep_a", organizationId: "org_a", scriptName: "a", status: "live" },
                { _id: "dep_new", organizationId: "org_a", scriptName: "a", status: "failed" },
            ],
        });

        const ports = await usageRollbackPorts(database, reader([]), {
            attribution: await attributionOf(database, "cloudflare-wfp"),
            now: 1000,
            periodStart: 500,
            scope: "default",
            target: "cloudflare-wfp",
        });

        // Every release shares the alias's script; its usage lands on the live one.
        expect(ports.resolveResource("a")).toStrictEqual({ deploymentId: "dep_a", organizationId: "org_a" });
        expect(ports.resolveResource("missing")).toBeUndefined();
    });

    it("attributes only the swept target's deployments, by resourceRef where a row has one", async () => {
        const database = fakeControlPlaneDb({
            deployments: [
                { _id: "dep_wfp", organizationId: "org_a", resourceRef: "a", scriptName: "a", status: "live", target: "cloudflare-wfp" },
                { _id: "dep_box", organizationId: "org_b", resourceRef: "fleets/b", scriptName: "b", status: "live", target: "celld-vps" },
            ],
        });

        const ports = await usageRollbackPorts(database, reader([]), {
            attribution: await attributionOf(database, "cloudflare-wfp"),
            now: 1000,
            periodStart: 0,
            scope: "default",
            target: "cloudflare-wfp",
        });

        expect(ports.resolveResource("a")).toStrictEqual({ deploymentId: "dep_wfp", organizationId: "org_a" });
        // Another target's resource never lands on this target's bill.
        expect(ports.resolveResource("fleets/b")).toBeUndefined();
        expect(ports.resolveResource("b")).toBeUndefined();
    });

    it("records a requests row into platformUsage with the period + attribution", async () => {
        const insert = vi.fn<ControlPlaneDatabase["insert"]>(() => Promise.resolve("id"));
        const database = fakeControlPlaneDb({ deployments: [] }, { insert });

        const ports = await usageRollbackPorts(database, reader([]), {
            attribution: new Map(),
            now: 1000,
            periodStart: 777,
            scope: "default",
            target: "cloudflare-wfp",
        });
        await ports.record({ attribution: { deploymentId: "dep_a", organizationId: "org_a" }, quantity: 12 });

        expect(insert).toHaveBeenCalledWith("platformUsage", {
            createdAt: 1000,
            deploymentId: "dep_a",
            kind: "requests",
            organizationId: "org_a",
            periodStart: 777,
            quantity: 12,
        });
    });

    it("records a cloudflare-workers tenant's requests against its account, which keeps them off the bill", async () => {
        const insert = vi.fn<ControlPlaneDatabase["insert"]>(() => Promise.resolve("id"));
        const database = fakeControlPlaneDb(
            {
                deployments: [
                    {
                        _id: "dep_byo",
                        organizationId: "org_a",
                        placementRef: "cfa_1",
                        resourceRef: "cfa_1/web",
                        scriptName: "web",
                        status: "live",
                        target: "cloudflare-workers",
                    },
                ],
                usageCheckpoints: [],
            },
            { insert },
        );
        const ports = await usageRollbackPorts(database, reader([]), {
            attribution: await attributionOf(database, "cloudflare-workers"),
            now: 1000,
            periodStart: 777,
            scope: "cfa_1",
            target: "cloudflare-workers",
        });
        const attribution = ports.resolveResource("cfa_1/web");

        // A same-named script in another account is never this tenant's.
        expect(ports.resolveResource("cfa_2/web")).toBeUndefined();

        await ports.record({ attribution: attribution as NonNullable<typeof attribution>, quantity: 5 });

        expect(insert).toHaveBeenCalledWith(
            "platformUsage",
            expect.objectContaining({ billable: false, deploymentId: "dep_byo", placementRef: "cfa_1", quantity: 5 }),
        );
    });

    it("starts a scope with no checkpoint row from nothing, so the rollback reads its bootstrap window", async () => {
        const database = fakeControlPlaneDb({ deployments: [], usageCheckpoints: [] });

        const ports = await usageRollbackPorts(database, reader([]), {
            attribution: new Map(),
            now: 1000,
            periodStart: 0,
            scope: "default",
            target: "cloudflare-wfp",
        });

        await expect(ports.getCheckpoint()).resolves.toBeUndefined();
    });

    it("reads the scope's own checkpoint row, never another scope's", async () => {
        const database = fakeControlPlaneDb({
            deployments: [],
            usageCheckpoints: [
                { _id: "cp_other", readAtMs: 7, scopeKey: "eu-1", target: "cloudflare-wfp" },
                { _id: "cp_1", readAtMs: 5000, scopeKey: "default", target: "cloudflare-wfp" },
            ],
        });

        const ports = await usageRollbackPorts(database, reader([]), {
            attribution: new Map(),
            now: 1000,
            periodStart: 0,
            scope: "default",
            target: "cloudflare-wfp",
        });

        await expect(ports.getCheckpoint()).resolves.toBe(5000);
    });

    it("inserts the scope's checkpoint row on its first advance and patches it after", async () => {
        const insert = vi.fn<ControlPlaneDatabase["insert"]>(() => Promise.resolve("cp_new"));
        const patch = vi.fn<ControlPlaneDatabase["patch"]>(() => Promise.resolve(undefined));
        const first = fakeControlPlaneDb({ deployments: [], usageCheckpoints: [] }, { insert, patch });

        const firstPorts = await usageRollbackPorts(first, reader([]), {
            attribution: new Map(),
            now: 1000,
            periodStart: 0,
            scope: "acct_1",
            target: "cloudflare-wfp",
        });

        await firstPorts.setCheckpoint(4242);

        expect(insert).toHaveBeenCalledWith("usageCheckpoints", { readAtMs: 4242, scopeKey: "acct_1", target: "cloudflare-wfp", updatedAt: 1000 });
        expect(patch).not.toHaveBeenCalled();

        const later = fakeControlPlaneDb(
            { deployments: [], usageCheckpoints: [{ _id: "cp_1", readAtMs: 4242, scopeKey: "acct_1", target: "cloudflare-wfp" }] },
            { insert, patch },
        );

        const laterPorts = await usageRollbackPorts(later, reader([]), {
            attribution: new Map(),
            now: 2000,
            periodStart: 0,
            scope: "acct_1",
            target: "cloudflare-wfp",
        });

        await laterPorts.setCheckpoint(5000);

        expect(patch).toHaveBeenCalledWith("cp_1", { readAtMs: 5000, updatedAt: 2000 }, "usageCheckpoints");
    });

    it("starts a scope with no checkpoint and no old cell column from nothing (the bootstrap window applies)", async () => {
        const database = fakeControlPlaneDb({ deployments: [], usageCheckpoints: [] });

        const ports = await usageRollbackPorts(database, reader([]), {
            attribution: new Map(),
            now: 1000,
            periodStart: 0,
            scope: "ghost",
            target: "cloudflare-wfp",
        });

        await expect(ports.getCheckpoint()).resolves.toBeUndefined();
    });
});

describe(runReadbackUsageSweep, () => {
    const deployments = [
        { _id: "dep_1", organizationId: "org_a", resourceRef: "cfa_1/web", scriptName: "web", status: "live", target: "cloudflare-workers" },
        { _id: "dep_2", organizationId: "org_b", resourceRef: "cfa_2/api", scriptName: "api", status: "live", target: "cloudflare-workers" },
    ];

    it("drains the deployments once for every scope, and reads at most four scopes at a time", async () => {
        const database = memoryStore({ deployments, usageCheckpoints: [] });
        const findMany = vi.spyOn(database, "findMany");
        const scopes = Array.from({ length: 10 }, (_, index) => `cfa_${String(index + 1)}`);
        let inFlight = 0;
        let peak = 0;

        await runReadbackUsageSweep(
            database,
            [
                {
                    id: "cloudflare-workers",
                    usage: {
                        read: async (scope) => {
                            inFlight += 1;
                            peak = Math.max(peak, inFlight);
                            await new Promise((resolve) => {
                                setTimeout(resolve, 1);
                            });
                            inFlight -= 1;

                            return scope === "cfa_1" ? [{ requests: 3, resourceRef: "cfa_1/web" }] : [];
                        },
                        scopes: () => Promise.resolve(scopes),
                    },
                },
            ],
            { now: 10_000, onScopeFailed: () => undefined, periodStart: 0 },
        );

        expect(findMany.mock.calls.filter(([table]) => table === "deployments")).toHaveLength(1);
        expect(peak).toBe(USAGE_SCOPE_CONCURRENCY);
        expect(USAGE_SCOPE_CONCURRENCY).toBe(4);
        expect(database.tables["platformUsage"]).toStrictEqual([expect.objectContaining({ deploymentId: "dep_1", quantity: 3 })]);
        // Every scope advanced its own checkpoint.
        expect(database.tables["usageCheckpoints"]).toHaveLength(scopes.length);
    });

    it("reports a scope whose read fails, and still advances the others", async () => {
        const database = memoryStore({ deployments, usageCheckpoints: [] });
        const failed: string[] = [];

        await runReadbackUsageSweep(
            database,
            [
                {
                    id: "cloudflare-workers",
                    usage: {
                        read: (scope) =>
                            scope === "cfa_1" ? Promise.reject(new Error("token revoked")) : Promise.resolve([{ requests: 2, resourceRef: "cfa_2/api" }]),
                        scopes: () => Promise.resolve(["cfa_1", "cfa_2"]),
                    },
                },
            ],
            { now: 10_000, onScopeFailed: (target, scope) => failed.push(`${target}/${scope}`), periodStart: 0 },
        );

        expect(failed).toStrictEqual(["cloudflare-workers/cfa_1"]);
        expect(database.tables["platformUsage"]).toStrictEqual([expect.objectContaining({ deploymentId: "dep_2", quantity: 2 })]);
        expect(database.tables["usageCheckpoints"]).toStrictEqual([expect.objectContaining({ scopeKey: "cfa_2" })]);
    });

    it("reads nothing, not even the deployments, without a fleet that reads usage", async () => {
        const database = memoryStore({ deployments });
        const findMany = vi.spyOn(database, "findMany");

        await runReadbackUsageSweep(database, [{ id: "cloudflare-wfp" }], { now: 1, onScopeFailed: () => undefined, periodStart: 0 });

        expect(findMany).not.toHaveBeenCalled();
    });
});
