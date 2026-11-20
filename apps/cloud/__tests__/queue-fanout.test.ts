import { describe, expect, it, vi } from "vitest";

import {
    deliverQueueBatch,
    OWNERLESS_RETRY_DELAY_SECONDS,
    QUEUE_FORWARD_MAX_BODY_BYTES,
    UNREADABLE_REPLY_RETRY_DELAY_SECONDS,
} from "../src/fanout/platform-queue";
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

    it("retries each message after the delay its tenant asked for, within Cloudflare's ceiling", async () => {
        expect.assertions(1);

        const retried: [string, unknown][] = [];
        const dispatch: NonNullable<TargetFleet["dispatch"]> = () => async () =>
            Response.json({ retry: ["m1", "m2", "m3"], retryDelays: { m1: 30, m3: 999_999 } });
        const message = (id: string) => {
            return {
                ack: () => undefined,
                body: id,
                id,
                retry: (options?: { delaySeconds?: number }) => {
                    retried.push([id, options]);
                },
            };
        };

        await deliverQueueBatch(
            { messages: [message("m1"), message("m2"), message("m3")], queue: tenantResourceName("shop", { binding: "JOBS", type: "queue_producer" }) },
            {
                dispatches: new Map([["cloudflare-wfp" as const, dispatch]]),
                live: [{ adminToken: "admin", alias: "shop", organizationId: "org_ok", projectId: "p_shop", scriptName: "shop", target: "cloudflare-wfp" }],
                now: Date.UTC(2026, 9, 9, 12),
                store: memoryStore({ organizations: [{ _id: "org_ok", plan: "pro" }] }),
            },
        );

        expect(retried).toStrictEqual([
            ["m1", { delaySeconds: 30 }],
            ["m2", undefined],
            ["m3", { delaySeconds: 43_200 }],
        ]);
    });

    it.each([[{}], [{ retry: "m1" }], [{ retry: [1] }], [{ retry: [], retryDelays: 30 }]])(
        "retries, never acks, a batch whose tenant answered %j instead of a queue reply",
        async (reply) => {
            expect.assertions(2);

            const acked: string[] = [];
            const retried: [string, unknown][] = [];
            const dispatch: NonNullable<TargetFleet["dispatch"]> = () => async () => Response.json(reply);
            const message = (id: string) => {
                return {
                    ack: () => {
                        acked.push(id);
                    },
                    body: id,
                    id,
                    retry: (options?: { delaySeconds?: number }) => {
                        retried.push([id, options]);
                    },
                };
            };
            const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

            await deliverQueueBatch(
                { messages: [message("m1"), message("m2")], queue: tenantResourceName("shop", { binding: "JOBS", type: "queue_producer" }) },
                {
                    dispatches: new Map([["cloudflare-wfp" as const, dispatch]]),
                    live: [{ adminToken: "admin", alias: "shop", organizationId: "org_ok", projectId: "p_shop", scriptName: "shop", target: "cloudflare-wfp" }],
                    now: Date.UTC(2026, 9, 9, 12),
                    store: memoryStore({ organizations: [{ _id: "org_ok", plan: "pro" }] }),
                },
            );
            warn.mockRestore();

            expect(acked).toStrictEqual([]);
            expect(retried).toStrictEqual([
                ["m1", { delaySeconds: UNREADABLE_REPLY_RETRY_DELAY_SECONDS }],
                ["m2", { delaySeconds: UNREADABLE_REPLY_RETRY_DELAY_SECONDS }],
            ]);
        },
    );

    it("holds, never acks, a batch whose owner's sealed admin token has no key to open it", async () => {
        expect.assertions(1);

        const outcomes: string[] = [];

        await deliverQueueBatch(
            {
                messages: [
                    {
                        ack: () => outcomes.push("ack"),
                        body: "b",
                        id: "m1",
                        retry: () => outcomes.push("retry"),
                    },
                ],
                queue: tenantResourceName("shop", { binding: "JOBS", type: "queue_producer" }),
            },
            {
                dispatches: new Map([["cloudflare-wfp" as const, () => () => Promise.resolve(Response.json({ retry: [] }))]]),
                live: [
                    {
                        adminTokenCiphertext: "c2VhbGVk",
                        adminTokenIv: "aXY=",
                        alias: "shop",
                        organizationId: "org_ok",
                        projectId: "p_shop",
                        scriptName: "shop",
                        target: "cloudflare-wfp",
                    },
                ],
                now: Date.UTC(2026, 9, 9, 12),
                store: memoryStore({ organizations: [{ _id: "org_ok", plan: "pro" }] }),
            },
        );

        expect(outcomes).toStrictEqual(["retry"]);
    });

    it("retries, never acks, a batch no live release owns yet, so a gap between releases loses nothing", async () => {
        expect.assertions(1);

        const outcomes: [string, unknown][] = [];

        await deliverQueueBatch(
            {
                messages: [
                    {
                        ack: () => outcomes.push(["ack", undefined]),
                        body: "b",
                        id: "m1",
                        retry: (options?: { delaySeconds?: number }) => outcomes.push(["retry", options]),
                    },
                ],
                queue: tenantResourceName("shop", { binding: "JOBS", type: "queue_producer" }),
            },
            {
                dispatches: new Map([["cloudflare-wfp" as const, () => () => Promise.resolve(Response.json({ retry: [] }))]]),
                live: [],
                now: Date.UTC(2026, 9, 9, 12),
                store: memoryStore({ organizations: [{ _id: "org_ok", plan: "pro" }] }),
            },
        );

        expect(outcomes).toStrictEqual([["retry", { delaySeconds: OWNERLESS_RETRY_DELAY_SECONDS }]]);
    });
});
