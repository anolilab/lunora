import { describe, expect, it } from "vitest";

import { MemoryPaymentStore } from "../src/store";
import { ENTITLING_STATES, restoreSubscription, storeSubscription } from "../src/subscription-policy";
import type { Subscription } from "../src/types";

const subscription = (id: string, referenceId: string, state: Subscription["state"]): Subscription => {
    return {
        cancelAtPeriodEnd: false,
        createdAt: 1,
        id,
        priceId: "price_1",
        provider: "stripe",
        quantity: 1,
        referenceId,
        state,
        updatedAt: 1,
    };
};

const granting = async (store: MemoryPaymentStore, referenceId: string): Promise<string[]> => {
    const rows = await store.listSubscriptionsByReference(referenceId);

    return rows.filter((row) => ENTITLING_STATES.has(row.state)).map((row) => row.id);
};

/**
 * A store whose reference listing holds the first `parties` callers until they have all arrived, so each of them has
 * passed its "does another row grant access" check before any of them writes. Later calls pass straight through.
 */
const gatedStore = (parties: number): MemoryPaymentStore => {
    const store = new MemoryPaymentStore();
    const list = store.listSubscriptionsByReference.bind(store);
    let arrived = 0;
    let release: () => void = () => {};
    const open = new Promise<void>((resolve) => {
        release = resolve;
    });

    store.listSubscriptionsByReference = async (referenceId) => {
        const rows = await list(referenceId);

        arrived += 1;

        if (arrived < parties) {
            await open;
        } else if (arrived === parties) {
            release();
        }

        return rows;
    };

    return store;
};

describe("storeSubscription — concurrent grants under singleSubscriptionPerReference", () => {
    it("lets exactly one of two grants that both passed the check keep its access", async () => {
        expect.assertions(3);

        const store = gatedStore(2);
        const first = subscription("sub_1", "user_1", "active");
        const second = subscription("sub_2", "user_1", "active");

        const outcomes = await Promise.all([storeSubscription(store, true, undefined, first), storeSubscription(store, true, undefined, second)]);

        expect(outcomes.toSorted()).toStrictEqual(["refused", "written"]);
        await expect(granting(store, "user_1")).resolves.toHaveLength(1);
        // The loser is recorded, not dropped, so the customer can still cancel it.
        await expect(store.listSubscriptionsByReference("user_1")).resolves.toHaveLength(2);
    });

    it("steps a lost grant back to a state that grants nothing", async () => {
        expect.assertions(2);

        const store = gatedStore(2);

        await Promise.all([
            storeSubscription(store, true, undefined, subscription("sub_1", "user_1", "active")),
            storeSubscription(store, true, undefined, subscription("sub_2", "user_1", "trialing")),
        ]);

        const rows = await store.listSubscriptionsByReference("user_1");
        const stepped = rows.filter((row) => !ENTITLING_STATES.has(row.state));

        expect(stepped).toHaveLength(1);
        expect(stepped[0]?.state).toBe("paused");
    });

    it("leaves a lost grant alone when a write has already moved it to a state that grants nothing", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();
        const bump = store.bumpReferenceRevision.bind(store);
        let raced = false;

        // Another grant wins the bump, and a webhook cancels the loser, between the loser's write and its step back.
        store.bumpReferenceRevision = async (referenceId, ifRevision) => {
            if (!raced) {
                raced = true;
                await store.upsertSubscription(subscription("sub_2", "user_1", "active"));
                await bump(referenceId, ifRevision);
                await store.upsertSubscription({ ...subscription("sub_1", "user_1", "canceled"), updatedAt: 2 });

                return false;
            }

            return bump(referenceId, ifRevision);
        };

        await expect(storeSubscription(store, true, undefined, subscription("sub_1", "user_1", "active"))).resolves.toBe("refused");
        await expect(store.getSubscription("stripe", "sub_1")).resolves.toMatchObject({ state: "canceled" });
    });

    it("does not serialize grants for different references", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();

        await expect(
            Promise.all([
                storeSubscription(store, true, undefined, subscription("sub_1", "user_1", "active")),
                storeSubscription(store, true, undefined, subscription("sub_2", "user_2", "active")),
            ]),
        ).resolves.toStrictEqual(["written", "written"]);
        await expect(Promise.all([granting(store, "user_1"), granting(store, "user_2")])).resolves.toStrictEqual([["sub_1"], ["sub_2"]]);
    });

    it("leaves the counter alone when the policy is off or the write grants nothing", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();

        await storeSubscription(store, false, undefined, subscription("sub_1", "user_1", "active"));
        await storeSubscription(store, true, undefined, subscription("sub_2", "user_2", "paused"));

        await expect(store.getReferenceRevision("user_1")).resolves.toBe(0);
        await expect(store.getReferenceRevision("user_2")).resolves.toBe(0);
    });
});

describe("restoreSubscription", () => {
    it("puts a retired row back when nothing else grants access", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();
        const original = subscription("sub_1", "user_1", "active");

        await store.upsertSubscription(original);
        await store.upsertSubscription({ ...original, state: "canceled" }, { ifRevision: 1 });

        const retired = await store.getSubscription("stripe", "sub_1");

        await restoreSubscription(store, true, retired as Subscription, original);

        await expect(store.getSubscription("stripe", "sub_1")).resolves.toMatchObject({ state: "active" });
        await expect(store.getReferenceRevision("user_1")).resolves.toBe(1);
    });

    it("keeps the retired row canceled when another plan takes the access during the restore", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();
        const original = subscription("sub_1", "user_1", "active");

        await store.upsertSubscription(original);
        await store.upsertSubscription({ ...original, state: "canceled" }, { ifRevision: 1 });

        const retired = (await store.getSubscription("stripe", "sub_1")) as Subscription;
        const list = store.listSubscriptionsByReference.bind(store);
        let raced = false;

        // The destination activates after the restore's own check read an empty reference and before its write.
        store.listSubscriptionsByReference = async (referenceId) => {
            const rows = await list(referenceId);

            if (!raced) {
                raced = true;
                await storeSubscription(store, true, undefined, subscription("sub_2", "user_1", "active"));
            }

            return rows;
        };

        await restoreSubscription(store, true, retired, original);

        await expect(granting(store, "user_1")).resolves.toStrictEqual(["sub_2"]);
        await expect(store.getSubscription("stripe", "sub_1")).resolves.toMatchObject({ state: "canceled" });
    });
});
