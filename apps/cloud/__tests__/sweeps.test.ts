import { describe, expect, it, vi } from "vitest";

import { teardownPorts, usageRollbackPorts } from "../src/deploy/sweeps";
import type { ControlPlaneDatabase } from "../src/store";
import type { UsageRow } from "../src/targets/driver";
import fakeControlPlaneDb from "./_helpers/fake-control-plane-db";
import { fakeDriver } from "./support/memory-driver";

describe(teardownPorts, () => {
    const noop = {
        accounts: () => Promise.resolve(null),
        boxes: { byId: () => Promise.resolve(null), forAlias: () => Promise.resolve(null) },
        deleteRelease: () => Promise.resolve(),
        driverFor: () => fakeDriver(),
        log: () => undefined,
    };
    const everyTarget = (): boolean => true;

    it("destroys the Worker of an alias with no deployment left, once, and skips torn-down rows", async () => {
        const database = fakeControlPlaneDb({
            deployments: [
                { _id: "d1", alias: "a", kind: "preview", scriptName: "a", status: "destroyed" },
                { _id: "d3", alias: "a", kind: "preview", scriptName: "a", status: "destroyed" },
                { _id: "d2", alias: "b", kind: "production", scriptName: "b", status: "destroyed", teardownAt: 123 },
            ],
        });

        const pending = await teardownPorts(database, noop, 1000, everyTarget).listPending();

        // One destroy job per dead alias; the other row only drops its stored bundle.
        expect(pending).toStrictEqual([
            { alias: "a", destroyWorker: true, id: "d1", target: "cloudflare-wfp" },
            { alias: "a", destroyWorker: false, id: "d3", target: "cloudflare-wfp" },
        ]);
    });

    it("prunes stored bundles beyond retention but never the Worker the live release runs on", async () => {
        const database = fakeControlPlaneDb({
            deployments: [
                { _id: "v1", alias: "app", kind: "production", scriptName: "app", status: "destroyed" }, // pruned
                { _id: "v2", alias: "app", kind: "production", scriptName: "app", status: "failed" }, // never a rollback target
                { _id: "v3", alias: "app", kind: "production", scriptName: "app", status: "superseded" }, // retained
                { _id: "v4", alias: "app", kind: "production", scriptName: "app", status: "live" },
            ],
        });

        const pending = await teardownPorts(database, noop, 1000, everyTarget).listPending();

        expect(pending).toStrictEqual([
            { alias: "app", destroyWorker: false, id: "v1", target: "cloudflare-wfp" },
            { alias: "app", destroyWorker: false, id: "v2", target: "cloudflare-wfp" },
        ]);
    });

    it("keeps the Worker of an alias whose only other deployment failed", async () => {
        const database = fakeControlPlaneDb({
            deployments: [
                { _id: "v1", alias: "app", kind: "production", scriptName: "app", status: "destroyed" },
                { _id: "v2", alias: "app", kind: "production", scriptName: "app", status: "failed" },
            ],
        });

        const pending = await teardownPorts(database, noop, 1000, everyTarget).listPending();

        expect(pending.map((row) => row.destroyWorker)).toStrictEqual([false, false]);
    });

    it("leaves the rows of a target that cannot converge here pending, and acts on the rest", async () => {
        const database = fakeControlPlaneDb({
            deployments: [
                { _id: "wfp", alias: "a", kind: "production", scriptName: "a", status: "destroyed" },
                { _id: "box", alias: "b", kind: "production", scriptName: "b", status: "destroyed", target: "celld-vps" },
                // An id no target answers to waits too, rather than failing the sweep.
                { _id: "odd", alias: "c", kind: "production", scriptName: "c", status: "destroyed", target: "aws-lambda" },
            ],
        });

        const pending = await teardownPorts(database, noop, 1000, (target) => target === "cloudflare-wfp").listPending();

        expect(pending).toStrictEqual([{ alias: "a", destroyWorker: true, id: "wfp", target: "cloudflare-wfp" }]);
    });

    it("hands each row to its own target, reading a NULL target as cloudflare-wfp", async () => {
        const database = fakeControlPlaneDb({
            deployments: [
                { _id: "old", alias: "a", kind: "production", scriptName: "a", status: "destroyed", target: null },
                { _id: "box", alias: "b", kind: "production", scriptName: "b", status: "destroyed", target: "celld-vps" },
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
                { _id: "old", alias: "web", boxId: "box_old", createdAt: 1, kind: "production", scriptName: "web", status: "destroyed", target: "celld-vps" },
                { _id: "new", alias: "web", boxId: "box_new", createdAt: 2, kind: "production", scriptName: "web", status: "destroyed", target: "celld-vps" },
                { _id: "wfp", alias: "a", kind: "production", scriptName: "a", status: "destroyed" },
            ],
        });

        const pending = await teardownPorts(database, noop, 1000, everyTarget).listPending();

        expect(pending).toStrictEqual([
            { alias: "web", boxId: "box_new", destroyWorker: true, id: "old", target: "celld-vps" },
            { alias: "web", boxId: "box_new", destroyWorker: false, id: "new", target: "celld-vps" },
            { alias: "a", destroyWorker: true, id: "wfp", target: "cloudflare-wfp" },
        ]);
    });

    it("tears a cloudflare-workers alias down in the account its newest deployment names", async () => {
        const database = fakeControlPlaneDb({
            deployments: [
                {
                    _id: "byo",
                    alias: "web",
                    cloudflareAccountId: "cfa_1",
                    createdAt: 1,
                    kind: "production",
                    scriptName: "web",
                    status: "destroyed",
                    target: "cloudflare-workers",
                },
            ],
        });
        const destroyed: unknown[] = [];
        const account = { accountId: "a".repeat(32), id: "cfa_1", workersSubdomain: "acme" };
        const ports = teardownPorts(
            database,
            {
                ...noop,
                accounts: (id) => Promise.resolve(id === "cfa_1" ? account : null),
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

        expect(pending).toStrictEqual({ alias: "web", cloudflareAccountId: "cfa_1", destroyWorker: true, id: "byo", target: "cloudflare-workers" });

        await ports.destroy(pending);

        expect(destroyed).toStrictEqual([{ alias: "web", placement: { account, target: "cloudflare-workers" } }]);
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

        await ports.destroy({ alias: "web", cloudflareAccountId: "cfa_gone", destroyWorker: true, id: "byo", target: "cloudflare-workers" });

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

    it("releaseAlias deletes the ownership ledger row(s) for the alias", async () => {
        const deleteRow = vi.fn<ControlPlaneDatabase["delete"]>(() => Promise.resolve(undefined));
        const database = fakeControlPlaneDb({ aliasOwnership: [{ _id: "ao_1", alias: "app" }] }, { delete: deleteRow });
        const ports = teardownPorts(database, noop, 1000, everyTarget);

        await ports.releaseAlias("app");

        expect(deleteRow).toHaveBeenCalledWith("ao_1", "aliasOwnership");
    });

    it("releaseAlias is a no-op when no ownership row exists (pre-ledger or already released)", async () => {
        const deleteRow = vi.fn<ControlPlaneDatabase["delete"]>(() => Promise.resolve(undefined));
        const ports = teardownPorts(fakeControlPlaneDb({ aliasOwnership: [] }, { delete: deleteRow }), noop, 1000, everyTarget);

        await ports.releaseAlias("ghost");

        expect(deleteRow).not.toHaveBeenCalled();
    });
});

const reader =
    (rows: UsageRow[]): ((sinceMs: number) => Promise<UsageRow[]>) =>
    () =>
        Promise.resolve(rows);

describe(usageRollbackPorts, () => {
    it("resolves a script to its owning org/deployment from the deployments table", async () => {
        const database = fakeControlPlaneDb({
            // `name` matters: the port reads the checkpoint `where: { name: cellName }`,
            // so a row without it is a different cell. The old fake returned it anyway.
            cells: [{ _id: "cell_1", name: "default", usageReadAtMs: 999 }],
            deployments: [
                { _id: "dep_old", organizationId: "org_a", scriptName: "a", status: "superseded" },
                { _id: "dep_a", organizationId: "org_a", scriptName: "a", status: "live" },
                { _id: "dep_new", organizationId: "org_a", scriptName: "a", status: "failed" },
            ],
        });

        const ports = await usageRollbackPorts(database, reader([]), { now: 1000, periodStart: 500, scope: "default", target: "cloudflare-wfp" });

        // Every release shares the alias's script; its usage lands on the live one.
        expect(ports.resolveResource("a")).toStrictEqual({ deploymentId: "dep_a", organizationId: "org_a" });
        expect(ports.resolveResource("missing")).toBeUndefined();
        await expect(ports.getCheckpoint()).resolves.toBe(999);
    });

    it("attributes only the swept target's deployments, by resourceRef where a row has one", async () => {
        const database = fakeControlPlaneDb({
            cells: [{ _id: "cell_1", name: "default" }],
            deployments: [
                { _id: "dep_wfp", organizationId: "org_a", resourceRef: "a", scriptName: "a", status: "live", target: "cloudflare-wfp" },
                { _id: "dep_box", organizationId: "org_b", resourceRef: "fleets/b", scriptName: "b", status: "live", target: "celld-vps" },
            ],
        });

        const ports = await usageRollbackPorts(database, reader([]), { now: 1000, periodStart: 0, scope: "default", target: "cloudflare-wfp" });

        expect(ports.resolveResource("a")).toStrictEqual({ deploymentId: "dep_wfp", organizationId: "org_a" });
        // Another target's resource never lands on this target's bill.
        expect(ports.resolveResource("fleets/b")).toBeUndefined();
        expect(ports.resolveResource("b")).toBeUndefined();
    });

    it("records a requests row into platformUsage with the period + attribution", async () => {
        const insert = vi.fn<ControlPlaneDatabase["insert"]>(() => Promise.resolve("id"));
        const database = fakeControlPlaneDb({ cells: [{ _id: "cell_1" }], deployments: [] }, { insert });

        const ports = await usageRollbackPorts(database, reader([]), { now: 1000, periodStart: 777, scope: "default", target: "cloudflare-wfp" });
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
                        cloudflareAccountId: "cfa_1",
                        organizationId: "org_a",
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
        const ports = await usageRollbackPorts(database, reader([]), { now: 1000, periodStart: 777, scope: "cfa_1", target: "cloudflare-workers" });
        const attribution = ports.resolveResource("cfa_1/web");

        // A same-named script in another account is never this tenant's.
        expect(ports.resolveResource("cfa_2/web")).toBeUndefined();

        await ports.record({ attribution: attribution as NonNullable<typeof attribution>, quantity: 5 });

        expect(insert).toHaveBeenCalledWith("platformUsage", expect.objectContaining({ cloudflareAccountId: "cfa_1", deploymentId: "dep_byo", quantity: 5 }));
    });

    it("seeds a cloudflare-wfp cell's first checkpoint from its old cells.usageReadAtMs", async () => {
        const database = fakeControlPlaneDb({ cells: [{ _id: "cell_1", name: "default", usageReadAtMs: 999 }], deployments: [], usageCheckpoints: [] });

        const ports = await usageRollbackPorts(database, reader([]), { now: 1000, periodStart: 0, scope: "default", target: "cloudflare-wfp" });

        await expect(ports.getCheckpoint()).resolves.toBe(999);
    });

    it("reads the scope's own checkpoint row, never the old column, once one exists", async () => {
        const database = fakeControlPlaneDb({
            cells: [{ _id: "cell_1", name: "default", usageReadAtMs: 999 }],
            deployments: [],
            usageCheckpoints: [
                { _id: "cp_other", readAtMs: 7, scopeKey: "eu-1", target: "cloudflare-wfp" },
                { _id: "cp_1", readAtMs: 5000, scopeKey: "default", target: "cloudflare-wfp" },
            ],
        });

        const ports = await usageRollbackPorts(database, reader([]), { now: 1000, periodStart: 0, scope: "default", target: "cloudflare-wfp" });

        await expect(ports.getCheckpoint()).resolves.toBe(5000);
    });

    it("inserts the scope's checkpoint row on its first advance and patches it after", async () => {
        const insert = vi.fn<ControlPlaneDatabase["insert"]>(() => Promise.resolve("cp_new"));
        const patch = vi.fn<ControlPlaneDatabase["patch"]>(() => Promise.resolve(undefined));
        const first = fakeControlPlaneDb({ cells: [], deployments: [], usageCheckpoints: [] }, { insert, patch });

        const firstPorts = await usageRollbackPorts(first, reader([]), { now: 1000, periodStart: 0, scope: "acct_1", target: "cloudflare-wfp" });

        await firstPorts.setCheckpoint(4242);

        expect(insert).toHaveBeenCalledWith("usageCheckpoints", { readAtMs: 4242, scopeKey: "acct_1", target: "cloudflare-wfp", updatedAt: 1000 });
        expect(patch).not.toHaveBeenCalled();

        const later = fakeControlPlaneDb(
            { cells: [], deployments: [], usageCheckpoints: [{ _id: "cp_1", readAtMs: 4242, scopeKey: "acct_1", target: "cloudflare-wfp" }] },
            { insert, patch },
        );

        const laterPorts = await usageRollbackPorts(later, reader([]), { now: 2000, periodStart: 0, scope: "acct_1", target: "cloudflare-wfp" });

        await laterPorts.setCheckpoint(5000);

        expect(patch).toHaveBeenCalledWith("cp_1", { readAtMs: 5000, updatedAt: 2000 }, "usageCheckpoints");
    });

    it("starts a scope with no checkpoint and no old cell column from nothing (the bootstrap window applies)", async () => {
        const database = fakeControlPlaneDb({ cells: [], deployments: [], usageCheckpoints: [] });

        const ports = await usageRollbackPorts(database, reader([]), { now: 1000, periodStart: 0, scope: "ghost", target: "cloudflare-wfp" });

        await expect(ports.getCheckpoint()).resolves.toBeUndefined();
    });
});
