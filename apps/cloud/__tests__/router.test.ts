import { describe, expect, it, vi } from "vitest";

import { createDeployRouter } from "../src/deploy/router";

/** Minimal injected Cirrus action context (the worker normally provides this). */
const makeCtx = (overrides: Record<string, unknown> = {}) => {
    return {
        runAction: vi.fn().mockResolvedValue({ applied: true, status: 200 }),
        runMutation: vi.fn().mockResolvedValue("id_1"),
        ...overrides,
    };
};

const post = (path: string, body: unknown, ip = "client-a"): Request =>
    new Request(`https://control.cirrus.app${path}`, {
        body: JSON.stringify(body),
        headers: { "cf-connecting-ip": ip, "content-type": "application/json" },
        method: "POST",
    });

describe(createDeployRouter, () => {
    it("404s anything outside /v1", async () => {
        const router = createDeployRouter();
        const response = await router.fetch(new Request("https://control.cirrus.app/healthz"), {});

        expect(response.status).toBe(404);
    });

    it("forwards the billing webhook to the signature-verifying action", async () => {
        const router = createDeployRouter();
        const ctx = makeCtx();
        const response = await router.fetch(post("/v1/billing/webhook", { hello: "world" }), { __cirrusCtx: ctx });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual({ applied: true });
        expect(ctx.runAction).toHaveBeenCalledTimes(1);
    });

    it("rejects metering ingestion missing required fields", async () => {
        const router = createDeployRouter();
        const response = await router.fetch(post("/v1/usage", { organizationId: "org_1" }), { __cirrusCtx: makeCtx() });

        expect(response.status).toBe(400);
    });

    it("ingests a valid metered event via the deploy-key mutation", async () => {
        const router = createDeployRouter();
        const ctx = makeCtx();
        const response = await router.fetch(post("/v1/usage", { deployKey: "k", kind: "requests", organizationId: "org_1", periodStart: 1000, quantity: 5 }), {
            __cirrusCtx: ctx,
        });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual({ id: "id_1" });
        expect(ctx.runMutation).toHaveBeenCalledTimes(1);
    });

    it("rate-limits the /v1 surface per IP", async () => {
        const router = createDeployRouter();
        // Capacity is 120; the 121st request from one IP is throttled.
        let last = new Response();

        for (let index = 0; index < 121; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential to drain one IP's bucket
            last = await router.fetch(new Request("https://control.cirrus.app/v1/unknown", { headers: { "cf-connecting-ip": "client-b" } }), {});
        }

        expect(last.status).toBe(429);
        expect(last.headers.get("retry-after")).not.toBeNull();
    });
});
