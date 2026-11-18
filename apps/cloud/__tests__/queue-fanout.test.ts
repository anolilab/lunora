import { describe, expect, it } from "vitest";

import { deliverQueueBatch, QUEUE_FORWARD_MAX_BODY_BYTES } from "../src/fanout/platform-queue";
import { routeQueue } from "../src/fanout/queue";
import { tenantResourceName } from "../src/provision-contract";
import type { TargetFleet } from "../src/targets/driver";
import { memoryStore } from "./support/memory-store";

describe(routeQueue, () => {
    it("routes a per-project queue to its alias's live release", () => {
        const queue = tenantResourceName("shop", { binding: "EMAILS", type: "queue_producer" });

        expect(
            routeQueue(queue, [
                { alias: "blog", scriptName: "blog-v1" },
                { alias: "shop", scriptName: "shop-v3" },
            ])?.scriptName,
        ).toBe("shop-v3");
    });

    it("tells alias app + B_JOBS apart from alias app-b + JOBS, then prefers the newest release", () => {
        const live = [
            { alias: "app", liveAt: 1, scriptName: "app-v1" },
            { alias: "app-b", liveAt: 1, scriptName: "app-b-v1" },
            { alias: "app-b", liveAt: 2, scriptName: "app-b-v2" },
        ];

        expect(routeQueue(tenantResourceName("app", { binding: "B_JOBS", type: "queue_producer" }), live)?.scriptName).toBe("app-v1");
        expect(routeQueue(tenantResourceName("app-b", { binding: "JOBS", type: "queue_producer" }), live)?.scriptName).toBe("app-b-v2");
    });

    it("answers undefined for a queue no live project owns", () => {
        expect(routeQueue("lunora-tenant-queue", [{ alias: "shop", scriptName: "shop-v1" }])).toBeUndefined();
        expect(routeQueue("shop--", [{ alias: "shop", scriptName: "shop-v1" }])).toBeUndefined();
        expect(routeQueue("shop-jobs", [{ alias: "shop", scriptName: "shop-v1" }])).toBeUndefined();
    });
});

describe(deliverQueueBatch, () => {
    it("splits a batch whose escaped JSON passes the tenant's body cap, so every message reaches a handler", async () => {
        expect.assertions(4);

        const sizes: number[] = [];
        const forwarded: string[] = [];
        // The tenant route: a body past its cap is refused before any handler runs.
        const dispatch: NonNullable<TargetFleet["dispatch"]> = () => async (_path, body) => {
            const bytes = new TextEncoder().encode(body).byteLength;

            sizes.push(bytes);

            if (bytes > QUEUE_FORWARD_MAX_BODY_BYTES) {
                return new Response("too large", { status: 413 });
            }

            forwarded.push(...(JSON.parse(body) as { messages: { id: string }[] }).messages.map((message) => message.id));

            return Response.json({ retry: [] });
        };
        const acked: string[] = [];
        const retried: string[] = [];
        // 6 MiB of newlines each: 18 MiB of message bodies once JSON doubles every one.
        const body = "\n".repeat(3 * 1_048_576);
        const messages = ["m1", "m2", "m3"].map((id) => {
            return {
                ack: () => {
                    acked.push(id);
                },
                body,
                id,
                retry: () => {
                    retried.push(id);
                },
            };
        });

        await deliverQueueBatch(
            { messages, queue: tenantResourceName("shop", { binding: "JOBS", type: "queue_producer" }) },
            {
                dispatches: new Map([["cloudflare-wfp" as const, dispatch]]),
                live: [{ adminToken: "admin", alias: "shop", organizationId: "org_ok", projectId: "p_shop", scriptName: "shop", target: "cloudflare-wfp" }],
                now: Date.UTC(2026, 9, 9, 12),
                store: memoryStore({ organizations: [{ _id: "org_ok", plan: "pro" }] }),
            },
        );

        expect(sizes.every((bytes) => bytes <= QUEUE_FORWARD_MAX_BODY_BYTES)).toBe(true);
        expect(forwarded).toStrictEqual(["m1", "m2", "m3"]);
        expect(acked).toStrictEqual(["m1", "m2", "m3"]);
        expect(retried).toStrictEqual([]);
    });

    it("forwards each message's delivery attempt, so the tenant's retry policy can see its last one", async () => {
        expect.assertions(1);

        const forwarded: unknown[] = [];
        const dispatch: NonNullable<TargetFleet["dispatch"]> = () => async (_path, body) => {
            forwarded.push(...(JSON.parse(body) as { messages: unknown[] }).messages);

            return Response.json({ retry: [] });
        };

        await deliverQueueBatch(
            {
                messages: [{ ack: () => undefined, attempts: 4, body: "b", id: "m1", retry: () => undefined }],
                queue: tenantResourceName("shop", { binding: "JOBS", type: "queue_producer" }),
            },
            {
                dispatches: new Map([["cloudflare-wfp" as const, dispatch]]),
                live: [{ adminToken: "admin", alias: "shop", organizationId: "org_ok", projectId: "p_shop", scriptName: "shop", target: "cloudflare-wfp" }],
                now: Date.UTC(2026, 9, 9, 12),
                store: memoryStore({ organizations: [{ _id: "org_ok", plan: "pro" }] }),
            },
        );

        expect(forwarded).toStrictEqual([{ attempts: 4, body: "b", id: "m1" }]);
    });
});
