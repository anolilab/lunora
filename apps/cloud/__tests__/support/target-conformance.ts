/**
 * The target-driver conformance suite (MULTIPLATFORM.md Phase 1, item 5).
 *
 * Legs every {@link TargetDriver} must pass, whatever it runs on. Written
 * against the in-memory reference driver first, then run unchanged against
 * `cloudflare-wfp` — and, when they land, `celld-vps` and `cloudflare-workers`
 * (plan 458 §7: neither reaches early access until both pass this same suite).
 * A driver's own quirks belong in its own tests; anything here is the contract.
 *
 * A fixture supplies the driver plus a window onto the host it drives: what the
 * host runs right now. A `metering: "readback"` target also runs the usage legs
 * ({@link describeUsageReadbackConformance}), with a way to make a tenant serve
 * requests the way its host records them.
 */
import { describe, expect, it } from "vitest";

import { runUsageRollback } from "../../src/metering/rollback";
import type { TenantDeploymentSpec } from "../../src/provision-contract";
import type { TargetDriver, TargetFleet } from "../../src/targets/driver";

interface ConformanceFixture {
    driver: TargetDriver;
    /** The aliases the host runs right now, as the HOST reports them — not the driver's own bookkeeping. */
    running: () => ReadonlyArray<string>;
}

/** A `metering: "readback"` target's usage readback, and a way to make a tenant serve requests the way its host records them. */
interface UsageFixture {
    read: NonNullable<TargetFleet["usage"]>;
    /** Record that the tenant `alias` in `scope` (one of `read.scopes()`) served `requests` at `atMs`. */
    serve: (scope: string, alias: string, requests: number, atMs: number) => void;
}

const SHARD = { binding: "SHARD", className: "ShardDO", sqlite: true, type: "durable_object" } as const;

const specFor = (alias: string, version = 1): TenantDeploymentSpec => {
    return {
        alias,
        bundle: new TextEncoder().encode(`export default { version: ${String(version)} }`).buffer,
        deploymentId: `dep_${alias}_${String(version)}`,
        kind: "production",
        manifest: { bindings: [{ ...SHARD }] },
        secrets: { LUNORA_ADMIN_TOKEN: "admin" },
        tags: [`project:${alias}`],
    };
};

const describeTargetConformance = (name: string, makeFixture: () => ConformanceFixture): void => {
    describe(`${name} — target driver conformance`, () => {
        it("converges idempotently: the same release twice leaves one tenant on it", async () => {
            const { driver, running } = makeFixture();

            const first = await driver.deploy(specFor("app"));
            const second = await driver.deploy(specFor("app"));

            expect(second).toStrictEqual(first);
            expect(running()).toStrictEqual(["app"]);
        });

        it("converges a new release onto the same tenant, at the same URL", async () => {
            const { driver, running } = makeFixture();

            const first = await driver.deploy(specFor("app", 1));
            const second = await driver.deploy(specFor("app", 2));

            expect(second.url).toBe(first.url);
            expect(running()).toStrictEqual(["app"]);
        });

        it("gives each alias its own URL", async () => {
            const { driver } = makeFixture();

            const app = await driver.deploy(specFor("app"));
            const other = await driver.deploy(specFor("other"));

            expect(other.url).not.toBe(app.url);
        });

        it("destroys idempotently", async () => {
            const { driver, running } = makeFixture();

            await driver.deploy(specFor("app"));
            await driver.destroy("app");

            await expect(driver.destroy("app")).resolves.toBeUndefined();

            expect(running()).toStrictEqual([]);
        });

        it("destroys a tenant that never existed without failing", async () => {
            const { driver } = makeFixture();

            await expect(driver.destroy("never-deployed")).resolves.toBeUndefined();
        });

        it("re-creates a destroyed tenant on the next converge", async () => {
            const { driver, running } = makeFixture();

            const before = await driver.deploy(specFor("app"));

            await driver.destroy("app");

            const after = await driver.deploy(specFor("app"));

            expect(running()).toStrictEqual(["app"]);
            expect(after).toStrictEqual(before);
        });
    });
};

const describeUsageReadbackConformance = (name: string, makeFixture: () => UsageFixture): void => {
    describe(`${name} — usage readback conformance`, () => {
        it("never double-counts usage it reads back across a checkpoint, in any scope", async () => {
            const usage = makeFixture();
            const scopes = await usage.read.scopes();

            expect(scopes.length).toBeGreaterThan(0);

            // One checkpoint per scope, as `usageCheckpoints` keeps them.
            const checkpoints = new Map<string, number>();
            let recorded = 0;
            const sweep = async (now: number): Promise<void> => {
                for (const scope of await usage.read.scopes()) {
                    // eslint-disable-next-line no-await-in-loop -- one scope at a time, as a deterministic sweep
                    await runUsageRollback({
                        getCheckpoint: () => Promise.resolve(checkpoints.get(scope)),
                        now,
                        read: (sinceMs) => usage.read.read(scope, sinceMs),
                        record: ({ quantity }) => {
                            recorded += quantity;

                            return Promise.resolve();
                        },
                        resolveResource: () => {
                            return { organizationId: "org_1" };
                        },
                        setCheckpoint: (ms) => {
                            checkpoints.set(scope, ms);

                            return Promise.resolve();
                        },
                    });
                }
            };

            for (const scope of scopes) {
                usage.serve(scope, "app", 3, 1000);
                // Exactly on the first checkpoint: counted by the first sweep, never by the second.
                usage.serve(scope, "app", 5, 2000);
            }

            await sweep(2000);

            for (const scope of scopes) {
                usage.serve(scope, "app", 4, 2500);
            }

            await sweep(3000);
            await sweep(4000);

            expect(recorded).toBe(12 * scopes.length);
        });

        it("reads each scope's usage only from that scope", async () => {
            const usage = makeFixture();
            const [scope] = await usage.read.scopes();

            usage.serve(scope, "app", 7, 1000);

            const rows = await usage.read.read(scope, 0);

            expect(rows.reduce((sum, row) => sum + row.requests, 0)).toBe(7);
            await expect(usage.read.read("not-a-scope", 0)).resolves.toStrictEqual([]);
        });
    });
};

export type { ConformanceFixture, UsageFixture };
export { describeTargetConformance, describeUsageReadbackConformance };
