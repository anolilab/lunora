import { describe, expect, it } from "vitest";

import { routeQueue } from "../src/fanout/queue";
import { tenantResourceName } from "../src/provision-contract";

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
