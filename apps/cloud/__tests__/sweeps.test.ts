import { describe, expect, it, vi } from "vitest";

import { accrualBreached, RATE_CARD } from "../src/billing/spend";
import type { ReadbackFleet } from "../src/deploy/sweeps";
import { runReadbackUsageSweep, teardownPorts, USAGE_SCOPE_CONCURRENCY, usageAttributionOf, usageRollbackPorts } from "../src/deploy/sweeps";
import { runTeardownSweep } from "../src/deploy/teardown";
import { MAX_LOOKBACK_MS } from "../src/metering/rollback";
import type { SourceStatusRow } from "../src/metering/status";
import { meteringNotices } from "../src/metering/status";
import { UsageUnavailableError } from "../src/metering/unavailable";
import type { TargetId } from "../src/provision-contract";
import type { ControlPlaneDatabase } from "../src/store";
import { drainTable } from "../src/store";
import type { UsageReadback, UsageRow, UsageSource } from "../src/targets/driver";
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

/** A continuous source of `scope` that answers `rows` for any window. */
const source = (rows: UsageRow[], scope: string): UsageSource & { scope: string } => {
    return { cadence: "continuous", read: () => Promise.resolve(rows), scope };
};

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

        const ports = await usageRollbackPorts(database, source([], "default"), {
            attribution: await attributionOf(database, "cloudflare-wfp"),
            family: "requests",
            now: 1000,
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

        const ports = await usageRollbackPorts(database, source([], "default"), {
            attribution: await attributionOf(database, "cloudflare-wfp"),
            family: "requests",
            now: 1000,
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

        const ports = await usageRollbackPorts(database, source([], "default"), {
            attribution: new Map(),
            family: "requests",
            now: 1000,
            target: "cloudflare-wfp",
        });
        await ports.record({
            attribution: { deploymentId: "dep_a", organizationId: "org_a" },
            meter: "requests",
            periodStart: 777,
            quantity: 12,
            window: { sinceMs: 100, untilMs: 900 },
        });

        expect(insert).toHaveBeenCalledWith("platformUsage", {
            createdAt: 1000,
            deploymentId: "dep_a",
            kind: "requests",
            organizationId: "org_a",
            periodStart: 777,
            quantity: 12,
            windowEnd: 900,
            windowStart: 100,
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
        const ports = await usageRollbackPorts(database, source([], "cfa_1"), {
            attribution: await attributionOf(database, "cloudflare-workers"),
            family: "requests",
            now: 1000,
            target: "cloudflare-workers",
        });
        const attribution = ports.resolveResource("cfa_1/web");

        // A same-named script in another account is never this tenant's.
        expect(ports.resolveResource("cfa_2/web")).toBeUndefined();

        await ports.record({
            attribution: attribution as NonNullable<typeof attribution>,
            meter: "requests",
            periodStart: 777,
            quantity: 5,
            window: { sinceMs: 100, untilMs: 900 },
        });

        expect(insert).toHaveBeenCalledWith(
            "platformUsage",
            expect.objectContaining({ billable: false, deploymentId: "dep_byo", placementRef: "cfa_1", quantity: 5 }),
        );
    });

    /** The admission fast path (plan 365 W3) sees readback usage the moment it lands, not at the next cap sweep. */
    it("accrues a billable row into its org's running spend, and never a display-only one", async () => {
        const now = Date.UTC(2026, 9, 6);
        const period = Date.UTC(2026, 9, 1);
        const run = async (target: TargetId): Promise<Parameters<ControlPlaneDatabase["patch"]>[]> => {
            const patch = vi.fn<ControlPlaneDatabase["patch"]>(() => Promise.resolve(undefined));
            const database = fakeControlPlaneDb({ organizations: [{ _id: "org_a", spendNanoCents: 7, spendPeriod: period }], usageCheckpoints: [] }, { patch });
            const ports = await usageRollbackPorts(database, source([], "s"), { attribution: new Map(), family: "requests", now, target });

            await ports.record({
                attribution: { organizationId: "org_a" },
                meter: "requests",
                periodStart: period,
                quantity: 4,
                window: { sinceMs: period, untilMs: now },
            });

            return patch.mock.calls.filter((call) => call[2] === "organizations");
        };

        await expect(run("cloudflare-wfp")).resolves.toStrictEqual([
            ["org_a", { spendNanoCents: 7 + 4 * RATE_CARD.requests.nanoCentsPerUnit, spendPeriod: period }, "organizations"],
        ]);
        await expect(run("cloudflare-workers")).resolves.toStrictEqual([]);
    });

    it("starts a scope with no checkpoint row from nothing, so the rollback reads its bootstrap window", async () => {
        const database = fakeControlPlaneDb({ deployments: [], usageCheckpoints: [] });

        const ports = await usageRollbackPorts(database, source([], "default"), {
            attribution: new Map(),
            family: "requests",
            now: 1000,
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

        const ports = await usageRollbackPorts(database, source([], "default"), {
            attribution: new Map(),
            family: "requests",
            now: 1000,
            target: "cloudflare-wfp",
        });

        await expect(ports.getCheckpoint()).resolves.toBe(5000);
    });

    it("inserts the scope's checkpoint row on its first advance and patches it after", async () => {
        const insert = vi.fn<ControlPlaneDatabase["insert"]>(() => Promise.resolve("cp_new"));
        const patch = vi.fn<ControlPlaneDatabase["patch"]>(() => Promise.resolve(undefined));
        const first = fakeControlPlaneDb({ deployments: [], usageCheckpoints: [] }, { insert, patch });

        const firstPorts = await usageRollbackPorts(first, source([], "acct_1"), {
            attribution: new Map(),
            family: "requests",
            now: 1000,
            target: "cloudflare-wfp",
        });

        await firstPorts.setCheckpoint(4242);

        expect(insert).toHaveBeenCalledWith("usageCheckpoints", { readAtMs: 4242, scopeKey: "acct_1", target: "cloudflare-wfp", updatedAt: 1000 });
        expect(patch).not.toHaveBeenCalled();

        const later = fakeControlPlaneDb(
            { deployments: [], usageCheckpoints: [{ _id: "cp_1", readAtMs: 4242, scopeKey: "acct_1", target: "cloudflare-wfp" }] },
            { insert, patch },
        );

        const laterPorts = await usageRollbackPorts(later, source([], "acct_1"), {
            attribution: new Map(),
            family: "requests",
            now: 2000,
            target: "cloudflare-wfp",
        });

        await laterPorts.setCheckpoint(5000);

        expect(patch).toHaveBeenCalledWith("cp_1", { readAtMs: 5000, updatedAt: 2000 }, "usageCheckpoints");
    });

    it("starts a scope with no checkpoint and no old cell column from nothing (the bootstrap window applies)", async () => {
        const database = fakeControlPlaneDb({ deployments: [], usageCheckpoints: [] });

        const ports = await usageRollbackPorts(database, source([], "ghost"), {
            attribution: new Map(),
            family: "requests",
            now: 1000,
            target: "cloudflare-wfp",
        });

        await expect(ports.getCheckpoint()).resolves.toBeUndefined();
    });
});

/** Mid-month, so a continuous source's bootstrap hour never crosses a month boundary. */
const SWEEP_NOW = Date.UTC(2026, 5, 15, 10, 5);

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
                        scopes: () => Promise.resolve(scopes),
                        sources: {
                            requests: {
                                cadence: "continuous",
                                read: async (scope) => {
                                    inFlight += 1;
                                    peak = Math.max(peak, inFlight);
                                    await new Promise((resolve) => {
                                        setTimeout(resolve, 1);
                                    });
                                    inFlight -= 1;

                                    return scope === "cfa_1" ? [{ meters: { requests: 3 }, resourceRef: "cfa_1/web" }] : [];
                                },
                            },
                        },
                    },
                },
            ],
            { now: SWEEP_NOW, onScopeFailed: () => undefined },
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
                        scopes: () => Promise.resolve(["cfa_1", "cfa_2"]),
                        sources: {
                            requests: {
                                cadence: "continuous",
                                read: (scope) =>
                                    scope === "cfa_1"
                                        ? Promise.reject(new Error("analytics 503"))
                                        : Promise.resolve([{ meters: { requests: 2 }, resourceRef: "cfa_2/api" }]),
                            },
                        },
                    },
                },
            ],
            { now: SWEEP_NOW, onScopeFailed: (target, scope) => failed.push(`${target}/${scope}`) },
        );

        expect(failed).toStrictEqual(["cloudflare-workers/cfa_1"]);
        expect(database.tables["platformUsage"]).toStrictEqual([expect.objectContaining({ deploymentId: "dep_2", quantity: 2 })]);
        expect(database.tables["usageCheckpoints"]).toStrictEqual([expect.objectContaining({ scopeKey: "cfa_2" })]);
    });

    it("reads nothing, not even the deployments, without a fleet that reads usage", async () => {
        const database = memoryStore({ deployments });
        const findMany = vi.spyOn(database, "findMany");

        await runReadbackUsageSweep(database, [{ id: "cloudflare-wfp" }], { now: 1, onScopeFailed: () => undefined });

        expect(findMany).not.toHaveBeenCalled();
    });

    describe("storage families", () => {
        /** 10:20 on 15 June: the 09:00 hour has closed for longer than the lag. */
        const now = Date.UTC(2026, 5, 15, 10, 20);
        const june = Date.UTC(2026, 5, 1);
        const wfpDeployments = [
            { _id: "dep_shop", organizationId: "org_a", resourceRef: "shop", scriptName: "shop", status: "live", target: "cloudflare-wfp" },
        ];

        /** A `cloudflare-wfp` fleet of the cell `default` with the given sources. */
        const wfpFleet = (sources: UsageReadback["sources"]): ReadbackFleet => {
            return { id: "cloudflare-wfp", usage: { scopes: () => Promise.resolve(["default"]), sources } };
        };

        const requests: UsageSource = { cadence: "continuous", read: () => Promise.resolve([{ meters: { requests: 10 }, resourceRef: "shop" }]) };

        it("keeps one checkpoint per family, so a failing D1 read neither blocks nor skips the request window", async () => {
            const database = memoryStore({ deployments: wfpDeployments, organizations: [{ _id: "org_a", plan: "pro" }], usageCheckpoints: [] });
            const failed: string[] = [];

            await runReadbackUsageSweep(
                database,
                [
                    wfpFleet({
                        d1: { cadence: "hourly", read: () => Promise.reject(new Error("graphql 502")) },
                        durableObjects: { cadence: "hourly", read: () => Promise.resolve([{ meters: { doRowsWritten: 30 }, resourceRef: "shop" }]) },
                        requests,
                    }),
                ],
                { now, onScopeFailed: (target, scope) => failed.push(`${target}/${scope}`) },
            );

            expect(failed).toStrictEqual(["cloudflare-wfp/default#d1"]);
            // Requests keep the bare scope key their checkpoints were always stored under.
            expect(database.tables["usageCheckpoints"]).toStrictEqual([
                expect.objectContaining({ readAtMs: now, scopeKey: "default", target: "cloudflare-wfp" }),
                expect.objectContaining({ readAtMs: Date.UTC(2026, 5, 15, 10), scopeKey: "default#durableObjects", target: "cloudflare-wfp" }),
            ]);
            expect(database.tables["platformUsage"]?.map(({ kind, periodStart, quantity }) => [kind, periodStart, quantity])).toStrictEqual([
                ["requests", june, 10],
                ["doRowsWritten", june, 30],
            ]);
        });

        it("accrues billable storage rows into the org's running spend, priced per meter, like requests", async () => {
            const database = memoryStore({ deployments: wfpDeployments, organizations: [{ _id: "org_a", plan: "pro" }], usageCheckpoints: [] });

            await runReadbackUsageSweep(
                database,
                [
                    wfpFleet({
                        d1: { cadence: "hourly", read: () => Promise.resolve([{ meters: { d1RowsRead: 1000, d1RowsWritten: 2 }, resourceRef: "shop" }]) },
                        durableObjects: {
                            cadence: "hourly",
                            read: () => Promise.resolve([{ meters: { doRowsRead: 5_000_000_000, doRowsWritten: 3_000_000 }, resourceRef: "shop" }]),
                        },
                        requests,
                    }),
                ],
                { now, onScopeFailed: () => undefined },
            );

            const priced =
                10 * RATE_CARD.requests.nanoCentsPerUnit +
                1000 * RATE_CARD.d1RowsRead.nanoCentsPerUnit +
                2 * RATE_CARD.d1RowsWritten.nanoCentsPerUnit +
                5_000_000_000 * RATE_CARD.doRowsRead.nanoCentsPerUnit +
                3_000_000 * RATE_CARD.doRowsWritten.nanoCentsPerUnit;

            expect(database.tables["organizations"]).toStrictEqual([{ _id: "org_a", plan: "pro", spendNanoCents: priced, spendPeriod: june }]);
            // $8.00 of Durable Object rows alone: past a free org's cap, so admission refuses it the moment this lands.
            expect(accrualBreached({ plan: "free", spendNanoCents: priced, spendPeriod: june }, now)).toBe(true);
            expect(database.tables["platformUsage"]).toStrictEqual(
                ["requests", "d1RowsRead", "d1RowsWritten", "doRowsRead", "doRowsWritten"].map((kind): unknown =>
                    expect.objectContaining({ deploymentId: "dep_shop", kind, organizationId: "org_a", periodStart: june }),
                ),
            );
        });

        it("records a source that cannot read as visible state, never as zero, and never as a checkpoint", async () => {
            const database = memoryStore({ deployments: wfpDeployments, usageCheckpoints: [] });
            const unavailable: string[] = [];

            await runReadbackUsageSweep(
                database,
                [
                    wfpFleet({
                        durableObjects: {
                            cadence: "hourly",
                            read: () => Promise.reject(new UsageUnavailableError("no Durable Objects dataset reports rowsRead/rowsWritten")),
                        },
                    }),
                ],
                { now, onScopeFailed: () => undefined, onUnavailable: (_target, scope, message) => unavailable.push(`${scope}: ${message}`) },
            );

            const message = "storage metering unavailable: no Durable Objects dataset reports rowsRead/rowsWritten";

            expect(unavailable).toStrictEqual([`default: ${message}`]);
            expect(database.tables["usageSourceStatus"]).toStrictEqual([
                { _id: "usageSourceStatus_1", scopeKey: "default#durableObjects", target: "cloudflare-wfp", unavailableReason: message, updatedAt: now },
            ]);
            expect(database.tables["usageCheckpoints"]).toStrictEqual([]);
            expect(database.tables["platformUsage"]).toBeUndefined();
            // The member-facing notice, read off the same row.
            expect(meteringNotices(database.tables["usageSourceStatus"] as unknown as SourceStatusRow[], [], "default", now)).toStrictEqual([
                {
                    family: "durableObjects",
                    message: expect.stringContaining("Durable Object rows read and written are not counted") as string,
                    source: "Lunora Cloud",
                },
            ]);
        });

        it("reports a refused token (as the drivers translate it) the same way, and clears the state once the source reads again", async () => {
            const database = memoryStore({ deployments: wfpDeployments, usageCheckpoints: [] });
            let refuse = true;
            const fleet = wfpFleet({
                d1: {
                    cadence: "hourly",
                    read: () =>
                        refuse
                            ? Promise.reject(new UsageUnavailableError("Cloudflare refused the token for the GraphQL Analytics API"))
                            : Promise.resolve([{ meters: { d1RowsRead: 4 }, resourceRef: "shop" }]),
                },
            });

            await runReadbackUsageSweep(database, [fleet], { now, onScopeFailed: () => undefined });

            expect(database.tables["usageSourceStatus"]).toStrictEqual([
                expect.objectContaining({
                    scopeKey: "default#d1",
                    unavailableReason: "storage metering unavailable: Cloudflare refused the token for the GraphQL Analytics API",
                }),
            ]);
            expect(database.tables["usageCheckpoints"]).toStrictEqual([]);

            refuse = false;
            await runReadbackUsageSweep(database, [fleet], { now: now + 60 * 60 * 1000, onScopeFailed: () => undefined });

            // The checkpoint starts where it would have: nothing was skipped while the source could not read.
            expect(database.tables["usageCheckpoints"]).toStrictEqual([
                expect.objectContaining({ readAtMs: Date.UTC(2026, 5, 15, 11), scopeKey: "default#d1" }),
            ]);
            expect(database.tables["usageSourceStatus"]).toStrictEqual([
                expect.objectContaining({ scopeKey: "default#d1", unattributedQuantity: 0, unavailableReason: null }),
            ]);
            expect(database.tables["platformUsage"]).toStrictEqual([expect.objectContaining({ kind: "d1RowsRead", quantity: 4 })]);
        });

        it("keeps the volume of resources no deployment matches in the source's status", async () => {
            const database = memoryStore({ deployments: wfpDeployments, usageCheckpoints: [] });

            await runReadbackUsageSweep(
                database,
                [
                    wfpFleet({
                        durableObjects: {
                            cadence: "hourly",
                            read: () => Promise.resolve([{ meters: { doRowsRead: 70, doRowsWritten: 3 }, resourceRef: "namespace:ns-gone" }]),
                        },
                    }),
                ],
                { now, onScopeFailed: () => undefined },
            );

            expect(database.tables["usageSourceStatus"]).toStrictEqual([
                expect.objectContaining({ scopeKey: "default#durableObjects", unattributedQuantity: 73 }),
            ]);
        });

        it("writes a display-only row for a connected account's storage, which never moves the spend", async () => {
            const database = memoryStore({
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
                organizations: [{ _id: "org_a", plan: "free" }],
                usageCheckpoints: [],
            });

            await runReadbackUsageSweep(
                database,
                [
                    {
                        id: "cloudflare-workers",
                        usage: {
                            scopes: () => Promise.resolve(["cfa_1"]),
                            sources: {
                                durableObjects: {
                                    cadence: "hourly",
                                    read: () => Promise.resolve([{ meters: { doRowsWritten: 9 }, resourceRef: "cfa_1/web" }]),
                                },
                            },
                        },
                    },
                ],
                { now, onScopeFailed: () => undefined },
            );

            expect(database.tables["platformUsage"]).toStrictEqual([
                expect.objectContaining({ billable: false, kind: "doRowsWritten", placementRef: "cfa_1", quantity: 9 }),
            ]);
            expect(database.tables["organizations"]).toStrictEqual([{ _id: "org_a", plan: "free" }]);
        });

        it("keeps a source that keeps failing visible, from its first failure, and clears it once it reads", async () => {
            const database = memoryStore({ deployments: wfpDeployments, usageCheckpoints: [] });
            let failing = true;
            const fleet = wfpFleet({
                d1: {
                    cadence: "hourly",
                    read: () => (failing ? Promise.reject(new Error("GraphQL 429: rate limited")) : Promise.resolve([])),
                },
            });

            await runReadbackUsageSweep(database, [fleet], { now, onScopeFailed: () => undefined });
            await runReadbackUsageSweep(database, [fleet], { now: now + 4 * 60 * 60 * 1000, onScopeFailed: () => undefined });

            const [row] = database.tables["usageSourceStatus"] as unknown as SourceStatusRow[];

            expect(row).toMatchObject({ failingSince: now, lastError: "GraphQL 429: rate limited", scopeKey: "default#d1" });
            // Shown once it has failed for a while; a single blip is not.
            expect(meteringNotices([row], [], "default", now)).toStrictEqual([]);
            expect(meteringNotices([row], [], "default", now + 4 * 60 * 60 * 1000)).toStrictEqual([
                expect.objectContaining({ family: "d1", message: expect.stringContaining("has not been able to read this usage since") as string }),
            ]);

            failing = false;
            await runReadbackUsageSweep(database, [fleet], { now: now + 5 * 60 * 60 * 1000, onScopeFailed: () => undefined });

            expect(database.tables["usageSourceStatus"]).toStrictEqual([expect.objectContaining({ failingSince: null, lastError: null })]);
        });

        it("bills requests even when the status table cannot be read or written", async () => {
            const database = memoryStore({ deployments: wfpDeployments, organizations: [{ _id: "org_a", plan: "pro" }], usageCheckpoints: [] });
            const findMany = database.findMany.bind(database);
            const failed: string[] = [];

            database.findMany = (table, args) => (table === "usageSourceStatus" ? Promise.reject(new Error("no such table")) : findMany(table, args));

            await runReadbackUsageSweep(database, [wfpFleet({ requests })], { now, onScopeFailed: (_target, scope) => failed.push(scope) });

            expect(database.tables["platformUsage"]).toStrictEqual([expect.objectContaining({ kind: "requests", quantity: 10 })]);
            expect(database.tables["usageCheckpoints"]).toStrictEqual([expect.objectContaining({ readAtMs: now, scopeKey: "default" })]);
            expect(failed).toStrictEqual(["default (status)"]);
        });

        it("reports a checkpoint older than Cloudflare keeps as a gap, and reads on from what is kept", async () => {
            const stale = now - MAX_LOOKBACK_MS - 10 * 24 * 60 * 60 * 1000;
            const database = memoryStore({
                deployments: wfpDeployments,
                usageCheckpoints: [{ _id: "cp", readAtMs: stale, scopeKey: "default", target: "cloudflare-wfp", updatedAt: 0 }],
            });
            const notes: string[] = [];

            await runReadbackUsageSweep(database, [wfpFleet({ requests })], {
                now,
                onNote: (_target, scopeKey, message) => notes.push(`${scopeKey}: ${message}`),
                onScopeFailed: () => undefined,
            });

            const gap = `usage from ${new Date(stale).toISOString()} to ${new Date(now - MAX_LOOKBACK_MS).toISOString()} was older than Cloudflare keeps it and was not read`;

            expect(notes).toStrictEqual([`default: ${gap}`]);
            expect(database.tables["usageSourceStatus"]).toStrictEqual([expect.objectContaining({ gapNote: gap, gapRecordedAt: now })]);
            expect(database.tables["usageCheckpoints"]).toStrictEqual([expect.objectContaining({ readAtMs: now })]);
        });

        it("logs the volume it could not attribute", async () => {
            const database = memoryStore({ deployments: wfpDeployments, usageCheckpoints: [] });
            const notes: string[] = [];

            await runReadbackUsageSweep(
                database,
                [
                    wfpFleet({
                        durableObjects: {
                            cadence: "hourly",
                            read: () => Promise.resolve([{ meters: { doRowsRead: 70 }, resourceRef: "unattributed:namespace:x" }]),
                        },
                    }),
                ],
                { now, onNote: (_target, scopeKey, message) => notes.push(`${scopeKey}: ${message}`), onScopeFailed: () => undefined },
            );

            expect(notes).toStrictEqual(["default#durableObjects: 70 read for resources no deployment matches (not billed)"]);
        });
    });
});
