/**
 * The emergency stop's test world (`src/deploy/halt.ts`, `halt-converge.ts`):
 * one organization with a live alias on each target — `acme` (wfp), `shop` (a
 * connected account, with a cron), `edge` (a box) — over the in-memory store,
 * release store and a capturing target, plus the sweep's ports.
 */
import type { HaltConvergePorts, HaltRow } from "../../src/deploy/halt";
import { deployRuleAlert } from "../../src/deploy/halt";
import type { HaltConvergeDeps } from "../../src/deploy/halt-converge";
import { haltAlias, organizationsOnCell, resumeAlias } from "../../src/deploy/halt-converge";
import { createDeployPacer } from "../../src/deploy/pacing";
import type { StoredRelease } from "../../src/deploy/release-store";
import type { DeployManifest, TenantDeploymentSpec } from "../../src/provision-contract";
import { encryptSecret } from "../../src/secrets/crypto";
import { storeRowReader } from "../../src/targets/placement";
import memoryReleaseStore from "../_helpers/memory-release-store";
import { fakeDriver } from "./memory-driver";
import type { MemoryStore } from "./memory-store";
import { memoryStore } from "./memory-store";

export const NOW = 1_800_000_000_000;
export const KEY = "0f".repeat(32);

export const LIVE_MANIFEST: DeployManifest = {
    bindings: [
        { binding: "COUNTER", className: "Counter", sqlite: true, type: "durable_object" },
        { binding: "FILES", resource: "files", type: "r2" },
        { binding: "JOBS", resource: "jobs", type: "queue_producer" },
        { binding: "jobs", resource: "jobs", type: "queue_consumer" },
    ],
    compatibilityDate: "2026-05-01",
};

export const release = (manifest: DeployManifest): StoredRelease => {
    return { bundle: Buffer.from("export default { fetch: () => new Response('real') }").toString("base64"), manifest };
};

export type Row = Record<string, unknown>;

export const deployment = (id: string, overrides: Row): Row => {
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
export interface HaltWorld {
    converged: TenantDeploymentSpec[];
    database: MemoryStore;
    deps: HaltConvergeDeps;
    releases: ReturnType<typeof memoryReleaseStore>;
}

export const world = async (organization: Row = {}, extra: { aliasOwnership?: Row[]; deployments?: Row[] } = {}): Promise<HaltWorld> => {
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
        aliasOwnership: extra.aliasOwnership ?? [
            { _id: "ao_acme", alias: "acme", organizationId: "org_1", projectId: "p_acme" },
            { _id: "ao_shop", alias: "shop", organizationId: "org_1", projectId: "p_shop" },
            { _id: "ao_edge", alias: "edge", organizationId: "org_1", projectId: "p_edge" },
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

export const ports = (deps: HaltConvergeDeps, now = NOW, overrides: Partial<HaltConvergePorts> = {}): HaltConvergePorts => {
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

export const halts = (database: MemoryStore): HaltRow[] => (database.tables["halts"] ?? []) as unknown as HaltRow[];
export const haltOf = (database: MemoryStore, alias: string): HaltRow | undefined => halts(database).find((row) => row.alias === alias);
export const actions = (database: MemoryStore): string[] => (database.tables["auditLog"] ?? []).map((row) => row["action"] as string);
export const sourceOf = (spec: TenantDeploymentSpec): string => new TextDecoder().decode(spec.bundle);
