import { LunoraError } from "@lunora/errors";
import { describe, expect, it } from "vitest";

import type { HaltRow } from "../src/deploy/halt";
import {
    HALT_LEASE_MS,
    haltBackoff,
    liveByAlias,
    requestOrganizationHalt,
    requestOrganizationResume,
    runHaltConverges,
    syncSuspensionHalts,
} from "../src/deploy/halt";
import { haltAlias, organizationsOnCell } from "../src/deploy/halt-converge";
import { buildHaltStub, classesOf } from "../src/deploy/halt-stub";
import { teardownPorts } from "../src/deploy/sweeps";
import type { DeployManifest, TenantDeploymentSpec } from "../src/provision-contract";
import { storeRowReader } from "../src/targets/placement";
import { actions, deployment, haltOf, halts, LIVE_MANIFEST, NOW, ports, release, sourceOf, world } from "./support/halt-world";
import { fakeDriver } from "./support/memory-driver";
import type { MemoryStore } from "./support/memory-store";

/**
 * The emergency stop's sweep (`src/deploy/halt.ts`) and its two converges
 * (`src/deploy/halt-converge.ts`), driven end to end over the in-memory store,
 * release store and target: what a suspension halts and resumes, what lands on
 * the Worker each way, and how a failing converge is recorded, retried and paced.
 */

describe(syncSuspensionHalts, () => {
    it("halts every live alias on a suspension the setting covers — but not a box's", async () => {
        const { database } = await world({ suspendedAt: NOW - 1, suspendedReason: "spend-cap" });

        await expect(syncSuspensionHalts(database, NOW)).resolves.toStrictEqual({ failed: 0, halted: 2, resumed: 0 });
        expect(halts(database).map((row) => [row.alias, row.state, row.source, row.reason, row.haltedBy])).toStrictEqual([
            ["acme", "halting", "suspension", "spend-cap", "system:halt-on-suspension"],
            ["shop", "halting", "suspension", "spend-cap", "system:halt-on-suspension"],
        ]);
        expect(actions(database)).toStrictEqual(["halt.requested"]);
        // Idempotent: a second tick asks for nothing new.
        await expect(syncSuspensionHalts(database, NOW + 60_000)).resolves.toStrictEqual({ failed: 0, halted: 0, resumed: 0 });
    });

    it("halts on an overage suspension too", async () => {
        const { database } = await world({ suspendedAt: NOW - 1, suspendedReason: "overage" });

        await expect(syncSuspensionHalts(database, NOW)).resolves.toMatchObject({ halted: 2 });
    });

    it.each([
        ["dunning", { suspendedAt: NOW - 1, suspendedReason: "dunning" }],
        ["support", { suspendedAt: NOW - 1, suspendedReason: "support" }],
        ["the setting turned off", { haltOnSuspension: false, suspendedAt: NOW - 1, suspendedReason: "spend-cap" }],
        ["no suspension", {}],
    ])("never halts on %s", async (_label, organization) => {
        const { database } = await world(organization);

        await expect(syncSuspensionHalts(database, NOW)).resolves.toStrictEqual({ failed: 0, halted: 0, resumed: 0 });
        expect(halts(database)).toStrictEqual([]);
    });

    it("resumes a suspension's halts once it lifts, and never a manual halt", async () => {
        const { database } = await world({ suspendedAt: NOW - 1, suspendedReason: "spend-cap" });

        await syncSuspensionHalts(database, NOW);
        await database.patch((haltOf(database, "acme") as HaltRow)._id, { haltedBy: "usr_1", source: "manual" });
        await database.patch("org_1", { suspendedAt: null, suspendedReason: null });

        await expect(syncSuspensionHalts(database, NOW + 60_000)).resolves.toStrictEqual({ failed: 0, halted: 0, resumed: 1 });
        expect(haltOf(database, "acme")?.state).toBe("halting");
        expect(haltOf(database, "shop")?.state).toBe("resuming");
    });

    it("resumes a suspension's halts when the owner turns the setting off", async () => {
        const { database } = await world({ suspendedAt: NOW - 1, suspendedReason: "spend-cap" });

        await syncSuspensionHalts(database, NOW);
        await database.patch("org_1", { haltOnSuspension: false });
        await syncSuspensionHalts(database, NOW + 60_000);

        expect(halts(database).map((row) => row.state)).toStrictEqual(["resuming", "resuming"]);
    });
});

describe(requestOrganizationHalt, () => {
    it("takes a suspension's halts over, so lifting the suspension leaves a manual stop in place", async () => {
        const { database } = await world({ suspendedAt: NOW - 1, suspendedReason: "spend-cap" });

        await syncSuspensionHalts(database, NOW);

        const result = await requestOrganizationHalt(database, { actor: "usr_1", now: NOW, organizationId: "org_1", reason: "manual", source: "manual" });

        expect(result.unsupported).toStrictEqual([{ alias: "edge", reason: expect.stringMatching(/your own server/u) }]);
        expect(halts(database).map((row) => row.source)).toStrictEqual(["manual", "manual"]);

        await database.patch("org_1", { suspendedAt: null, suspendedReason: null });
        await syncSuspensionHalts(database, NOW + 60_000);

        expect(halts(database).map((row) => row.state)).toStrictEqual(["halting", "halting"]);
    });

    it("turns a requested resume back into a halt", async () => {
        const { database } = await world();

        await requestOrganizationHalt(database, { actor: "usr_1", now: NOW, organizationId: "org_1", reason: "manual", source: "manual" });
        await requestOrganizationResume(database, { actor: "usr_1", now: NOW, organizationId: "org_1" });
        await requestOrganizationHalt(database, { actor: "usr_1", now: NOW, organizationId: "org_1", reason: "manual", source: "manual" });

        expect(halts(database).map((row) => row.state)).toStrictEqual(["halting", "halting"]);
        expect(actions(database)).toStrictEqual(["halt.requested", "halt.resume_requested", "halt.requested"]);
    });
});

describe(runHaltConverges, () => {
    it("converges each alias onto a stub of its live release's classes — no secrets, crons or consumers — and records it halted", async () => {
        const { converged, database, deps } = await world({ suspendedAt: NOW - 1, suspendedReason: "spend-cap" });

        await syncSuspensionHalts(database, NOW);

        await expect(runHaltConverges(database, ports(deps))).resolves.toStrictEqual({ deferred: 0, failed: 0, halted: 2, resumed: 0 });
        expect(converged.map((spec) => spec.alias)).toStrictEqual(["acme", "shop"]);

        for (const spec of converged) {
            const expected = buildHaltStub(classesOf(LIVE_MANIFEST), { compatibilityDate: "2026-05-01", reason: "spend-cap" });

            expect(sourceOf(spec)).toBe(expected.source);
            expect(spec.manifest).toStrictEqual(expected.manifest);
            expect(spec.secrets).toStrictEqual({});
            expect(spec.crons).toBeUndefined();
            expect(spec.assets).toBeUndefined();
        }

        expect(haltOf(database, "shop")).toMatchObject({ deploymentId: "d_shop", haltedAt: NOW, state: "halted", stubStartedAt: NOW });
        expect(actions(database).filter((action) => action === "halt.halted")).toHaveLength(2);
        expect((database.tables["alerts"] ?? []).map((alert) => alert["subject"])).toStrictEqual([
            "[Lunora] Ops: Acme — project halted",
            "[Lunora] Ops: Shop — project halted",
        ]);
        // Nothing left to converge.
        await expect(runHaltConverges(database, ports(deps, NOW + 60_000))).resolves.toStrictEqual({ deferred: 0, failed: 0, halted: 0, resumed: 0 });
    });

    it("resumes onto the live release — crons, consumers and secrets resolved afresh — and forgets the row", async () => {
        const { converged, database, deps } = await world({ suspendedAt: NOW - 1, suspendedReason: "spend-cap" });

        await syncSuspensionHalts(database, NOW);
        await runHaltConverges(database, ports(deps));
        await database.patch("org_1", { suspendedAt: null, suspendedReason: null });
        await syncSuspensionHalts(database, NOW + 60_000);
        converged.length = 0;

        await expect(runHaltConverges(database, ports(deps, NOW + 60_000))).resolves.toStrictEqual({ deferred: 0, failed: 0, halted: 0, resumed: 2 });

        const shop = converged.find((spec) => spec.alias === "shop") as TenantDeploymentSpec;

        expect(sourceOf(shop)).toContain("new Response('real')");
        expect(shop.manifest).toStrictEqual(LIVE_MANIFEST);
        expect(shop.crons).toStrictEqual(["*/5 * * * *"]);
        expect(shop.secrets).toStrictEqual({ API_KEY: "s3cret", LUNORA_ADMIN_TOKEN: "admin-d_shop" });
        expect(halts(database)).toStrictEqual([]);
        expect(actions(database).filter((action) => action === "halt.resumed")).toHaveLength(2);
    });

    it("stubs over a newer release that may be on the Worker, keeping its classes too", async () => {
        const newer: DeployManifest = {
            bindings: [...LIVE_MANIFEST.bindings, { binding: "PRESENCE", className: "Presence", sqlite: true, type: "durable_object" }],
        };
        const { converged, database, deps, releases } = await world(
            {},
            {
                deployments: [
                    deployment("d_acme2", {
                        alias: "acme",
                        createdAt: 5,
                        projectId: "p_acme",
                        provisioningAt: 6,
                        status: "failed",
                        target: "cloudflare-wfp",
                        verifyingAt: 7,
                    }),
                ],
            },
        );

        await releases.store.put("d_acme2", release(newer));
        await requestOrganizationHalt(database, { actor: "usr_1", now: NOW, organizationId: "org_1", reason: "manual", source: "manual" });
        await runHaltConverges(database, ports(deps));

        const acme = converged.find((spec) => spec.alias === "acme") as TenantDeploymentSpec;

        expect(acme.manifest.bindings.map((binding) => binding.className)).toStrictEqual(["Counter", "Presence"]);
    });

    it("refuses before converging when a release that may be on the Worker is no longer retained, then backs off", async () => {
        const { converged, database, deps } = await world(
            {},
            {
                deployments: [
                    deployment("d_acme2", {
                        alias: "acme",
                        createdAt: 5,
                        projectId: "p_acme",
                        provisioningAt: 6,
                        status: "failed",
                        target: "cloudflare-wfp",
                        verifyingAt: 7,
                    }),
                ],
            },
        );
        const logged: string[] = [];

        await requestOrganizationHalt(database, { actor: "usr_1", now: NOW, organizationId: "org_1", reason: "manual", source: "manual" });

        await expect(runHaltConverges(database, ports(deps, NOW, { log: (line) => logged.push(line) }))).resolves.toMatchObject({ failed: 1 });
        expect(converged.map((spec) => spec.alias)).toStrictEqual(["shop"]);
        expect(haltOf(database, "acme")).toMatchObject({ attempts: 1, convergingAt: null, nextAttemptAt: NOW + haltBackoff(1), state: "halting" });
        expect(haltOf(database, "acme")?.lastError).toMatch(/release d_acme2 is no longer retained/u);
        expect(logged).toHaveLength(1);

        // Before the backoff: not tried. After it: tried, failed again, backed off further — audited and alerted only once.
        await runHaltConverges(database, ports(deps, NOW + 30_000));

        expect(haltOf(database, "acme")?.attempts).toBe(1);

        await runHaltConverges(database, ports(deps, NOW + haltBackoff(1)));

        expect(haltOf(database, "acme")).toMatchObject({ attempts: 2, nextAttemptAt: NOW + haltBackoff(1) + haltBackoff(2) });
        expect(actions(database).filter((action) => action === "halt.halt_failed")).toHaveLength(1);
        expect((database.tables["alerts"] ?? []).filter((alert) => String(alert["subject"]).includes("emergency stop failed"))).toHaveLength(1);
        expect(converged.map((spec) => spec.alias)).toStrictEqual(["shop"]);
    });

    it("waits for an in-flight deploy of the alias, then stubs over it", async () => {
        const { converged, database, deps, releases } = await world(
            {},
            {
                deployments: [
                    deployment("d_acme2", {
                        alias: "acme",
                        createdAt: NOW - 5000,
                        projectId: "p_acme",
                        provisioningAt: NOW - 4000,
                        status: "provisioning",
                        target: "cloudflare-wfp",
                        updatedAt: NOW - 4000,
                    }),
                ],
            },
        );

        await releases.store.put("d_acme2", release(LIVE_MANIFEST));
        await requestOrganizationHalt(database, { actor: "usr_1", now: NOW, organizationId: "org_1", reason: "manual", source: "manual" });

        await expect(runHaltConverges(database, ports(deps))).resolves.toStrictEqual({ deferred: 1, failed: 0, halted: 1, resumed: 0 });
        expect(converged.map((spec) => spec.alias)).toStrictEqual(["shop"]);

        await database.patch("d_acme2", { liveAt: NOW + 1000, status: "live", updatedAt: NOW + 1000 });
        await database.patch("d_acme", { status: "superseded" });
        await runHaltConverges(database, ports(deps, NOW + 60_000));

        expect(converged.map((spec) => spec.alias)).toStrictEqual(["shop", "acme"]);
        expect(haltOf(database, "acme")?.deploymentId).toBe("d_acme2");
    });

    it("puts the stub back over a converge that was already running when it went on and finished after it", async () => {
        // Stuck in provisioning for an hour, so past the in-flight wait: the stub goes on while its converge still runs.
        const { converged, database, deps, releases } = await world(
            {},
            {
                deployments: [
                    deployment("d_late", {
                        alias: "acme",
                        createdAt: NOW - 3_600_000,
                        projectId: "p_acme",
                        provisioningAt: NOW - 3_500_000,
                        status: "provisioning",
                        target: "cloudflare-wfp",
                        updatedAt: NOW - 3_500_000,
                    }),
                ],
            },
        );

        await releases.store.put("d_late", release(LIVE_MANIFEST));
        await requestOrganizationHalt(database, { actor: "usr_1", now: NOW, organizationId: "org_1", reason: "manual", source: "manual" });
        await runHaltConverges(database, ports(deps));
        // Nothing has finished since: the next tick leaves the stub alone.
        await runHaltConverges(database, ports(deps, NOW + 5000));

        expect(converged.map((spec) => spec.alias)).toStrictEqual(["acme", "shop"]);

        // The old converge lands on top of the stub and goes on to verify: the stub waits while it is in flight…
        await database.patch("d_late", { status: "verifying", updatedAt: NOW + 10_000, verifyingAt: NOW + 10_000 });

        await expect(runHaltConverges(database, ports(deps, NOW + 15_000))).resolves.toMatchObject({ deferred: 1, halted: 0 });

        // …and goes back on once it settled.
        await database.patch("d_late", { failedAt: NOW + 20_000, status: "failed", updatedAt: NOW + 20_000 });
        await runHaltConverges(database, ports(deps, NOW + 60_000));

        expect(converged.map((spec) => spec.alias)).toStrictEqual(["acme", "shop", "acme"]);
        expect(sourceOf(converged.at(-1) as TenantDeploymentSpec)).toContain("project halted: manual");
        expect(haltOf(database, "acme")?.stubStartedAt).toBe(NOW + 60_000);

        // Settled: no further stub.
        await runHaltConverges(database, ports(deps, NOW + 120_000));

        expect(converged).toHaveLength(3);
    });

    it("converges at most `limit` rows a tick, and none once the tick's window has passed", async () => {
        const { converged, database, deps } = await world();

        await requestOrganizationHalt(database, { actor: "usr_1", now: NOW, organizationId: "org_1", reason: "manual", source: "manual" });

        await expect(runHaltConverges(database, ports(deps, NOW, { limit: 1 }))).resolves.toMatchObject({ halted: 1 });
        expect(converged).toHaveLength(1);
        await expect(runHaltConverges(database, ports(deps, NOW, { clock: () => NOW + 2, startBefore: NOW + 1 }))).resolves.toMatchObject({ halted: 0 });
        expect(converged).toHaveLength(1);
    });

    it("leaves a row another tick is converging until its lease expires", async () => {
        const { converged, database, deps } = await world();

        await requestOrganizationHalt(database, { actor: "usr_1", now: NOW, organizationId: "org_1", reason: "manual", source: "manual" });

        await Promise.all(halts(database).map(async (row) => database.patch(row._id, { convergingAt: NOW - 1000 })));

        await expect(runHaltConverges(database, ports(deps))).resolves.toMatchObject({ halted: 0 });
        await expect(runHaltConverges(database, ports(deps, NOW - 1000 + HALT_LEASE_MS))).resolves.toMatchObject({ halted: 2 });
        expect(converged).toHaveLength(2);
    });

    it("keeps a resume asked for while the stub converged, and restores the release next tick", async () => {
        const { converged, database, deps } = await world();

        await requestOrganizationHalt(database, { actor: "usr_1", now: NOW, organizationId: "org_1", reason: "manual", source: "manual" });
        await runHaltConverges(
            database,
            ports(deps, NOW, {
                halt: async (row) => {
                    const outcome = await haltAlias(row, deps);

                    await requestOrganizationResume(database, { actor: "usr_1", now: NOW, organizationId: "org_1" });

                    return outcome;
                },
                limit: 1,
            }),
        );

        expect(haltOf(database, "acme")).toMatchObject({ convergingAt: null, deploymentId: "d_acme", state: "resuming" });

        await runHaltConverges(database, ports(deps, NOW + 60_000));

        expect(sourceOf(converged.at(-1) as TenantDeploymentSpec)).toContain("new Response('real')");
        expect(halts(database)).toStrictEqual([]);
    });

    it("refuses a resume onto a live release that would drop a newer release's class, keeping the alias halted", async () => {
        const newer: DeployManifest = {
            bindings: [...LIVE_MANIFEST.bindings, { binding: "PRESENCE", className: "Presence", sqlite: true, type: "durable_object" }],
        };
        const { converged, database, deps, releases } = await world(
            {},
            {
                deployments: [
                    deployment("d_acme2", {
                        alias: "acme",
                        createdAt: 5,
                        projectId: "p_acme",
                        provisioningAt: 6,
                        status: "failed",
                        target: "cloudflare-wfp",
                        verifyingAt: 7,
                    }),
                ],
            },
        );

        await releases.store.put("d_acme2", release(newer));
        await requestOrganizationHalt(database, { actor: "usr_1", now: NOW, organizationId: "org_1", reason: "manual", source: "manual" });
        await runHaltConverges(database, ports(deps));
        await requestOrganizationResume(database, { actor: "usr_1", now: NOW, organizationId: "org_1" });
        converged.length = 0;

        await expect(runHaltConverges(database, ports(deps, NOW + 60_000))).resolves.toMatchObject({ failed: 1 });
        expect(converged.map((spec) => spec.alias)).toStrictEqual(["shop"]);
        expect(haltOf(database, "acme")?.lastError).toMatch(/would delete the data of class\(es\) Presence/u);
        expect(actions(database)).toContain("halt.resume_failed");
    });

    it("leaves another cell's organizations to that cell's sweep, without a failure to report", async () => {
        const { converged, database, deps } = await world({ suspendedAt: NOW - 1, suspendedReason: "spend-cap" });
        const elsewhere = organizationsOnCell(database, "cell-2");

        await expect(syncSuspensionHalts(database, NOW, elsewhere)).resolves.toStrictEqual({ failed: 0, halted: 0, resumed: 0 });

        await requestOrganizationHalt(database, { actor: "support", now: NOW, organizationId: "org_1", reason: "support", source: "manual" });

        await expect(runHaltConverges(database, ports(deps, NOW, { owns: elsewhere }))).resolves.toStrictEqual({
            deferred: 0,
            failed: 0,
            halted: 0,
            resumed: 0,
        });
        expect(converged).toStrictEqual([]);
        expect(halts(database).map((row) => [row.state, row.lastError])).toStrictEqual([
            ["halting", undefined],
            ["halting", undefined],
        ]);
    });

    it("refuses a resume once the project moved to another target, as a rollback would", async () => {
        const { converged, database, deps } = await world();

        await requestOrganizationHalt(database, { actor: "usr_1", now: NOW, organizationId: "org_1", reason: "manual", source: "manual" });
        await runHaltConverges(database, ports(deps));
        await database.patch("p_acme", { placementRef: "acct_1", target: "cloudflare-workers" });
        await requestOrganizationResume(database, { actor: "usr_1", now: NOW, organizationId: "org_1" });
        converged.length = 0;
        await runHaltConverges(database, ports(deps, NOW + 60_000));

        expect(converged.map((spec) => spec.alias)).toStrictEqual(["shop"]);
        expect(haltOf(database, "acme")?.lastError).toMatch(/now deploys to cloudflare-workers/u);
    });

    it("forgets a halt whose alias has no live release left, converging nothing", async () => {
        const { converged, database, deps } = await world();

        await requestOrganizationHalt(database, { actor: "usr_1", now: NOW, organizationId: "org_1", reason: "manual", source: "manual" });
        await database.patch("d_acme", { status: "destroyed" });
        await runHaltConverges(database, ports(deps));

        expect(converged.map((spec) => spec.alias)).toStrictEqual(["shop"]);
        expect(haltOf(database, "acme")).toBeUndefined();
        expect(actions(database)).toContain("halt.skipped");
    });
});

describe("review fixes: rows that outlive their project (M2)", () => {
    it("drops a halt another project left on the alias before halting its new owner", async () => {
        const { database } = await world();

        await database.insert("halts", {
            alias: "acme",
            createdAt: 1,
            organizationId: "org_old",
            projectId: "p_old",
            source: "manual",
            state: "halted",
            updatedAt: 1,
        });
        await requestOrganizationHalt(database, { actor: "usr_1", now: NOW, organizationId: "org_1", reason: "manual", source: "manual" });

        expect(
            halts(database)
                .filter((row) => row.alias === "acme")
                .map((row) => row.projectId),
        ).toStrictEqual(["p_acme"]);
    });

    it("forgets a halted alias once its release is gone — a deleted project or an expired preview", async () => {
        const { converged, database, deps } = await world();

        await requestOrganizationHalt(database, { actor: "usr_1", now: NOW, organizationId: "org_1", reason: "manual", source: "manual" });
        await runHaltConverges(database, ports(deps));
        await database.patch("d_acme", { status: "destroyed" });
        converged.length = 0;
        await runHaltConverges(database, ports(deps, NOW + 60_000));

        expect(haltOf(database, "acme")).toBeUndefined();
        expect(converged).toStrictEqual([]);
        expect(actions(database)).toContain("halt.skipped");
    });

    it("deletes the alias's halt when the teardown releases the alias, and only that project's", async () => {
        const { database } = await world();

        await database.insert("halts", { alias: "acme", projectId: "p_acme", state: "halted" });
        await database.insert("halts", { alias: "shop", projectId: "p_shop", state: "halted" });
        await teardownPorts(
            database,
            { deleteRelease: async () => undefined, driverFor: () => fakeDriver(), log: () => undefined, read: storeRowReader(database) },
            NOW,
            () => true,
        ).releaseAlias("acme", "p_acme");

        expect(halts(database).map((row) => row.alias)).toStrictEqual(["shop"]);
    });

    it("keeps syncing the other organizations when one cannot be synced, and says which", async () => {
        const { database } = await world({ suspendedAt: NOW - 1, suspendedReason: "spend-cap" });
        const logged: string[] = [];
        const brokenId = (await database.insert("organizations", { cellId: "cell_1", suspendedAt: NOW - 1, suspendedReason: "spend-cap" })) as string;
        const findMany = database.findMany.bind(database);

        database.findMany = async (table, args) => {
            if (table === "deployments" && args?.where?.["organizationId"] === brokenId) {
                throw new Error("d1 read failed");
            }

            return findMany(table, args);
        };

        await expect(syncSuspensionHalts(database, NOW, organizationsOnCell(database, "cell-1"), (line) => logged.push(line))).resolves.toStrictEqual({
            failed: 1,
            halted: 2,
            resumed: 0,
        });
        expect(halts(database).map((row) => row.alias)).toStrictEqual(["acme", "shop"]);
        expect(logged).toStrictEqual([`[halt] suspension sync of organization ${brokenId} failed: d1 read failed`]);
    });
});

describe("review fixes: the lease (L1)", () => {
    const halting = async () => {
        const fixture = await world();

        await requestOrganizationHalt(fixture.database, { actor: "usr_1", now: NOW, organizationId: "org_1", reason: "manual", source: "manual" });

        return fixture;
    };

    /** Run `between` the first time the sweep re-reads `alias`'s row — after it planned, before it claims. */
    const betweenPlanAndClaim = (store: MemoryStore, alias: string, between: (row: HaltRow) => Promise<void>): void => {
        const database = store;
        const get = database.get.bind(database);
        let done = false;

        database.get = async (id, table) => {
            const row = (await get(id, table)) as HaltRow | null;

            if (!done && table === "halts" && row?.alias === alias) {
                done = true;
                await between(row);

                return get(id, table);
            }

            return row;
        };
    };

    it("does not converge a row another tick claimed after this one planned it", async () => {
        const { database, deps } = await halting();
        const halted: string[] = [];

        betweenPlanAndClaim(database, "acme", async (row) => {
            await database.patch(row._id, { convergingAt: NOW, convergingBy: "another-tick" });
        });

        await runHaltConverges(
            database,
            ports(deps, NOW, {
                halt: async (row) => {
                    halted.push(row.alias);

                    return haltAlias(row, deps);
                },
            }),
        );

        expect(halted).toStrictEqual(["shop"]);
        expect(haltOf(database, "acme")?.convergingBy).toBe("another-tick");
    });

    it("skips a row deleted between plan and claim without aborting the tick", async () => {
        const { database, deps } = await halting();

        betweenPlanAndClaim(database, "acme", async (row) => {
            await database.delete(row._id, "halts");
        });

        await expect(runHaltConverges(database, ports(deps))).resolves.toStrictEqual({ deferred: 0, failed: 0, halted: 1, resumed: 0 });
        expect(halts(database).map((row) => [row.alias, row.state])).toStrictEqual([["shop", "halted"]]);
    });

    it("treats a busy provision box as a wait, not a failure: no attempt, no error, no alert, its own lease released", async () => {
        const { database, deps } = await halting();

        await runHaltConverges(
            database,
            ports(deps, NOW, {
                halt: () =>
                    Promise.reject(new LunoraError("SERVICE_UNAVAILABLE", "the provision box is busy with another job for this project; retry shortly")),
                limit: 1,
            }),
        );

        expect(haltOf(database, "acme")).toMatchObject({ convergingAt: null, convergingBy: null, nextAttemptAt: NOW + 60_000, state: "halting" });
        expect(haltOf(database, "acme")?.attempts).toBeUndefined();
        expect(haltOf(database, "acme")?.lastError).toBeUndefined();
        expect(actions(database)).not.toContain("halt.halt_failed");
        expect(database.tables["alerts"] ?? []).toStrictEqual([]);
    });

    it("writes nothing when another tick took the row over while this one converged", async () => {
        const { database, deps } = await halting();

        await runHaltConverges(
            database,
            ports(deps, NOW, {
                halt: async (row) => {
                    const outcome = await haltAlias(row, deps);

                    await database.patch(row._id, { convergingAt: NOW + HALT_LEASE_MS, convergingBy: "took-over" });

                    return outcome;
                },
                limit: 1,
            }),
        );

        expect(haltOf(database, "acme")).toMatchObject({ convergingBy: "took-over", state: "halting" });
        expect(actions(database)).not.toContain("halt.halted");
    });
});

describe("review fixes: which live release, and support's halts (L3, L4)", () => {
    it("l4: takes the live release activated last, not the one created last", () => {
        const rows = [
            { ...deployment("d_new", { alias: "acme", createdAt: 9, liveAt: 10, projectId: "p_acme" }) },
            { ...deployment("d_newer_row", { alias: "acme", createdAt: 12, liveAt: 5, projectId: "p_acme" }) },
        ] as unknown as Parameters<typeof liveByAlias>[0];

        expect(liveByAlias(rows).get("acme")?._id).toBe("d_new");
    });

    it("l3: an owner's stop never takes over support's rows, and neither the owner's resume nor a suspension lifts them", async () => {
        const { database } = await world({ suspendedAt: NOW - 1, suspendedReason: "spend-cap" });

        await requestOrganizationHalt(database, { actor: "support", now: NOW, organizationId: "org_1", reason: "support", source: "support" });
        await requestOrganizationHalt(database, { actor: "usr_1", now: NOW, organizationId: "org_1", reason: "manual", source: "manual" });
        await requestOrganizationResume(database, { actor: "usr_1", now: NOW, organizationId: "org_1", sources: ["manual", "suspension"] });
        await database.patch("org_1", { suspendedAt: null, suspendedReason: null });
        await syncSuspensionHalts(database, NOW + 60_000);

        expect(halts(database).map((row) => [row.alias, row.source, row.haltedBy, row.state])).toStrictEqual([
            ["acme", "support", "support", "halting"],
            ["shop", "support", "support", "halting"],
        ]);
    });
});
