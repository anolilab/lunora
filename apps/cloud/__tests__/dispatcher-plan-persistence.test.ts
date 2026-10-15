import { afterEach, describe, expect, it, vi } from "vitest";

import dispatcher from "../src/dispatcher/worker";
import type { KvNamespaceLike } from "../src/plans/plan-store-kv";
import type { AnalyticsEngineDatasetLike } from "../src/targets/cloudflare-wfp/analytics";

/**
 * The dispatcher's wiring of the persisted plan store (plan 476). The resolver
 * unit tests build `createPlanResolver` directly; these prove `worker.ts` turns
 * the `PLAN_KV` binding, the `PLAN_MAX_STALE_HOURS` var and the platform metrics
 * binding into the behaviour the contract promises, end to end through `fetch`.
 *
 * The control plane is down for every case. The resolver is built once per
 * config key, so each case uses a distinct control-plane token and staleness
 * setting to get a fresh resolver bound to this file's fetch double.
 */

const TENANT = "acme-app";
const HOUR = 3_600_000;

/** Every control-plane call fails, so the only answer a request can get is the persisted one. */
vi.stubGlobal(
    "fetch",
    vi.fn<typeof globalThis.fetch>(() => Promise.reject(new Error("control plane unreachable"))),
);

const kvWith = (record: unknown): KvNamespaceLike => {
    const values = new Map([[`plan:${TENANT}`, JSON.stringify(record)]]);

    return {
        delete: async () => {
            throw new Error("the dispatcher must never delete from the plan store");
        },
        get: async (key) => values.get(key) ?? null,
        put: async () => {
            throw new Error("the dispatcher must never write the plan store");
        },
    };
};

const tenantFetch = vi.fn<() => Promise<Response>>(() => Promise.resolve(new Response("tenant body", { status: 200 })));

const makeEnv = (overrides: Record<string, unknown>) => {
    return {
        CONTROL_PLANE_TOKEN: "cp_token_persistence_fixture", // gitleaks:allow -- fabricated fixture, not a credential
        CONTROL_PLANE_URL: "https://cp.example",
        DISPATCHER: {
            get: vi.fn<() => { fetch: typeof tenantFetch }>(() => {
                return { fetch: tenantFetch };
            }),
        },
        LUNORA_APP_DOMAIN: "lunora.app",
        PLATFORM_METRICS: { writeDataPoint: vi.fn<AnalyticsEngineDatasetLike["writeDataPoint"]>() },
        ...overrides,
    };
};

const get = (): Request => new Request(`https://${TENANT}.lunora.app/`);

describe("dispatcher: persisted plans during a control-plane outage", () => {
    afterEach(() => {
        tenantFetch.mockClear();
    });

    /**
     * A suspension recorded before the outage is refused as suspended, with the
     * billing body, not the generic temporarily-unavailable one. The metric row
     * proves the answer came from persistence.
     */
    it("refuses a persisted suspension as suspended and counts it", async () => {
        const env = makeEnv({
            CONTROL_PLANE_TOKEN: "cp_token_persistence_suspended",
            PLAN_KV: kvWith({ plan: "suspended", verifiedAt: Date.now() - 400 * 24 * HOUR }),
        });

        const response = await dispatcher.fetch(get(), env);

        expect(response.status).toBe(503);
        await expect(response.text()).resolves.toContain("suspended");
        expect(tenantFetch).not.toHaveBeenCalled();
        expect(env.PLATFORM_METRICS.writeDataPoint).toHaveBeenCalledWith({
            blobs: ["plan_store", "default", "suspended"],
            doubles: [1],
            indexes: ["plan_store"],
        });
    });

    it("serves a fresh persisted plan to the tenant", async () => {
        const env = makeEnv({
            CONTROL_PLANE_TOKEN: "cp_token_persistence_fresh",
            PLAN_KV: kvWith({ plan: "pro", verifiedAt: Date.now() - HOUR }),
        });

        const response = await dispatcher.fetch(get(), env);

        expect(response.status).toBe(200);
        expect(tenantFetch).toHaveBeenCalledTimes(1);
    });

    /** `PLAN_MAX_STALE_HOURS` is read from the env, so a 2-hour-old record is refused under a 1-hour bound. */
    it("honours PLAN_MAX_STALE_HOURS from the environment", async () => {
        const env = makeEnv({
            CONTROL_PLANE_TOKEN: "cp_token_persistence_bound",
            PLAN_KV: kvWith({ plan: "pro", verifiedAt: Date.now() - 2 * HOUR }),
            PLAN_MAX_STALE_HOURS: "1",
        });

        const response = await dispatcher.fetch(get(), env);

        expect(response.status).toBe(503);
        await expect(response.text()).resolves.toContain("temporarily unavailable");
        expect(tenantFetch).not.toHaveBeenCalled();
        expect(env.PLATFORM_METRICS.writeDataPoint).toHaveBeenCalledWith(expect.objectContaining({ blobs: ["plan_store", "default", "stale"] }));
    });

    it("refuses when no PLAN_KV binding is configured, as before", async () => {
        const response = await dispatcher.fetch(get(), makeEnv({ CONTROL_PLANE_TOKEN: "cp_token_persistence_nokv" }));

        expect(response.status).toBe(503);
        await expect(response.text()).resolves.toContain("temporarily unavailable");
        expect(tenantFetch).not.toHaveBeenCalled();
    });
});
