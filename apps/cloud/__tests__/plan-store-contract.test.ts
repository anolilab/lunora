import { describe, expect, it } from "vitest";

import type { PlanStore } from "../src/plans/plan-store";
import { createKvPlanStore, planKey } from "../src/plans/plan-store-kv";
import { createMemoryPlanStore, fakeKv, T0 } from "./_helpers/plan-fixtures";

/**
 * One contract, two backends. `seed` writes raw text the way storage holds it,
 * so a malformed value is exercised through the same path in both: the parser
 * is the only thing that decides what a read returns.
 */
const backends: Record<string, () => { seed: (scriptName: string, text: string) => void; store: PlanStore }> = {
    kv: () => {
        const kv = fakeKv();

        return { seed: (scriptName, text) => kv.values.set(planKey(scriptName), text), store: createKvPlanStore(kv) };
    },
    memory: () => {
        const store = createMemoryPlanStore();

        return { seed: (scriptName, text) => store.raw.set(scriptName, text), store };
    },
};

describe.each(Object.entries(backends))("planStore contract: %s", (_name, make) => {
    it("round-trips a record by script name, and reads an absent one as undefined", async () => {
        const { store } = make();

        await store.put("acme-app", { plan: "pro", protected: true, verifiedAt: T0 });

        await expect(store.get("acme-app")).resolves.toStrictEqual({ plan: "pro", protected: true, verifiedAt: T0 });
        await expect(store.get("other")).resolves.toBeUndefined();
    });

    it("overwrites on put and removes on delete", async () => {
        const { store } = make();

        await store.put("acme-app", { plan: "pro", verifiedAt: T0 });
        await store.put("acme-app", { plan: "suspended", verifiedAt: T0 + 1 });

        await expect(store.get("acme-app")).resolves.toStrictEqual({ plan: "suspended", verifiedAt: T0 + 1 });

        await store.delete("acme-app");

        await expect(store.get("acme-app")).resolves.toBeUndefined();
    });

    it("reads non-JSON text as absent", async () => {
        const { seed, store } = make();

        seed("acme-app", "{not json");

        await expect(store.get("acme-app")).resolves.toBeUndefined();
    });

    /**
     * The resolver's own `unknown` and servable-plan checks are only a safety net;
     * the parse is what keeps an unknown record out. Both backends must drop it here.
     */
    it("parses a stored unknown record to undefined", async () => {
        const { seed, store } = make();

        seed("acme-app", JSON.stringify({ plan: "unknown", verifiedAt: T0 }));

        await expect(store.get("acme-app")).resolves.toBeUndefined();
    });

    it("drops a non-boolean protection flag and a recursion value other than allow", async () => {
        const { seed, store } = make();

        seed("bad-flag", JSON.stringify({ plan: "pro", protected: "yes", verifiedAt: T0 }));
        seed("deny", JSON.stringify({ plan: "pro", recursion: "deny", verifiedAt: T0 }));

        await expect(store.get("bad-flag")).resolves.toBeUndefined();
        await expect(store.get("deny")).resolves.toStrictEqual({ plan: "pro", verifiedAt: T0 });
    });
});
