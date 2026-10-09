import { describe, expect, it } from "vitest";

import type { HaltConvergePorts, HaltRow } from "../src/deploy/halt";
import {
    deployRuleAlert,
    HALT_LEASE_MS,
    haltBackoff,
    requestOrganizationHalt,
    requestOrganizationResume,
    runHaltConverges,
    syncSuspensionHalts,
} from "../src/deploy/halt";
import type { HaltConvergeDeps } from "../src/deploy/halt-converge";
import { haltAlias, organizationsOnCell, resumeAlias } from "../src/deploy/halt-converge";
import { buildHaltStub } from "../src/deploy/halt-stub";
import { createDeployPacer } from "../src/deploy/pacing";
import type { StoredRelease } from "../src/deploy/release-store";
import type { DeployManifest, TenantDeploymentSpec } from "../src/provision-contract";
import { encryptSecret } from "../src/secrets/crypto";
import { storeRowReader } from "../src/targets/placement";
import memoryReleaseStore from "./_helpers/memory-release-store";
import { fakeDriver } from "./support/memory-driver";
import type { MemoryStore } from "./support/memory-store";
import { memoryStore } from "./support/memory-store";

/**
 * The emergency stop's sweep (`src/deploy/halt.ts`) and its two converges
 * (`src/deploy/halt-converge.ts`), driven end to end over the in-memory store,
 * release store and target: what a suspension halts and resumes, what lands on
 * the Worker each way, and how a failing converge is recorded, retried and paced.
 */

const NOW = 1_800_000_000_000;
const KEY = "0f".repeat(32);

const LIVE_MANIFEST: DeployManifest = {
    bindings: [
        { binding: "COUNTER", className: "Counter", sqlite: true, type: "durable_object" },
        { binding: "FILES", resource: "files", type: "r2" },
        { binding: "JOBS", resource: "jobs", type: "queue_producer" },
        { binding: "jobs", resource: "jobs", type: "queue_consumer" },
    ],
    compatibilityDate: "2026-05-01",
};

const release = (manifest: DeployManifest): StoredRelease => {
    return { bundle: Buffer.from("export default { fetch: () => new Response('real') }").toString("base64"), manifest };
};

type Row = Record<string, unknown>;

const deployment = (id: string, overrides: Row): Row => {
    return {
        _id: id,
        adminToken: `admin-${id}`,
        createdAt: 1,
        createdBy: "u",
        kind: "production",
        organizationId: "org_1",
        scriptName: overrides["alias"],
        status: "live",
        updatedAt: 1,
        ...overrides,
    };
};

/** One organization with a live alias on each target: `acme` (wfp), `shop` (a connected account, with a cron), `edge` (a box). */
const world = async (organization: Row = {}, extra: { deployments?: Row[] } = {}) => {
    const { encrypted } = { encrypted: await encryptSecret(KEY, "s3cret") };
    const database = memoryStore({
        alertRules: [
            {
                _id: "rule_1",
                channel: "webhook",
                destination: "https://hooks.example/x",
                enabled: true,
                name: "Ops",
                organizationId: "org_1",
                target: "deploy",
            },
        ],
        cloudflareAccounts: [{ _id: "acct_1", accountId: "a".repeat(32), organizationId: "org_1", workersSubdomain: "acme-co" }],
        deployments: [
            deployment("d_acme", { alias: "acme", projectId: "p_acme", target: "cloudflare-wfp" }),
            deployment("d_shop", { alias: "shop", cronSpecs: ["*/5 * * * *"], placementRef: "acct_1", projectId: "p_shop", target: "cloudflare-workers" }),
            deployment("d_edge", { alias: "edge", placementRef: "box_1", projectId: "p_edge", target: "celld-vps" }),
            ...(extra.deployments ?? []),
        ],
        cells: [{ _id: "cell_1", name: "cell-1" }],
        organizations: [{ _id: "org_1", cellId: "cell_1", name: "Acme", ...organization }],
        projects: [
            { _id: "p_acme", name: "Acme", organizationId: "org_1", target: "cloudflare-wfp" },
            { _id: "p_shop", name: "Shop", organizationId: "org_1", placementRef: "acct_1", target: "cloudflare-workers" },
            { _id: "p_edge", name: "Edge", organizationId: "org_1" },
        ],
        secrets: [
            {
                _id: "sec_1",
                ciphertext: encrypted.ciphertext,
                environment: "all",
                iv: encrypted.iv,
                name: "API_KEY",
                organizationId: "org_1",
                projectId: "p_shop",
            },
        ],
    });
    const releases = memoryReleaseStore();

    await releases.store.put("d_acme", release(LIVE_MANIFEST));
    await releases.store.put("d_shop", release(LIVE_MANIFEST));

    const converged: TenantDeploymentSpec[] = [];
    const deps: HaltConvergeDeps = {
        cell: "cell-1",
        database,
        driverFor: () =>
            fakeDriver({
                deploy: async (spec) => {
                    converged.push(spec);

                    return { url: `https://${spec.alias}.test` };
                },
            }),
        masterKey: KEY,
        pacer: createDeployPacer(),
        read: storeRowReader(database),
        releases: releases.store,
    };

    return { converged, database, deps, releases };
};

const ports = (deps: HaltConvergeDeps, now = NOW, overrides: Partial<HaltConvergePorts> = {}): HaltConvergePorts => {
    return {
        alert: deployRuleAlert(deps.database, now),
        halt: async (row) => haltAlias(row, deps),
        log: () => undefined,
        now,
        owns: organizationsOnCell(deps.database, deps.cell),
        resume: async (row) => resumeAlias(row, deps),
        ...overrides,
    };
};

const halts = (database: MemoryStore): HaltRow[] => (database.tables["halts"] ?? []) as unknown as HaltRow[];
const haltOf = (database: MemoryStore, alias: string): HaltRow | undefined => halts(database).find((row) => row.alias === alias);
const actions = (database: MemoryStore): string[] => (database.tables["auditLog"] ?? []).map((row) => row["action"] as string);
const sourceOf = (spec: TenantDeploymentSpec): string => new TextDecoder().decode(spec.bundle);

describe(syncSuspensionHalts, () => {
    it("halts every live alias on a suspension the setting covers — but not a box's", async () => {
        const { database } = await world({ suspendedAt: NOW - 1, suspendedReason: "spend-cap" });

        await expect(syncSuspensionHalts(database, NOW)).resolves.toStrictEqual({ halted: 2, resumed: 0 });
        expect(halts(database).map((row) => [row.alias, row.state, row.source, row.reason, row.haltedBy])).toStrictEqual([
            ["acme", "halting", "suspension", "spend-cap", "system:halt-on-suspension"],
            ["shop", "halting", "suspension", "spend-cap", "system:halt-on-suspension"],
        ]);
        expect(actions(database)).toStrictEqual(["halt.requested"]);
        // Idempotent: a second tick asks for nothing new.
        await expect(syncSuspensionHalts(database, NOW + 60_000)).resolves.toStrictEqual({ halted: 0, resumed: 0 });
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

        await expect(syncSuspensionHalts(database, NOW)).resolves.toStrictEqual({ halted: 0, resumed: 0 });
        expect(halts(database)).toStrictEqual([]);
    });

    it("resumes a suspension's halts once it lifts, and never a manual halt", async () => {
        const { database } = await world({ suspendedAt: NOW - 1, suspendedReason: "spend-cap" });

        await syncSuspensionHalts(database, NOW);
        await database.patch((haltOf(database, "acme") as HaltRow)._id, { haltedBy: "usr_1", source: "manual" });
        await database.patch("org_1", { suspendedAt: null, suspendedReason: null });

        await expect(syncSuspensionHalts(database, NOW + 60_000)).resolves.toStrictEqual({ halted: 0, resumed: 1 });
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
            expect(sourceOf(spec)).toBe(buildHaltStub([LIVE_MANIFEST], "spend-cap").source);
            expect(spec.manifest).toStrictEqual(buildHaltStub([LIVE_MANIFEST], "spend-cap").manifest);
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
                    deployment("d_acme2", { alias: "acme", createdAt: 5, projectId: "p_acme", provisioningAt: 6, status: "failed", target: "cloudflare-wfp" }),
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
                    deployment("d_acme2", { alias: "acme", createdAt: 5, projectId: "p_acme", provisioningAt: 6, status: "failed", target: "cloudflare-wfp" }),
                ],
            },
        );
        const logged: string[] = [];

        await requestOrganizationHalt(database, { actor: "usr_1", now: NOW, organizationId: "org_1", reason: "manual", source: "manual" });

        await expect(runHaltConverges(database, ports(deps, NOW, { log: (line) => logged.push(line) }))).resolves.toMatchObject({ failed: 1 });
        expect(converged.map((spec) => spec.alias)).toStrictEqual(["shop"]);
        expect(haltOf(database, "acme")).toMatchObject({ attempts: 1, convergingAt: null, nextAttemptAt: NOW + haltBackoff(1), state: "halting" });
        expect(haltOf(database, "acme")?.lastError).toMatch(/d_acme2 may be on the Worker but is no longer retained/u);
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
                    deployment("d_acme2", { alias: "acme", createdAt: 5, projectId: "p_acme", provisioningAt: 6, status: "failed", target: "cloudflare-wfp" }),
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
        expect(haltOf(database, "acme")?.lastError).toMatch(/would delete the data of Durable Object class\(es\) Presence/u);
        expect(actions(database)).toContain("halt.resume_failed");
    });

    it("leaves another cell's organizations to that cell's sweep, without a failure to report", async () => {
        const { converged, database, deps } = await world({ suspendedAt: NOW - 1, suspendedReason: "spend-cap" });
        const elsewhere = organizationsOnCell(database, "cell-2");

        await expect(syncSuspensionHalts(database, NOW, elsewhere)).resolves.toStrictEqual({ halted: 0, resumed: 0 });

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
