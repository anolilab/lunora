import { describe, expect, it } from "vitest";

import { parsePlanRecord } from "../src/plans/plan-store";
import { createKvPlanReader, createKvPlanStore, planKey } from "../src/plans/plan-store-kv";
import { fakeKv, T0 } from "./_helpers/plan-fixtures";

// The round-trip, absent-key and malformed-value cases run against both backends in plan-store-contract.test.ts.

describe(parsePlanRecord, () => {
    it("keeps a well-formed record and drops fields it does not recognise", () => {
        expect(parsePlanRecord({ plan: "pro", protected: true, recursion: "allow", verifiedAt: T0, extra: 1 })).toStrictEqual({
            plan: "pro",
            protected: true,
            recursion: "allow",
            verifiedAt: T0,
        });
    });

    it("rejects unknown, a missing timestamp, a non-finite timestamp, and a non-boolean protection flag", () => {
        expect(parsePlanRecord({ plan: "unknown", verifiedAt: T0 })).toBeUndefined();
        expect(parsePlanRecord({ plan: "pro" })).toBeUndefined();
        expect(parsePlanRecord({ plan: "pro", verifiedAt: Number.NaN })).toBeUndefined();
        expect(parsePlanRecord({ plan: "pro", verifiedAt: T0, protected: "yes" })).toBeUndefined();
        expect(parsePlanRecord(null)).toBeUndefined();
        expect(parsePlanRecord("pro")).toBeUndefined();
    });

    it("drops recursion values other than allow, so the default stays terminate", () => {
        expect(parsePlanRecord({ plan: "pro", recursion: "deny", verifiedAt: T0 })).toStrictEqual({ plan: "pro", verifiedAt: T0 });
    });
});

describe(createKvPlanStore, () => {
    it("keys each record as plan:<scriptName>", () => {
        expect(planKey("acme-app")).toBe("plan:acme-app");
    });

    it("lets a KV failure reject, so the resolver can refuse it", async () => {
        const store = createKvPlanStore({
            delete: () => Promise.resolve(),
            get: () => Promise.reject(new Error("KV unavailable")),
            put: () => Promise.resolve(),
        });

        await expect(store.get("acme-app")).rejects.toThrow("KV unavailable");
    });
});

describe(createKvPlanReader, () => {
    it("exposes only get, so the dispatcher holds no write path", () => {
        expect(Object.keys(createKvPlanReader(fakeKv()))).toStrictEqual(["get"]);
    });
});
