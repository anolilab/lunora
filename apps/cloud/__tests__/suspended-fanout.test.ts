import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";

import { periodStartOf } from "../src/billing/spend";
import type { LiveDeploymentRow } from "../src/fanout/live";
import { servingDeployments } from "../src/fanout/live";
import type { QueueBatchLike } from "../src/fanout/platform-queue";
import { deliverQueueBatch } from "../src/fanout/platform-queue";
import { runTenantCrons } from "../src/fanout/tenant-crons";
import { tenantResourceName } from "../src/provision-contract";
import type { TargetFleet } from "../src/targets/driver";
import { memoryStore } from "./support/memory-store";

const NOW = Date.UTC(2026, 9, 9, 12);

const live = (alias: string, organizationId: string | undefined): LiveDeploymentRow => {
    return {
        adminToken: `token-${alias}`,
        alias,
        cronSpecs: ["*/5 * * * *"],
        ...(organizationId === undefined ? {} : { organizationId }),
        scriptName: `${alias}-v1`,
        target: "cloudflare-wfp",
    };
};

const organizations = [
    { _id: "org_ok", plan: "pro" },
    { _id: "org_suspended", plan: "pro", suspendedAt: NOW - 1000, suspendedReason: "spend-cap" },
    // Over its cap by the running accrual: refused at admission before the hourly sweep suspends it.
    { _id: "org_over", plan: "free", spendCapMinor: 100, spendNanoCents: 1_000_000_000_000, spendPeriod: periodStartOf(NOW) },
];

describe(servingDeployments, () => {
    it("keeps only deployments whose organization may serve", async () => {
        expect.assertions(1);

        const rows = [live("shop", "org_ok"), live("blog", "org_suspended"), live("docs", "org_over")];

        await expect(servingDeployments(memoryStore({ organizations }), rows, NOW)).resolves.toStrictEqual([rows[0]]);
    });

    it("fails closed for a row with no organization or an organization that cannot be read", async () => {
        expect.assertions(1);

        await expect(servingDeployments(memoryStore({ organizations }), [live("orphan", undefined), live("gone", "org_deleted")], NOW)).resolves.toStrictEqual(
            [],
        );
    });
});

type Dispatch = NonNullable<TargetFleet["dispatch"]>;
type Retry = (options?: { delaySeconds?: number }) => void;

interface SpiedMessage {
    ack: Mock<() => void>;
    body: unknown;
    id: string;
    retry: Mock<Retry>;
}

const message = (id: string): SpiedMessage => {
    return { ack: vi.fn<() => void>(), body: { id }, id, retry: vi.fn<Retry>() };
};

/** A batch on the per-project queue of `alias`, with spied ack/retry per message. */
const batchFor = (alias: string): QueueBatchLike & { messages: SpiedMessage[] } => {
    return {
        messages: [message("m1"), message("m2")],
        queue: tenantResourceName(alias, { binding: "JOBS", type: "queue_producer" }),
    };
};

describe(deliverQueueBatch, () => {
    it("delivers a serving organization's batch and acks what the tenant did not ask to retry", async () => {
        expect.assertions(4);

        const send = vi.fn<ReturnType<Dispatch>>(async () => Response.json({ retry: ["m2"] }));
        const dispatch = vi.fn<Dispatch>(() => send);
        const batch = batchFor("shop");

        await deliverQueueBatch(batch, {
            dispatches: new Map([["cloudflare-wfp", dispatch]]),
            live: [live("shop", "org_ok")],
            now: NOW,
            store: memoryStore({ organizations }),
        });

        expect(dispatch).toHaveBeenCalledWith({ adminToken: "token-shop", dispatch, kind: "deliver", resourceRef: "shop-v1" });
        expect(send).toHaveBeenCalledTimes(1);
        expect(batch.messages[0]?.ack).toHaveBeenCalledTimes(1);
        expect(batch.messages[1]?.retry).toHaveBeenCalledWith();
    });

    it.each([
        ["suspended", "org_suspended"],
        ["over its cap", "org_over"],
    ])("holds a %s organization's batch: nothing reaches the tenant and every message is retried late", async (_label, organizationId) => {
        expect.assertions(5);

        const dispatch = vi.fn<Dispatch>();
        const batch = batchFor("blog");

        await deliverQueueBatch(batch, {
            dispatches: new Map([["cloudflare-wfp", dispatch]]),
            live: [live("blog", organizationId)],
            now: NOW,
            store: memoryStore({ organizations }),
        });

        expect(dispatch).not.toHaveBeenCalled();

        for (const spied of batch.messages) {
            expect(spied.retry.mock.calls, spied.id).toStrictEqual([[{ delaySeconds: 43_200 }]]);
            expect(spied.ack, spied.id).not.toHaveBeenCalled();
        }
    });

    it("holds a batch it cannot check the organization of", async () => {
        expect.assertions(1);

        const dispatch = vi.fn<Dispatch>();

        await deliverQueueBatch(batchFor("shop"), { dispatches: new Map([["cloudflare-wfp", dispatch]]), live: [live("shop", "org_ok")], now: NOW });

        expect(dispatch).not.toHaveBeenCalled();
    });
});

describe(runTenantCrons, () => {
    it("ticks a serving organization's due crons and skips a suspended or over-cap one", async () => {
        expect.assertions(2);

        const sent: string[] = [];
        const dispatch = vi.fn<Dispatch>((target) => async (path) => {
            sent.push(`${target.resourceRef} ${path}`);

            return new Response(null, { status: 204 });
        });

        await runTenantCrons({
            fleets: [{ dispatch, target: "cloudflare-wfp" }],
            live: [live("shop", "org_ok"), live("blog", "org_suspended"), live("docs", "org_over")],
            // A minute the `*/5` spec is due on.
            now: new Date(Date.UTC(2026, 9, 9, 12, 5)),
            store: memoryStore({ organizations }),
        });

        expect(sent).toStrictEqual(["shop-v1 /_lunora/scheduled"]);
        expect(dispatch).toHaveBeenCalledTimes(1);
    });
});
