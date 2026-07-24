import { describe, expect, it, vi } from "vitest";

import { createDeployRouter } from "../src/deploy/router";

/** Minimal injected Lunora action context (the worker normally provides this). */
const makeCtx = (overrides: Record<string, unknown> = {}) => {
    return {
        runAction: vi.fn().mockResolvedValue({ applied: true, status: 200 }),
        runMutation: vi.fn().mockResolvedValue("id_1"),
        ...overrides,
    };
};

const post = (path: string, body: unknown, ip = "client-a"): Request =>
    new Request(`https://control.lunora.app${path}`, {
        body: JSON.stringify(body),
        headers: { "cf-connecting-ip": ip, "content-type": "application/json" },
        method: "POST",
    });

describe(createDeployRouter, () => {
    it("404s anything outside /v1", async () => {
        const router = createDeployRouter();
        const response = await router.fetch(new Request("https://control.lunora.app/healthz"), {});

        expect(response.status).toBe(404);
    });

    it("forwards the billing webhook to the signature-verifying action", async () => {
        const router = createDeployRouter();
        const ctx = makeCtx();
        const response = await router.fetch(post("/v1/billing/webhook", { hello: "world" }), { __lunoraCtx: ctx });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual({ applied: true });
        expect(ctx.runAction).toHaveBeenCalledTimes(1);
    });

    it("rejects metering ingestion missing required fields", async () => {
        const router = createDeployRouter();
        const response = await router.fetch(post("/v1/usage", { organizationId: "org_1" }), { __lunoraCtx: makeCtx() });

        expect(response.status).toBe(400);
    });

    it("ingests a valid metered event via the deploy-key mutation", async () => {
        const router = createDeployRouter();
        const ctx = makeCtx();
        const response = await router.fetch(post("/v1/usage", { deployKey: "k", kind: "requests", organizationId: "org_1", periodStart: 1000, quantity: 5 }), {
            __lunoraCtx: ctx,
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
            last = await router.fetch(new Request("https://control.lunora.app/v1/unknown", { headers: { "cf-connecting-ip": "client-b" } }), {});
        }

        expect(last.status).toBe(429);
        expect(last.headers.get("retry-after")).not.toBeNull();
    });

    it("caps telemetry ingest per IP even when the bearer token is rotated every request", async () => {
        const router = createDeployRouter();
        // The per-token bucket alone is bypassable by rotating the bearer value —
        // a fresh token means a fresh bucket. The per-IP backstop (12_000/min) must
        // still throttle a single IP that churns tokens. Drain it from one IP.
        // A margin over the 12_000 capacity absorbs the bucket's refill during the loop.
        let last = new Response();

        for (let index = 0; index < 12_300; index += 1) {
            last = await router.fetch(
                // eslint-disable-next-line no-await-in-loop -- sequential to drain one IP's telemetry backstop
                new Request("https://control.lunora.app/v1/traces", {
                    headers: { authorization: `Bearer rotated-${String(index)}`, "cf-connecting-ip": "flooder" },
                    method: "POST",
                }),
                {},
            );
        }

        expect(last.status).toBe(429);
        expect(last.headers.get("retry-after")).not.toBeNull();
    });
});

/** POST to the platform tail route, optionally presenting a tail secret header. */
const tailPost = (body: unknown, secret?: string): Request =>
    new Request("https://control.lunora.app/v1/logs/tail", {
        body: JSON.stringify(body),
        headers: {
            "cf-connecting-ip": "tail-worker",
            "content-type": "application/json",
            ...(secret === undefined ? {} : { "x-lunora-tail-secret": secret }),
        },
        method: "POST",
    });

describe("POST /v1/logs/tail", () => {
    /** Router env with the platform tail secret configured. */
    const env = (ctx: unknown): Record<string, unknown> => ({ __lunoraCtx: ctx, LUNORA_TAIL_SECRET: "tail-secret" });

    it("503s when the platform tail secret is not configured", async () => {
        const router = createDeployRouter();
        // env intentionally omits LUNORA_TAIL_SECRET.
        const response = await router.fetch(tailPost({ batches: [] }, "anything"), { __lunoraCtx: makeCtx() });

        expect(response.status).toBe(503);
    });

    it("403s a missing or wrong tail secret", async () => {
        const router = createDeployRouter();

        expect((await router.fetch(tailPost({ batches: [] }), env(makeCtx()))).status).toBe(403);
        expect((await router.fetch(tailPost({ batches: [] }, "nope"), env(makeCtx()))).status).toBe(403);
    });

    it("resolves each script → org and ingests the batch via the internal mutation", async () => {
        const router = createDeployRouter();
        const runQuery = vi.fn().mockResolvedValue({ organizationId: "org_9" });
        const runMutation = vi.fn().mockResolvedValue({ ingested: 2 });
        const ctx = makeCtx({ runMutation, runQuery });

        const response = await router.fetch(
            tailPost(
                {
                    batches: [
                        {
                            lines: [
                                { level: "info", message: "a" },
                                { level: "warn", message: "b" },
                            ],
                            scriptName: "app-v1",
                        },
                    ],
                },
                "tail-secret",
            ),
            env(ctx),
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual({ ingested: 2, scripts: 1 });
        expect(runQuery).toHaveBeenCalledTimes(1);
        expect(runMutation).toHaveBeenCalledTimes(1);
    });

    it("drops a batch whose script resolves to no org (superseded/unknown release)", async () => {
        const router = createDeployRouter();
        const runMutation = vi.fn();
        const ctx = makeCtx({ runMutation, runQuery: vi.fn().mockResolvedValue(null) });

        const response = await router.fetch(
            tailPost({ batches: [{ lines: [{ level: "info", message: "a" }], scriptName: "ghost-v9" }] }, "tail-secret"),
            env(ctx),
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual({ ingested: 0, scripts: 0 });
        expect(runMutation).not.toHaveBeenCalled();
    });
});
