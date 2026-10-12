import { describe, expect, it, vi } from "vitest";

import type { StoreOutcome } from "../src/plans/plan-resolver";
import {
    createPlanResolver,
    decideFallback,
    parsePlanMaxStaleHours,
    PLAN_LOOKUP_TIMEOUT_MS,
    PLAN_MAX_STALE_HOURS_DEFAULT,
    PLAN_STALE_GRACE_MS,
    UNAVAILABLE_PLAN,
} from "../src/plans/plan-resolver";
import type { PlanRecord, PlanStore } from "../src/plans/plan-store";
import { answer, down, HOUR, spiedStore, T0 } from "./_helpers/plan-fixtures";

describe("plan resolver: a successful lookup is authoritative", () => {
    it("answers from the control plane and never reads the store", async () => {
        const store = spiedStore({ "acme-app": { plan: "suspended", verifiedAt: T0 } });
        const resolve = createPlanResolver({
            controlPlaneToken: "t",
            controlPlaneUrl: "https://cp",
            fetch: vi.fn<typeof globalThis.fetch>().mockImplementation(() => answer({ plan: "pro" })),
            now: () => T0,
            planStore: store,
        });

        await expect(resolve("acme-app")).resolves.toStrictEqual({ plan: "pro" });
        expect(store.get).not.toHaveBeenCalled();
    });

    it("answers unknown from the control plane without consulting a stored plan", async () => {
        const store = spiedStore({ "acme-app": { plan: "pro", verifiedAt: T0 } });
        const resolve = createPlanResolver({
            controlPlaneToken: "t",
            controlPlaneUrl: "https://cp",
            fetch: vi.fn<typeof globalThis.fetch>().mockImplementation(() => answer({ plan: "unknown" })),
            now: () => T0,
            planStore: store,
        });

        await expect(resolve("acme-app")).resolves.toStrictEqual({ plan: "unknown" });
        expect(store.get).not.toHaveBeenCalled();
    });

    it("does not read the store while the isolate cache is warm", async () => {
        let clock = T0;
        const store = spiedStore({});
        const resolve = createPlanResolver({
            controlPlaneToken: "t",
            controlPlaneUrl: "https://cp",
            fetch: vi
                .fn<typeof globalThis.fetch>()
                .mockImplementationOnce(() => answer({ plan: "pro" }))
                .mockImplementation(down),
            now: () => clock,
            planStore: store,
            ttlMs: 60_000,
        });

        await resolve("acme-app");
        clock += 30_000;

        await expect(resolve("acme-app")).resolves.toStrictEqual({ plan: "pro" });
        expect(store.get).not.toHaveBeenCalled();
    });

    it("keeps the isolate grace ahead of the store", async () => {
        let clock = T0;
        const store = spiedStore({ "acme-app": { plan: "suspended", verifiedAt: T0 } });
        const fetchMock = vi
            .fn<typeof globalThis.fetch>()
            .mockImplementationOnce(() => answer({ plan: "pro" }))
            .mockImplementation(down);
        const resolve = createPlanResolver({
            controlPlaneToken: "t",
            controlPlaneUrl: "https://cp",
            fetch: fetchMock,
            now: () => clock,
            ttlMs: 10,
            planStore: store,
        });

        await resolve("acme-app");
        clock = T0 + 10 + PLAN_STALE_GRACE_MS - 1;

        await expect(resolve("acme-app")).resolves.toStrictEqual({ plan: "pro" });
        expect(store.get).not.toHaveBeenCalled();
    });
});

describe("plan resolver: persisted answers during a control-plane outage", () => {
    const outage = (records: Record<string, PlanRecord>, options: { maxStaleHours?: number; onStore?: (outcome: StoreOutcome) => void } = {}) => {
        const store = spiedStore(records);
        const resolve = createPlanResolver({
            controlPlaneToken: "t",
            controlPlaneUrl: "https://cp",
            fetch: vi.fn<typeof globalThis.fetch>().mockImplementation(down),
            now: () => T0,
            planStore: store,
            ...options,
        });

        return { resolve, store };
    };

    /**
     * Suspension is refused at ANY age. The `toStrictEqual` on the exact
     * `suspended` plan is what catches a regression: a refusal reached through
     * the staleness bound would answer `unavailable`, which is also a 503, so a
     * weaker "not servable" assertion would pass after the exemption is removed.
     */
    it("refuses a stored suspension at any age, as suspended", async () => {
        const outcomes: StoreOutcome[] = [];
        const { resolve, store } = outage(
            { "acme-app": { plan: "suspended", verifiedAt: T0 - 365 * 24 * HOUR } },
            { onStore: (outcome) => outcomes.push(outcome) },
        );

        await expect(resolve("acme-app")).resolves.toStrictEqual({ plan: "suspended" });
        expect(outcomes).toStrictEqual(["suspended"]);
        expect(store.put).not.toHaveBeenCalled();
    });

    it("refuses a fresh stored suspension as suspended too", async () => {
        const { resolve } = outage({ "acme-app": { plan: "suspended", verifiedAt: T0 } });

        await expect(resolve("acme-app")).resolves.toStrictEqual({ plan: "suspended" });
    });

    it("serves a fresh non-suspended plan with its protection and recursion flags", async () => {
        const outcomes: StoreOutcome[] = [];
        const { resolve, store } = outage(
            { "acme-pr-42": { plan: "pro", protected: true, recursion: "allow", verifiedAt: T0 - HOUR } },
            { onStore: (outcome) => outcomes.push(outcome) },
        );

        await expect(resolve("acme-pr-42")).resolves.toStrictEqual({ plan: "pro", protected: true, recursion: "allow" });
        expect(outcomes).toStrictEqual(["served"]);
        expect(store.put).not.toHaveBeenCalled();
    });

    it("does not leak verifiedAt into the answer", async () => {
        const { resolve } = outage({ "acme-app": { plan: "free", verifiedAt: T0 } });

        await expect(resolve("acme-app")).resolves.toStrictEqual({ plan: "free" });
    });

    it("serves a record exactly at the bound and refuses one a millisecond past it", async () => {
        const bound = PLAN_MAX_STALE_HOURS_DEFAULT * HOUR;
        const atBound = outage({ "acme-app": { plan: "pro", verifiedAt: T0 - bound } });
        const pastBound = outage({ "acme-app": { plan: "pro", verifiedAt: T0 - bound - 1 } });

        await expect(atBound.resolve("acme-app")).resolves.toStrictEqual({ plan: "pro" });
        await expect(pastBound.resolve("acme-app")).resolves.toStrictEqual({ plan: UNAVAILABLE_PLAN });
    });

    it("honours a configured staleness bound in hours", async () => {
        const { resolve } = outage({ "acme-app": { plan: "pro", verifiedAt: T0 - 10 * HOUR } }, { maxStaleHours: 6 });

        await expect(resolve("acme-app")).resolves.toStrictEqual({ plan: UNAVAILABLE_PLAN });
    });

    it("refuses a stale non-suspended record, and reports it as stale", async () => {
        const outcomes: StoreOutcome[] = [];
        const { resolve } = outage({ "acme-app": { plan: "pro", verifiedAt: T0 - 49 * HOUR } }, { onStore: (outcome) => outcomes.push(outcome) });

        await expect(resolve("acme-app")).resolves.toStrictEqual({ plan: UNAVAILABLE_PLAN });
        expect(outcomes).toStrictEqual(["stale"]);
    });

    it("refuses an absent record without reporting an answer", async () => {
        const outcomes: StoreOutcome[] = [];
        const { resolve } = outage({}, { onStore: (outcome) => outcomes.push(outcome) });

        await expect(resolve("never-seen")).resolves.toStrictEqual({ plan: UNAVAILABLE_PLAN });
        expect(outcomes).toStrictEqual([]);
    });

    it("never serves a stored unknown record", async () => {
        const { resolve } = outage({ "acme-app": { plan: "unknown", verifiedAt: T0 } });

        await expect(resolve("acme-app")).resolves.toStrictEqual({ plan: UNAVAILABLE_PLAN });
    });

    it("refuses a stored record whose plan is not servable", async () => {
        const { resolve } = outage({ "acme-app": { plan: "platinum", verifiedAt: T0 } });

        await expect(resolve("acme-app")).resolves.toStrictEqual({ plan: UNAVAILABLE_PLAN });
    });

    it("refuses when the store fails, and reports it as unreadable", async () => {
        const outcomes: StoreOutcome[] = [];
        const failing: PlanStore = {
            delete: () => Promise.resolve(),
            get: () => Promise.reject(new Error("KV unavailable")),
            put: () => Promise.resolve(),
        };
        const resolve = createPlanResolver({
            controlPlaneToken: "t",
            controlPlaneUrl: "https://cp",
            fetch: vi.fn<typeof globalThis.fetch>().mockImplementation(down),
            now: () => T0,
            planStore: failing,
            onStore: (outcome) => outcomes.push(outcome),
        });

        await expect(resolve("acme-app")).resolves.toStrictEqual({ plan: UNAVAILABLE_PLAN });
        expect(outcomes).toStrictEqual(["unreadable"]);
    });

    it("refuses on a failed lookup when no store is configured", async () => {
        const resolve = createPlanResolver({
            controlPlaneToken: "t",
            controlPlaneUrl: "https://cp",
            fetch: vi.fn<typeof globalThis.fetch>().mockImplementation(down),
            now: () => T0,
        });

        await expect(resolve("acme-app")).resolves.toStrictEqual({ plan: UNAVAILABLE_PLAN });
    });

    it("does not copy a persisted answer into the isolate cache", async () => {
        const store = spiedStore({ "acme-app": { plan: "pro", verifiedAt: T0 } });
        const resolve = createPlanResolver({
            controlPlaneToken: "t",
            controlPlaneUrl: "https://cp",
            fetch: vi.fn<typeof globalThis.fetch>().mockImplementation(down),
            now: () => T0,
            planStore: store,
        });

        await resolve("acme-app");
        await resolve("acme-app");

        expect(store.get).toHaveBeenCalledTimes(2);
    });
});

describe(parsePlanMaxStaleHours, () => {
    it("reads a positive number of hours and defaults everything else to 48", () => {
        expect(parsePlanMaxStaleHours("24")).toBe(24);
        expect(parsePlanMaxStaleHours(undefined)).toBe(48);
        expect(parsePlanMaxStaleHours("")).toBe(48);
        expect(parsePlanMaxStaleHours("  ")).toBe(48);
        expect(parsePlanMaxStaleHours("0")).toBe(48);
        expect(parsePlanMaxStaleHours("-6")).toBe(48);
        expect(parsePlanMaxStaleHours("soon")).toBe(48);
    });
});

describe("plan resolver: a lookup that hangs reaches the fallback", () => {
    it("names the lookup timeout as a short, fixed constant", () => {
        expect(PLAN_LOOKUP_TIMEOUT_MS).toBe(5000);
    });

    /**
     * The fetch never resolves on its own. It rejects only when the signal aborts,
     * so the test passes only if the resolver attached a timeout signal, and only
     * if the timeout then sends the lookup to the stored record.
     */
    it("aborts a hung lookup and serves the stored record", async () => {
        const store = spiedStore({ "acme-app": { plan: "pro", protected: true, verifiedAt: T0 - HOUR } });
        const fetchMock = vi.fn<typeof globalThis.fetch>((_url, init) => {
            const signal = init?.signal;

            return new Promise<Response>((_resolve, reject) => {
                signal?.addEventListener("abort", () => {
                    reject(new Error("aborted by the lookup timeout"));
                });
            });
        });
        const outcomes: StoreOutcome[] = [];
        const resolve = createPlanResolver({
            controlPlaneToken: "t",
            controlPlaneUrl: "https://cp",
            fetch: fetchMock,
            lookupTimeoutMs: 10,
            now: () => T0,
            onStore: (outcome) => outcomes.push(outcome),
            planStore: store,
        });

        await expect(resolve("acme-app")).resolves.toStrictEqual({ plan: "pro", protected: true });
        expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
        expect(outcomes).toStrictEqual(["served"]);
    });
});

describe("plan resolver: a newer isolate verdict beats an older stored record", () => {
    const ttl = 60_000;
    /** The isolate read the protected preview at T0; the stored record is an hour older and has no flag. */
    const newerCache = (clock: { now: number }, extra: Record<string, PlanRecord> = {}) => {
        const store = spiedStore({ "acme-pr-42": { plan: "pro", verifiedAt: T0 - HOUR }, ...extra });
        const resolve = createPlanResolver({
            controlPlaneToken: "t",
            controlPlaneUrl: "https://cp",
            fetch: vi
                .fn<typeof globalThis.fetch>()
                .mockImplementationOnce(() => answer({ plan: "pro", protected: true }))
                .mockImplementation(down),
            now: () => clock.now,
            planStore: store,
            ttlMs: ttl,
        });

        return { resolve, store };
    };

    it("keeps the protection flag within the isolate grace, without reading the store", async () => {
        const clock = { now: T0 };
        const { resolve, store } = newerCache(clock);

        await resolve("acme-pr-42");
        clock.now = T0 + ttl + PLAN_STALE_GRACE_MS - 1;

        await expect(resolve("acme-pr-42")).resolves.toStrictEqual({ plan: "pro", protected: true });
        expect(store.get).not.toHaveBeenCalled();
    });

    /**
     * The regression this guards: after the grace, a warm isolate's own verdict
     * (newer than the stored record) must keep serving its tenant, with its
     * protection, rather than refuse every tenant the isolate has seen. Without
     * this, a control-plane outage longer than five minutes refused everyone
     * whose isolate was warm. The record, older and unflagged, must not win.
     */
    it("keeps serving a warm isolate's protected verdict past the grace, not the older unflagged record", async () => {
        const clock = { now: T0 };
        const { resolve, store } = newerCache(clock);

        await resolve("acme-pr-42");
        clock.now = T0 + ttl + PLAN_STALE_GRACE_MS + 1;

        await expect(resolve("acme-pr-42")).resolves.toStrictEqual({ plan: "pro", protected: true });
        expect(store.get).toHaveBeenCalledWith("acme-pr-42");
    });

    it("refuses past the grace when the newer isolate verdict is unknown", async () => {
        const clock = { now: T0 };
        const store = spiedStore({ "acme-app": { plan: "pro", verifiedAt: T0 - HOUR } });
        const resolve = createPlanResolver({
            controlPlaneToken: "t",
            controlPlaneUrl: "https://cp",
            fetch: vi
                .fn<typeof globalThis.fetch>()
                .mockImplementationOnce(() => answer({ plan: "unknown" }))
                .mockImplementation(down),
            now: () => clock.now,
            planStore: store,
            ttlMs: ttl,
        });

        await resolve("acme-app");
        clock.now = T0 + 5000 + PLAN_STALE_GRACE_MS + 1;

        await expect(resolve("acme-app")).resolves.toStrictEqual({ plan: UNAVAILABLE_PLAN });
    });

    it("lets a newer isolate lift stand against an older stored suspension", async () => {
        const clock = { now: T0 };
        const store = spiedStore({ "acme-app": { plan: "suspended", verifiedAt: T0 - HOUR } });
        const resolve = createPlanResolver({
            controlPlaneToken: "t",
            controlPlaneUrl: "https://cp",
            fetch: vi
                .fn<typeof globalThis.fetch>()
                .mockImplementationOnce(() => answer({ plan: "pro" }))
                .mockImplementation(down),
            now: () => clock.now,
            planStore: store,
            ttlMs: ttl,
        });

        await resolve("acme-app");
        clock.now = T0 + ttl + 1;

        await expect(resolve("acme-app")).resolves.toStrictEqual({ plan: "pro" });
    });
});

describe(decideFallback, () => {
    it("refuses without reporting when no store is configured and the isolate verdict is past grace", () => {
        expect(
            decideFallback({
                cached: { expires: T0 - PLAN_STALE_GRACE_MS - 1, verdict: { plan: "pro", verifiedAt: T0 } },
                maxStaleMs: 48 * HOUR,
                now: T0,
                read: { state: "none" },
            }),
        ).toStrictEqual({
            facts: { plan: UNAVAILABLE_PLAN },
        });
    });

    const maxStaleMs = 48 * HOUR;
    const base = { maxStaleMs, now: T0 };

    it("serves a servable isolate verdict and reads nothing", () => {
        expect(decideFallback({ ...base, cached: { expires: T0 + 1, verdict: { plan: "pro", verifiedAt: T0 } }, read: { state: "unread" } })).toStrictEqual({
            facts: { plan: "pro" },
        });
    });

    it("reports an unreadable store as refused", () => {
        expect(decideFallback({ ...base, read: { state: "failed" } })).toStrictEqual({ facts: { plan: UNAVAILABLE_PLAN }, outcome: "unreadable" });
    });

    it("refuses an absent record without reporting anything", () => {
        expect(decideFallback({ ...base, read: { record: undefined, state: "read" } })).toStrictEqual({ facts: { plan: UNAVAILABLE_PLAN } });
    });

    it("refuses a plan this build does not serve", () => {
        expect(decideFallback({ ...base, read: { record: { plan: "platinum", verifiedAt: T0 }, state: "read" } })).toStrictEqual({
            facts: { plan: UNAVAILABLE_PLAN },
        });
    });
});

describe("plan resolver: the isolate verdict past the grace is judged by the store rules", () => {
    const ttl = 60_000;

    it("refuses a warm isolate's verdict past the grace when the store holds no record for the tenant", async () => {
        // An absent record means the writer deleted it (the script stopped being a tenant). The isolate's own
        // earlier verdict must not outlive that deletion for the staleness bound.
        const clock = { now: T0 };
        const resolve = createPlanResolver({
            controlPlaneToken: "t",
            controlPlaneUrl: "https://cp",
            fetch: vi
                .fn<typeof globalThis.fetch>()
                .mockImplementationOnce(() => answer({ plan: "pro" }))
                .mockImplementation(down),
            now: () => clock.now,
            planStore: spiedStore({}),
            ttlMs: ttl,
        });

        await resolve("acme-app");
        clock.now += ttl + PLAN_STALE_GRACE_MS + 1;

        await expect(resolve("acme-app")).resolves.toStrictEqual({ plan: UNAVAILABLE_PLAN });
    });

    it("refuses a warm isolate's verdict past the bound, and reports it as stale", async () => {
        const clock = { now: T0 - 49 * HOUR };
        const outcomes: StoreOutcome[] = [];
        const resolve = createPlanResolver({
            controlPlaneToken: "t",
            controlPlaneUrl: "https://cp",
            fetch: vi
                .fn<typeof globalThis.fetch>()
                .mockImplementationOnce(() => answer({ plan: "pro" }))
                .mockImplementation(down),
            now: () => clock.now,
            onStore: (outcome) => outcomes.push(outcome),
            planStore: spiedStore({ "acme-app": { plan: "pro", verifiedAt: T0 - 50 * HOUR } }),
            ttlMs: ttl,
        });

        await resolve("acme-app");
        clock.now = T0;

        await expect(resolve("acme-app")).resolves.toStrictEqual({ plan: UNAVAILABLE_PLAN });
        expect(outcomes).toStrictEqual(["stale"]);
    });

    it("refuses past the grace when no store is configured, as before the store existed", async () => {
        const clock = { now: T0 };
        const resolve = createPlanResolver({
            controlPlaneToken: "t",
            controlPlaneUrl: "https://cp",
            fetch: vi
                .fn<typeof globalThis.fetch>()
                .mockImplementationOnce(() => answer({ plan: "pro" }))
                .mockImplementation(down),
            now: () => clock.now,
            ttlMs: ttl,
        });

        await resolve("acme-app");
        clock.now += ttl + PLAN_STALE_GRACE_MS + 1;

        await expect(resolve("acme-app")).resolves.toStrictEqual({ plan: UNAVAILABLE_PLAN });
    });

    it("refuses past the grace when the store cannot be read, and reports it as unreadable", async () => {
        const clock = { now: T0 };
        const outcomes: StoreOutcome[] = [];
        const resolve = createPlanResolver({
            controlPlaneToken: "t",
            controlPlaneUrl: "https://cp",
            fetch: vi
                .fn<typeof globalThis.fetch>()
                .mockImplementationOnce(() => answer({ plan: "pro" }))
                .mockImplementation(down),
            now: () => clock.now,
            onStore: (outcome) => outcomes.push(outcome),
            planStore: { get: () => Promise.reject(new Error("KV unavailable")) },
            ttlMs: ttl,
        });

        await resolve("acme-app");
        clock.now += ttl + PLAN_STALE_GRACE_MS + 1;

        await expect(resolve("acme-app")).resolves.toStrictEqual({ plan: UNAVAILABLE_PLAN });
        expect(outcomes).toStrictEqual(["unreadable"]);
    });

    it("lets a newer isolate lift stand past the grace, against an older stored suspension", async () => {
        const clock = { now: T0 };
        const resolve = createPlanResolver({
            controlPlaneToken: "t",
            controlPlaneUrl: "https://cp",
            fetch: vi
                .fn<typeof globalThis.fetch>()
                .mockImplementationOnce(() => answer({ plan: "pro" }))
                .mockImplementation(down),
            now: () => clock.now,
            planStore: spiedStore({ "acme-app": { plan: "suspended", verifiedAt: T0 - HOUR } }),
            ttlMs: ttl,
        });

        await resolve("acme-app");
        clock.now += ttl + PLAN_STALE_GRACE_MS + 1;

        await expect(resolve("acme-app")).resolves.toStrictEqual({ plan: "pro" });
    });
});
