import { describe, expect, it, vi } from "vitest";

import type { QueueMessage, TenantQueueGroup } from "../src/fanout/queue";
import { fanOutQueue, groupByTenant } from "../src/fanout/queue";

const message = (id: string, body: unknown): QueueMessage => {
    return { body, id };
};

describe(groupByTenant, () => {
    it("groups by script and unwraps the payload", () => {
        const { groups, unrouted } = groupByTenant([
            message("m1", { body: { to: "a@x.com" }, script: "app-a" }),
            message("m2", { body: { to: "b@x.com" }, script: "app-b" }),
            message("m3", { body: { to: "c@x.com" }, script: "app-a" }),
        ]);

        expect(unrouted).toStrictEqual([]);
        expect(groups).toHaveLength(2);

        const a = groups.find((group) => group.script === "app-a");

        expect(a?.messages).toStrictEqual([
            { body: { to: "a@x.com" }, id: "m1" },
            { body: { to: "c@x.com" }, id: "m3" },
        ]);
    });

    it("routes messages without a valid envelope to unrouted", () => {
        const { groups, unrouted } = groupByTenant([
            message("m1", { body: {} }), // no script
            message("m2", "not-an-object"),
            message("m3", { body: {}, script: "" }), // empty script
        ]);

        expect(groups).toStrictEqual([]);
        expect(unrouted.toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["m1", "m2", "m3"]);
    });
});

const groups: TenantQueueGroup[] = [
    {
        messages: [
            { body: 1, id: "m1" },
            { body: 2, id: "m2" },
        ],
        script: "app-a",
    },
    { messages: [{ body: 3, id: "m3" }], script: "app-b" },
];

describe(fanOutQueue, () => {
    it("forwards every group and collects no retries on success", async () => {
        const dispatch = vi.fn().mockResolvedValue([]);
        const { retry } = await fanOutQueue({ dispatch, groups });

        expect(dispatch).toHaveBeenCalledTimes(2);
        expect([...retry]).toStrictEqual([]);
    });

    it("collects the tenant's per-message retry ids", async () => {
        const dispatch = vi.fn().mockImplementation((group: TenantQueueGroup) => Promise.resolve(group.script === "app-a" ? ["m2"] : []));
        const { retry } = await fanOutQueue({ dispatch, groups });

        expect([...retry]).toStrictEqual(["m2"]);
    });

    it("retries a whole group when its dispatch throws (delivery failure)", async () => {
        const dispatch = vi.fn().mockImplementation((group: TenantQueueGroup) => {
            if (group.script === "app-a") {
                throw new Error("tenant unreachable");
            }

            return Promise.resolve([]);
        });

        const { retry } = await fanOutQueue({ dispatch, groups });

        expect([...retry].toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["m1", "m2"]);
    });
});
