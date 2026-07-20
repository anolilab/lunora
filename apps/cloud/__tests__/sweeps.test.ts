import { describe, expect, it, vi } from "vitest";

import type { AnalyticsUsageReader } from "../src/metering/analytics";
import type { ControlPlaneDb } from "../src/deploy/sweeps";
import { teardownPorts, usageRollbackPorts } from "../src/deploy/sweeps";

/** A fake ControlPlaneDb whose findMany answers per-table from the given pages. */
const fakeDb = (pages: Record<string, unknown[]>, spies: Partial<ControlPlaneDb> = {}): ControlPlaneDb => ({
    findMany: (table) => Promise.resolve({ page: pages[table] ?? [] }),
    insert: () => Promise.resolve("id"),
    patch: () => Promise.resolve(undefined),
    ...spies,
});

describe(teardownPorts, () => {
    it("lists only destroyed-and-not-torn-down rows, mapped to lunora-{kind} targets", async () => {
        const database = fakeDb({
            deployments: [
                { _id: "d1", kind: "preview", scriptName: "a-v1" }, // pending
                { _id: "d2", kind: "production", scriptName: "b-v2", teardownAt: 123 }, // already torn down
            ],
        });

        const ports = teardownPorts(database, () => Promise.resolve(), 1000);
        const pending = await ports.listPending();

        expect(pending).toStrictEqual([{ dispatchNamespace: "lunora-preview", id: "d1", scriptName: "a-v1" }]);
    });

    it("stamps teardownAt + updatedAt on the deployments table when marking torn down", async () => {
        const patch = vi.fn(() => Promise.resolve(undefined));
        const ports = teardownPorts(fakeDb({}, { patch }), () => Promise.resolve(), 5000);

        await ports.markTornDown("dep_1");

        expect(patch).toHaveBeenCalledWith("dep_1", { teardownAt: 5000, updatedAt: 5000 }, "deployments");
    });
});

const reader = (rows: { requests: number; scriptName: string }[]): AnalyticsUsageReader => ({ readRequestUsage: () => Promise.resolve(rows) });

describe(usageRollbackPorts, () => {
    it("resolves a script to its owning org/deployment from the deployments table", async () => {
        const database = fakeDb({
            cells: [{ _id: "cell_1", usageReadAtMs: 999 }],
            deployments: [{ _id: "dep_a", organizationId: "org_a", scriptName: "a-v1" }],
        });

        const ports = await usageRollbackPorts(database, reader([]), { cellName: "default", now: 1000, periodStart: 500 });

        expect(ports.resolveScript("a-v1")).toStrictEqual({ deploymentId: "dep_a", organizationId: "org_a" });
        expect(ports.resolveScript("missing")).toBeUndefined();
        await expect(ports.getCheckpoint()).resolves.toBe(999);
    });

    it("records a requests row into platformUsage with the period + attribution", async () => {
        const insert = vi.fn(() => Promise.resolve("id"));
        const database = fakeDb({ cells: [{ _id: "cell_1" }], deployments: [] }, { insert });

        const ports = await usageRollbackPorts(database, reader([]), { cellName: "default", now: 1000, periodStart: 777 });
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
        const patch = vi.fn(() => Promise.resolve(undefined));
        const database = fakeDb({ cells: [{ _id: "cell_1" }], deployments: [] }, { patch });

        const ports = await usageRollbackPorts(database, reader([]), { cellName: "default", now: 1000, periodStart: 0 });
        await ports.setCheckpoint(4242);

        expect(patch).toHaveBeenCalledWith("cell_1", { usageReadAtMs: 4242 }, "cells");
    });

    it("no-ops setCheckpoint when the cell row is missing (unregistered cell)", async () => {
        const patch = vi.fn(() => Promise.resolve(undefined));
        const database = fakeDb({ cells: [], deployments: [] }, { patch });

        const ports = await usageRollbackPorts(database, reader([]), { cellName: "ghost", now: 1000, periodStart: 0 });
        await ports.setCheckpoint(4242);
        await expect(ports.getCheckpoint()).resolves.toBeUndefined();

        expect(patch).not.toHaveBeenCalled();
    });
});
