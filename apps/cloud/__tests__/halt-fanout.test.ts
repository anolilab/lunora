import { describe, expect, it } from "vitest";

import { withoutHalted } from "../src/fanout/live";
import { deliverQueueBatch, HELD_RETRY_DELAY_SECONDS } from "../src/fanout/platform-queue";
import { tenantResourceName } from "../src/provision-contract";
import type { TargetFleet } from "../src/targets/driver";
import { memoryStore } from "./support/memory-store";

/**
 * While an emergency stop holds an alias, its Worker runs the stub — so the
 * cron fan-out skips it, and the platform's queue consumer holds its batches,
 * undelivered, for the resume instead of forwarding them into a 503 that burns
 * their retries.
 */

const NOW = Date.UTC(2026, 9, 9, 12);

/** One serving organization's live `shop` release, and an in-network path that records what reached it. */
const delivery = (halted: ReadonlySet<string>) => {
    const sent: string[] = [];
    const dispatch: NonNullable<TargetFleet["dispatch"]> = () => async (path) => {
        sent.push(path);

        return Response.json({ retry: [] });
    };

    return {
        ports: {
            dispatches: new Map([["cloudflare-wfp" as const, dispatch]]),
            halted,
            live: [{ adminToken: "admin", alias: "shop", organizationId: "org_ok", scriptName: "shop", target: "cloudflare-wfp" }],
            now: NOW,
            store: memoryStore({ organizations: [{ _id: "org_ok", plan: "pro" }] }),
        },
        sent,
    };
};

const batch = () => {
    const outcome: { acked: string[]; retried: { delaySeconds?: number; id: string }[] } = { acked: [], retried: [] };
    const messages = ["m1", "m2"].map((id) => {
        return {
            ack: () => {
                outcome.acked.push(id);
            },
            body: { id },
            id,
            retry: (options?: { delaySeconds?: number }) => {
                outcome.retried.push({ id, ...options });
            },
        };
    });

    return { batch: { messages, queue: tenantResourceName("shop", { binding: "JOBS", type: "queue_producer" }) }, outcome };
};

describe("the platform queue consumer under an emergency stop", () => {
    it("holds a halted alias's batch, undelivered, for the longest retry delay", async () => {
        expect.assertions(3);

        const { batch: halted, outcome } = batch();
        const { ports, sent } = delivery(new Set(["shop"]));

        await deliverQueueBatch(halted, ports);

        expect(sent).toStrictEqual([]);
        expect(outcome.acked).toStrictEqual([]);
        expect(outcome.retried).toStrictEqual([
            { delaySeconds: HELD_RETRY_DELAY_SECONDS, id: "m1" },
            { delaySeconds: HELD_RETRY_DELAY_SECONDS, id: "m2" },
        ]);
    });

    it("delivers the alias's batch again once the halt is gone", async () => {
        expect.assertions(2);

        const { batch: resumed, outcome } = batch();
        const { ports, sent } = delivery(new Set());

        await deliverQueueBatch(resumed, ports);

        expect(sent).toStrictEqual(["/_lunora/queue"]);
        expect(outcome.acked).toStrictEqual(["m1", "m2"]);
    });
});

describe(withoutHalted, () => {
    it("leaves a halted alias's releases out of the cron fan-out, by alias or by script name", () => {
        const live = [{ alias: "shop", scriptName: "shop" }, { alias: "blog", scriptName: "blog" }, { scriptName: "legacy" }];

        expect(withoutHalted(live, new Set(["legacy", "shop"]))).toStrictEqual([{ alias: "blog", scriptName: "blog" }]);
        expect(withoutHalted(live, new Set())).toStrictEqual(live);
    });
});
