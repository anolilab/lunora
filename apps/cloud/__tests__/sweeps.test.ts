import { describe, expect, it, vi } from "vitest";

import { teardownPorts, usageRollbackPorts } from "../src/deploy/sweeps";
import type { ControlPlaneDatabase } from "../src/store";
import type { UsageRow } from "../src/targets/driver";
import fakeControlPlaneDb from "./_helpers/fake-control-plane-db";

describe(teardownPorts, () => {
    const noop = { deleteRelease: () => Promise.resolve(), destroy: () => Promise.resolve() };
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

        const ports = await usageRollbackPorts(database, reader([]), { cellName: "default", now: 1000, periodStart: 500, target: "cloudflare-wfp" });

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

        const ports = await usageRollbackPorts(database, reader([]), { cellName: "default", now: 1000, periodStart: 0, target: "cloudflare-wfp" });

        expect(ports.resolveResource("a")).toStrictEqual({ deploymentId: "dep_wfp", organizationId: "org_a" });
        // Another target's resource never lands on this target's bill.
        expect(ports.resolveResource("fleets/b")).toBeUndefined();
        expect(ports.resolveResource("b")).toBeUndefined();
    });

    it("records a requests row into platformUsage with the period + attribution", async () => {
        const insert = vi.fn<ControlPlaneDatabase["insert"]>(() => Promise.resolve("id"));
        const database = fakeControlPlaneDb({ cells: [{ _id: "cell_1" }], deployments: [] }, { insert });

        const ports = await usageRollbackPorts(database, reader([]), { cellName: "default", now: 1000, periodStart: 777, target: "cloudflare-wfp" });
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

    it("advances the cell's usageReadAtMs on setCheckpoint", async () => {
        const patch = vi.fn<ControlPlaneDatabase["patch"]>(() => Promise.resolve(undefined));
        const database = fakeControlPlaneDb({ cells: [{ _id: "cell_1", name: "default" }], deployments: [] }, { patch });

        const ports = await usageRollbackPorts(database, reader([]), { cellName: "default", now: 1000, periodStart: 0, target: "cloudflare-wfp" });
        await ports.setCheckpoint(4242);

        expect(patch).toHaveBeenCalledWith("cell_1", { usageReadAtMs: 4242 }, "cells");
    });

    it("no-ops setCheckpoint when the cell row is missing (unregistered cell)", async () => {
        const patch = vi.fn<ControlPlaneDatabase["patch"]>(() => Promise.resolve(undefined));
        const database = fakeControlPlaneDb({ cells: [], deployments: [] }, { patch });

        const ports = await usageRollbackPorts(database, reader([]), { cellName: "ghost", now: 1000, periodStart: 0, target: "cloudflare-wfp" });
        await ports.setCheckpoint(4242);

        await expect(ports.getCheckpoint()).resolves.toBeUndefined();

        expect(patch).not.toHaveBeenCalled();
    });
});
