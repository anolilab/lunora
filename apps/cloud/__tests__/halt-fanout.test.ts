import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ControlPlaneEnv } from "../src/control-plane-env";
import { withoutHalted } from "../src/fanout/live";
import { HELD_RETRY_DELAY_SECONDS, handleQueueBatch } from "../src/fanout/platform-queue";
import { tenantResourceName } from "../src/provision-contract";

/**
 * While an emergency stop holds an alias, its Worker runs the stub — so the
 * cron fan-out skips it, and the platform's queue consumer holds its batches,
 * undelivered, for the resume instead of forwarding them into a 503 that burns
 * their retries.
 */

const state = vi.hoisted(() => {
    return { halted: new Set<string>(), sent: [] as string[] };
});

vi.mock(import("../src/fanout/live"), async (importOriginal) => {
    const original = await importOriginal();

    return {
        ...original,
        readHaltedAliases: async () => state.halted,
        readLiveDeployments: async () => [{ adminToken: "admin", alias: "shop", scriptName: "shop", target: "cloudflare-wfp" }],
    };
});

vi.mock(import("../src/targets/registry"), async (importOriginal) => {
    const original = await importOriginal();

    return {
        ...original,
        registeredFleets: () => [
            {
                dispatch: () => async (path: string) => {
                    state.sent.push(path);

                    return Response.json({ retry: [] });
                },
                id: "cloudflare-wfp" as const,
                reach: () => async () => new Response(null),
            },
        ],
    };
});

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
    beforeEach(() => {
        state.halted.clear();
        state.sent.length = 0;
    });

    it("holds a halted alias's batch, undelivered, for the longest retry delay", async () => {
        const { batch: halted, outcome } = batch();

        state.halted.add("shop");
        await handleQueueBatch(halted, {} as ControlPlaneEnv);

        expect(state.sent).toStrictEqual([]);
        expect(outcome.acked).toStrictEqual([]);
        expect(outcome.retried).toStrictEqual([
            { delaySeconds: HELD_RETRY_DELAY_SECONDS, id: "m1" },
            { delaySeconds: HELD_RETRY_DELAY_SECONDS, id: "m2" },
        ]);
    });

    it("delivers the alias's batch again once the halt is gone", async () => {
        const { batch: resumed, outcome } = batch();

        await handleQueueBatch(resumed, {} as ControlPlaneEnv);

        expect(state.sent).toStrictEqual(["/_lunora/queue"]);
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
