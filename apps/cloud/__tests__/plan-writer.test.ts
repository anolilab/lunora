import { describe, expect, it, vi } from "vitest";

import type { PlanRecord, PlanStore } from "../src/plans/plan-store";
import type { KvNamespaceLike } from "../src/plans/plan-store-kv";
import type { FactsOf } from "../src/plans/plan-writer";
import { needsRefresh, PLAN_REFRESH_AFTER_MS, planRecordFor, refreshPlanRecords } from "../src/plans/plan-writer";
import { factsFromControlPlane, planRecordSlice, sweepPlanRecords } from "../src/sweeps/plan-records";
import { HOUR, spiedStore, T0 } from "./_helpers/plan-fixtures";

const facts = (table: Record<string, { plan: string; protected?: boolean }>) =>
    vi.fn<FactsOf>((scriptName) => Promise.resolve(table[scriptName] ?? { plan: "unknown" }));

describe(planRecordFor, () => {
    it("builds a record from verified facts, stamped with the read time", () => {
        expect(planRecordFor({ plan: "pro", protected: true, recursion: "allow" }, T0)).toStrictEqual({
            plan: "pro",
            protected: true,
            recursion: "allow",
            verifiedAt: T0,
        });
    });

    it("omits flags that are not set", () => {
        expect(planRecordFor({ plan: "free" }, T0)).toStrictEqual({ plan: "free", verifiedAt: T0 });
    });

    /** An unknown script is never persisted; the writer deletes what it held instead. */
    it("builds no record for unknown or absent facts", () => {
        expect(planRecordFor({ plan: "unknown" }, T0)).toBeUndefined();
        expect(planRecordFor({}, T0)).toBeUndefined();
    });

    it("persists a suspension, which is the one answer kept at any age", () => {
        expect(planRecordFor({ plan: "suspended" }, T0)).toStrictEqual({ plan: "suspended", verifiedAt: T0 });
    });
});

describe(needsRefresh, () => {
    it("rewrites a record once it is older than the 20-hour refresh interval", () => {
        const record = { plan: "pro", verifiedAt: T0 };

        expect(PLAN_REFRESH_AFTER_MS).toBe(20 * HOUR);
        expect(needsRefresh(record, T0 + 20 * HOUR)).toBe(false);
        expect(needsRefresh(record, T0 + 20 * HOUR + 1)).toBe(true);
    });

    it("asks for a write when there is no record", () => {
        expect(needsRefresh(undefined, T0)).toBe(true);
    });
});

describe(refreshPlanRecords, () => {
    /**
     * The proof the sweep does not rely on record age: a young record that
     * disagrees with the facts (a plan change the on-change write missed) is
     * rewritten at once.
     */
    it("rewrites a young record whose plan no longer matches the facts", async () => {
        const store = spiedStore({ "acme-app": { plan: "pro", verifiedAt: T0 - HOUR } });

        const outcome = await refreshPlanRecords(["acme-app"], { facts: facts({ "acme-app": { plan: "enterprise" } }), now: () => T0, store });

        expect(outcome).toStrictEqual({ deleted: 0, failed: [], written: 1 });
        expect(store.put).toHaveBeenCalledWith("acme-app", { plan: "enterprise", verifiedAt: T0 });
    });

    it("rewrites a young record whose protection flag no longer matches", async () => {
        const store = spiedStore({ "acme-pr-42": { plan: "pro", verifiedAt: T0 - HOUR } });

        await refreshPlanRecords(["acme-pr-42"], { facts: facts({ "acme-pr-42": { plan: "pro", protected: true } }), now: () => T0, store });

        expect(store.put).toHaveBeenCalledWith("acme-pr-42", { plan: "pro", protected: true, verifiedAt: T0 });
    });

    it("writes nothing for a matching record that is inside the refresh age", async () => {
        const store = spiedStore({ "acme-app": { plan: "pro", verifiedAt: T0 - HOUR } });

        const outcome = await refreshPlanRecords(["acme-app"], { facts: facts({ "acme-app": { plan: "pro" } }), now: () => T0, store });

        expect(outcome).toStrictEqual({ deleted: 0, failed: [], written: 0 });
        expect(store.put).not.toHaveBeenCalled();
    });

    it("rewrites a matching record once it is past the refresh age", async () => {
        const store = spiedStore({ "acme-app": { plan: "pro", verifiedAt: T0 - PLAN_REFRESH_AFTER_MS - 1 } });

        await refreshPlanRecords(["acme-app"], { facts: facts({ "acme-app": { plan: "pro" } }), now: () => T0, store });

        expect(store.put).toHaveBeenCalledWith("acme-app", { plan: "pro", verifiedAt: T0 });
    });

    it("writes a record for a script that has none yet", async () => {
        const store = spiedStore();

        await refreshPlanRecords(["new-app"], { facts: facts({ "new-app": { plan: "free" } }), now: () => T0, store });

        expect(store.put).toHaveBeenCalledWith("new-app", { plan: "free", verifiedAt: T0 });
    });

    /** A script that is no longer a tenant must not keep a servable record for the bound. */
    it("deletes the record of a script whose facts are unknown", async () => {
        const store = spiedStore({ "retired-app": { plan: "pro", verifiedAt: T0 - HOUR } });

        const outcome = await refreshPlanRecords(["retired-app"], { facts: facts({}), now: () => T0, store });

        expect(outcome.deleted).toBe(1);
        expect(store.delete).toHaveBeenCalledWith("retired-app");
        expect(store.raw.has("retired-app")).toBe(false);
    });

    it("keeps a suspension as a record, so it is still refused during an outage", async () => {
        const store = spiedStore();

        await refreshPlanRecords(["acme-app"], { facts: facts({ "acme-app": { plan: "suspended" } }), now: () => T0, store });

        expect(store.put).toHaveBeenCalledWith("acme-app", { plan: "suspended", verifiedAt: T0 });
    });

    /** A lookup that throws keeps the record: a failed read is not a deletion. */
    it("keeps the stored record and counts the script when its facts cannot be read", async () => {
        const store = spiedStore({ "acme-app": { plan: "pro", verifiedAt: T0 - HOUR } });
        const failing = vi.fn<FactsOf>(() => Promise.reject(new Error("control plane down")));

        const outcome = await refreshPlanRecords(["acme-app"], { facts: failing, now: () => T0, store });

        expect(outcome).toStrictEqual({ deleted: 0, failed: ["acme-app"], written: 0 });
        expect(store.delete).not.toHaveBeenCalled();
    });

    /**
     * A write that failed leaves the record disagreeing with the facts, so the next
     * pass writes it. Nothing is marked dirty; the comparison is the retry.
     */
    it("retries a failed write on the next pass, and one bad script does not stop the rest", async () => {
        const store = spiedStore();
        const failFirst = vi.fn<PlanStore["put"]>().mockRejectedValueOnce(new Error("KV 503")).mockResolvedValue(undefined);
        const writer = {
            ...store,
            put: (scriptName: string, record: PlanRecord) => failFirst(scriptName, record).then(() => store.put(scriptName, record)),
        };
        const table = { a: { plan: "pro" }, b: { plan: "free" } };

        const first = await refreshPlanRecords(["a", "b"], { facts: facts(table), now: () => T0, store: writer });

        expect(first).toStrictEqual({ deleted: 0, failed: ["a"], written: 1 });

        const second = await refreshPlanRecords(["a", "b"], { facts: facts(table), now: () => T0, store: writer });

        expect(second).toStrictEqual({ deleted: 0, failed: [], written: 1 });
        expect(store.raw.get("a")).toBe(JSON.stringify({ plan: "pro", verifiedAt: T0 }));
    });
});

describe(planRecordSlice, () => {
    it("visits a fleet within one slice whole, every hour", () => {
        expect(planRecordSlice(["c", "a", "b"], 7, 5)).toStrictEqual(["a", "b", "c"]);
    });

    /** Every script is reached within ceil(n / size) ticks, so no tail is starved however the fleet is ordered. */
    it("covers every script within ceil(n / size) hours, wrapping at the end", () => {
        const names = Array.from({ length: 25 }, (_, index) => `app-${String(index).padStart(2, "0")}`);
        const seen = new Set<string>();

        for (let hour = 0; hour < 5; hour += 1) {
            const slice = planRecordSlice(names, hour, 10);

            expect(slice).toHaveLength(10);
            expect(new Set(slice).size).toBe(10);

            for (const name of slice) {
                seen.add(name);
            }
        }

        expect(seen.size).toBe(25);
    });
});

describe(factsFromControlPlane, () => {
    const env = { LUNORA_ADMIN_TOKEN: "admin" } as never;
    const context = { passThroughOnException: () => undefined, waitUntil: () => undefined } as never;

    it("reads the plan and its flags from the control plane's own lookup", async () => {
        const fetch = vi.fn<(request: Request) => Promise<Response>>(() => Promise.resolve(Response.json({ plan: "pro", protected: true })));

        await expect(factsFromControlPlane(env, context, { fetch })("acme-pr-42")).resolves.toStrictEqual({ plan: "pro", protected: true });
        expect(fetch.mock.calls[0]?.[0]?.url).toContain("script=acme-pr-42");
    });

    it("throws on a non-OK answer, so a failed lookup never reads as a deletion", async () => {
        const fetch = vi.fn<(request: Request) => Promise<Response>>(() => Promise.resolve(new Response("nope", { status: 500 })));

        await expect(factsFromControlPlane(env, context, { fetch })("acme-app")).rejects.toThrow("500");
    });

    it("throws on a body without a plan", async () => {
        const fetch = vi.fn<(request: Request) => Promise<Response>>(() => Promise.resolve(Response.json({})));

        await expect(factsFromControlPlane(env, context, { fetch })("acme-app")).rejects.toThrow("an unrecognised plan");
    });
});

describe(sweepPlanRecords, () => {
    /** Inert without PLAN_KV: no lookup, no read, nothing written. */
    it("does nothing without the PLAN_KV binding", async () => {
        const fetch = vi.fn<(request: Request) => Promise<Response>>(() => Promise.resolve(Response.json({ plan: "pro" })));

        await sweepPlanRecords({ LUNORA_ADMIN_TOKEN: "admin" } as never, { passThroughOnException: () => undefined, waitUntil: () => undefined }, { fetch });

        expect(fetch).not.toHaveBeenCalled();
    });

    it("does nothing without the admin token the in-process lookup needs", async () => {
        const fetch = vi.fn<(request: Request) => Promise<Response>>(() => Promise.resolve(Response.json({ plan: "pro" })));
        const kv = { delete: vi.fn<KvNamespaceLike["delete"]>(), get: vi.fn<KvNamespaceLike["get"]>(), put: vi.fn<KvNamespaceLike["put"]>() };

        await sweepPlanRecords({ PLAN_KV: kv } as never, { passThroughOnException: () => undefined, waitUntil: () => undefined }, { fetch });

        expect(fetch).not.toHaveBeenCalled();
        expect(kv.get).not.toHaveBeenCalled();
    });
});
