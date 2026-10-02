/**
 * The target-driver conformance suite (MULTIPLATFORM.md Phase 1, item 5).
 *
 * Legs every {@link TargetDriver} must pass, whatever it runs on. Written
 * against the in-memory reference driver first, then run unchanged against
 * `cloudflare-wfp` — and, when they land, `celld-vps` and `cloudflare-workers`
 * (plan 458 §7: neither reaches early access until both pass this same suite).
 * A driver's own quirks belong in its own tests; anything here is the contract.
 *
 * A fixture supplies the driver plus two windows onto the host it drives: what
 * the host runs right now, and a way to make a tenant serve requests.
 */
import { describe, expect, it } from "vitest";

import type { DeployBackend } from "../../src/deploy/handler";
import { startRelease } from "../../src/deploy/handler";
import { CellScheduler } from "../../src/deploy/scheduler";
import { TokenBucket } from "../../src/deploy/token-bucket";
import { runUsageRollback } from "../../src/metering/rollback";
import type { BindingType, TenantDeploymentSpec } from "../../src/provision-contract";
import type { RouteLookup, TargetDriver } from "../../src/targets/driver";
import memoryReleaseStore from "../_helpers/memory-release-store";

interface ConformanceFixture {
    driver: TargetDriver;
    /** The aliases the host runs right now, as the HOST reports them — not the driver's own bookkeeping. */
    running: () => ReadonlyArray<string>;
    /** Make `resourceRef` serve `requests` requests at `atMs`, the way the host would record them. */
    serve: (resourceRef: string, requests: number, atMs: number) => void;
}

const SHARD = { binding: "SHARD", className: "ShardDO", sqlite: true, type: "durable_object" } as const;

const specFor = (alias: string, version = 1): TenantDeploymentSpec => {
    return {
        alias,
        bundle: new TextEncoder().encode(`export default { version: ${String(version)} }`).buffer,
        kind: "production",
        manifest: { bindings: [{ ...SHARD }] },
        secrets: { LUNORA_ADMIN_TOKEN: "admin" },
        tags: [`project:${alias}`],
    };
};

/** The control plane's routing data, as it would answer from `domains` and `deployments`. */
const lookupOver = (fixture: ConformanceFixture, customDomains: Record<string, string> = {}): RouteLookup => {
    return {
        customDomain: (hostname) => Promise.resolve(customDomains[hostname] ?? null),
        live: (resourceRef) => Promise.resolve(fixture.running().includes(resourceRef)),
    };
};

const hostOf = (driver: TargetDriver, alias: string): string => new URL(driver.tenantUrl(alias, "production")).hostname;

const describeTargetConformance = (name: string, makeFixture: () => ConformanceFixture): void => {
    describe(`${name} — target driver conformance`, () => {
        it("converges idempotently: the same release twice leaves one tenant on it", async () => {
            const { driver, running } = makeFixture();

            const first = await driver.deploy(specFor("app"));
            const second = await driver.deploy(specFor("app"));

            expect(second).toStrictEqual(first);
            expect(running()).toStrictEqual(["app"]);
        });

        it("converges a new release onto the same tenant", async () => {
            const { driver, running } = makeFixture();

            const first = await driver.deploy(specFor("app", 1));
            const second = await driver.deploy(specFor("app", 2));

            expect(second.bundleHash).not.toBe(first.bundleHash);
            expect(second.url).toBe(first.url);
            expect(running()).toStrictEqual(["app"]);
        });

        it("destroys idempotently", async () => {
            const { driver, running } = makeFixture();

            await driver.deploy(specFor("app"));
            await driver.destroy({ alias: "app" });

            await expect(driver.destroy({ alias: "app" })).resolves.toBeUndefined();

            expect(running()).toStrictEqual([]);
        });

        it("destroys a tenant that never existed without failing", async () => {
            const { driver } = makeFixture();

            await expect(driver.destroy({ alias: "never-deployed" })).resolves.toBeUndefined();
        });

        it("re-creates a destroyed tenant on the next converge", async () => {
            const { driver, running } = makeFixture();

            const before = await driver.deploy(specFor("app"));

            await driver.destroy({ alias: "app" });

            const after = await driver.deploy(specFor("app"));

            expect(running()).toStrictEqual(["app"]);
            expect(after).toStrictEqual(before);
        });

        it("routes a live alias, and answers not-found for an unknown or destroyed one", async () => {
            const fixture = makeFixture();
            const { driver } = fixture;

            await driver.deploy(specFor("app"));
            await driver.deploy(specFor("gone"));
            await driver.destroy({ alias: "gone" });

            await expect(driver.route(hostOf(driver, "app"), lookupOver(fixture))).resolves.toStrictEqual({ resourceRef: "app" });
            await expect(driver.route(hostOf(driver, "ghost"), lookupOver(fixture))).resolves.toBeNull();
            await expect(driver.route(hostOf(driver, "gone"), lookupOver(fixture))).resolves.toBeNull();
            await expect(driver.route("not-a-tenant.example.com", lookupOver(fixture))).resolves.toBeNull();
        });

        it("routes a verified custom domain to its live tenant", async () => {
            const fixture = makeFixture();

            await fixture.driver.deploy(specFor("app"));

            await expect(fixture.driver.route("www.example.com", lookupOver(fixture, { "www.example.com": "app" }))).resolves.toStrictEqual({
                resourceRef: "app",
            });
        });

        it("never double-counts usage across a checkpoint", async () => {
            const { driver, serve } = makeFixture();

            // Every driver reads its counts back here, wherever the host keeps them (a
            // `pushed` target's driver reads the reports it was sent); the fixture
            // configures the reader a production deployment may lack credentials for.
            expect(driver.usage).toBeDefined();

            const usage = driver.usage ?? (() => Promise.reject(new Error("this driver reads no usage back")));
            let checkpoint: number | undefined;
            let recorded = 0;
            const sweep = (now: number) =>
                runUsageRollback({
                    getCheckpoint: () => Promise.resolve(checkpoint),
                    now,
                    read: usage,
                    record: ({ quantity }) => {
                        recorded += quantity;

                        return Promise.resolve();
                    },
                    resolveResource: () => {
                        return { organizationId: "org_1" };
                    },
                    setCheckpoint: (ms) => {
                        checkpoint = ms;

                        return Promise.resolve();
                    },
                });

            serve("app", 3, 1000);
            // Exactly on the first checkpoint: counted by the first sweep, never by the second.
            serve("app", 5, 2000);
            await sweep(2000);
            serve("app", 4, 2500);
            await sweep(3000);
            await sweep(4000);

            expect(recorded).toBe(12);
        });

        it("refuses a binding it does not support before any side effect, naming the binding and the target", async () => {
            const { driver, running } = makeFixture();
            const refused = (Object.keys(driver.bindingSupport) as BindingType[]).find((type) => driver.bindingSupport[type] === "unsupported");
            let recorded = 0;
            const backend: DeployBackend = {
                createDeployment: () => {
                    recorded += 1;

                    return Promise.resolve({ deploymentId: "dep_1" });
                },
                placement: () => Promise.resolve({ target: "cloudflare-wfp" }),
                releaseTarget: () => Promise.reject(new Error("unused")),
                rollbackDeployment: () => Promise.reject(new Error("unused")),
                updateStatus: () => Promise.resolve(),
                verifyKey: () => Promise.resolve(null),
            };

            // Every real target refuses something; a driver that refuses nothing cannot be checked here.
            expect(refused).toBeDefined();

            const started = await startRelease(
                {
                    bundle: btoa("export default {}"),
                    kind: "production",
                    manifest: { bindings: [{ binding: "REFUSED", className: "Refused", type: refused }] },
                    projectId: "proj_1",
                    scriptName: "app",
                },
                { key: "k", organizationId: "org_1" },
                {
                    backend,
                    driverFor: () => driver,
                    releases: memoryReleaseStore().store,
                    scheduler: new CellScheduler({ bucket: new TokenBucket({ capacity: 10, refillPerWindow: 10, windowMs: 1000 }) }),
                },
            );

            expect(started).toStrictEqual({ error: expect.stringContaining(`${String(refused)} (REFUSED)`) as string, status: 400 });
            expect("error" in started && started.error).toContain(driver.id);
            expect(recorded).toBe(0);
            expect(running()).toStrictEqual([]);
        });

        it("keeps a tenant's URL stable, and reports it from every converge", async () => {
            const { driver } = makeFixture();

            expect(driver.tenantUrl("app", "production")).toBe(driver.tenantUrl("app", "production"));
            expect(driver.tenantUrl("app", "production")).not.toBe(driver.tenantUrl("other", "production"));

            const result = await driver.deploy(specFor("app"));

            expect(result.url).toBe(driver.tenantUrl("app", "production"));
        });
    });
};

export type { ConformanceFixture };
export { describeTargetConformance };
