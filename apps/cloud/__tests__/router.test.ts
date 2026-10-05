import { describe, expect, it, vi } from "vitest";

import { createDeployRouter } from "../src/deploy/router";

/**
 * One injected action-context port (`runAction`/`runMutation`/`runQuery`).
 * Mirrors the router's own `LunoraActionContext` members without their generic
 * return: the router receives this context as `unknown`, so the fakes only need
 * the call shape, and a concrete return keeps `mockResolvedValue` inferable.
 */
type ActionPort = (reference: unknown, args?: Record<string, unknown>) => Promise<unknown>;

/** Minimal injected Lunora action context (the worker normally provides this). */
const makeCtx = (overrides: Record<string, unknown> = {}) => {
    return {
        runAction: vi.fn<ActionPort>().mockResolvedValue({ applied: true, status: 200 }),
        runMutation: vi.fn<ActionPort>().mockResolvedValue("id_1"),
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
        // The per-token bucket alone is bypassable by rotating the bearer value — a
        // fresh token means a fresh bucket. The per-IP backstop (12_000/min) must
        // still throttle a single IP that churns tokens. Drain it from one IP,
        // stopping at the first 429 — robust to the bucket's real-time refill (a
        // fixed count would under/overshoot as loop wall-time varies). The ceiling
        // is a generous safety net well above capacity + any plausible refill.
        let last = new Response();

        for (let index = 0; index < 20_000; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential to drain one IP's telemetry backstop
            last = await router.fetch(
                new Request("https://control.lunora.app/v1/traces", {
                    headers: { authorization: `Bearer rotated-${String(index)}`, "cf-connecting-ip": "flooder" },
                    method: "POST",
                }),
                {},
            );

            if (last.status === 429) {
                break;
            }
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

describe("pOST /v1/logs/tail", () => {
    /** Router env with the platform tail secret configured. */
    const env = (ctx: unknown): Record<string, unknown> => {
        return { __lunoraCtx: ctx, LUNORA_TAIL_SECRET: "tail-secret" };
    };

    it("503s when the platform tail secret is not configured", async () => {
        const router = createDeployRouter();
        // env intentionally omits LUNORA_TAIL_SECRET.
        const response = await router.fetch(tailPost({ batches: [] }, "anything"), { __lunoraCtx: makeCtx() });

        expect(response.status).toBe(503);
    });

    it("403s a missing or wrong tail secret", async () => {
        const router = createDeployRouter();

        const noToken = await router.fetch(tailPost({ batches: [] }), env(makeCtx()));
        const wrongToken = await router.fetch(tailPost({ batches: [] }, "nope"), env(makeCtx()));

        expect(noToken.status).toBe(403);
        expect(wrongToken.status).toBe(403);
    });

    it("resolves each script → org and ingests the batch via the internal mutation", async () => {
        const router = createDeployRouter();
        const runQuery = vi.fn<ActionPort>().mockResolvedValue({ organizationId: "org_9" });
        const runMutation = vi.fn<ActionPort>().mockResolvedValue({ ingested: 2 });
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
        const runMutation = vi.fn<ActionPort>();
        const ctx = makeCtx({ runMutation, runQuery: vi.fn<ActionPort>().mockResolvedValue(null) });

        const response = await router.fetch(
            tailPost({ batches: [{ lines: [{ level: "info", message: "a" }], scriptName: "ghost-v9" }] }, "tail-secret"),
            env(ctx),
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual({ ingested: 0, scripts: 0 });
        expect(runMutation).not.toHaveBeenCalled();
    });
});

/** POST to the platform cell-register route, optionally presenting a bearer admin token. */
const cellPost = (body: unknown, token?: string): Request =>
    new Request("https://control.lunora.app/v1/cells", {
        body: JSON.stringify(body),
        headers: {
            "cf-connecting-ip": "operator",
            "content-type": "application/json",
            ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        method: "POST",
    });

describe("pOST /v1/cells", () => {
    const env = (ctx: unknown): Record<string, unknown> => {
        return { __lunoraCtx: ctx, LUNORA_ADMIN_TOKEN: "admin-secret" };
    };
    const validBody = { cloudflareAccountId: "acc_1", dispatchNamespacePrefix: "ns", name: "eu-west" };

    it("401s a missing or wrong admin token (tenant can't register a cell)", async () => {
        const router = createDeployRouter();

        const noToken = await router.fetch(cellPost(validBody), env(makeCtx()));
        const wrongToken = await router.fetch(cellPost(validBody, "nope"), env(makeCtx()));

        expect(noToken.status).toBe(401);
        expect(wrongToken.status).toBe(401);
    });

    it("401s when no platform admin token is configured", async () => {
        const router = createDeployRouter();
        const response = await router.fetch(cellPost(validBody, "admin-secret"), { __lunoraCtx: makeCtx() });

        expect(response.status).toBe(401);
    });

    it("400s a body missing required fields", async () => {
        const router = createDeployRouter();
        const response = await router.fetch(cellPost({ name: "eu-west" }, "admin-secret"), env(makeCtx()));

        expect(response.status).toBe(400);
    });

    it("registers the cell via the internal mutation with a valid admin token", async () => {
        const router = createDeployRouter();
        const runMutation = vi.fn<ActionPort>().mockResolvedValue("cell_1");
        const response = await router.fetch(cellPost(validBody, "admin-secret"), env(makeCtx({ runMutation })));

        expect(response.status).toBe(201);
        await expect(response.json()).resolves.toStrictEqual({ cellId: "cell_1" });
        expect(runMutation).toHaveBeenCalledTimes(1);
    });

    it("registers a cell for a target placed in cells, with its config", async () => {
        const router = createDeployRouter();
        const runMutation = vi.fn<ActionPort>().mockResolvedValue("cell_1");
        const response = await router.fetch(
            cellPost({ ...validBody, config: { region: "weur" }, target: "cloudflare-wfp" }, "admin-secret"),
            env(makeCtx({ runMutation })),
        );

        expect(response.status).toBe(201);
        expect(runMutation.mock.calls[0]?.[1]).toMatchObject({ config: { region: "weur" }, target: "cloudflare-wfp" });
    });

    it.each([
        ["an unknown target", { target: "aws-lambda" }],
        ["a target placed on a box", { target: "celld-vps" }],
        ["a target placed in a customer's account", { target: "cloudflare-workers" }],
        ["a config with a non-string value", { config: { region: 1 } }],
    ])("400s %s", async (_label, extra) => {
        const router = createDeployRouter();
        const runMutation = vi.fn<ActionPort>().mockResolvedValue("cell_1");
        const response = await router.fetch(cellPost({ ...validBody, ...extra }, "admin-secret"), env(makeCtx({ runMutation })));

        expect(response.status).toBe(400);
        expect(runMutation).not.toHaveBeenCalled();
    });
});

/** POST to the build-queue drain the Worker's `scheduled()` calls in-process. */
const dispatchPost = (token?: string): Request =>
    new Request("https://control-plane.internal/v1/builds/dispatch", {
        headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
        method: "POST",
    });

describe("pOST /v1/builds/run", () => {
    const runPost = (body: unknown, token = "admin-secret"): Request =>
        new Request("https://control-plane.internal/v1/builds/run", {
            body: JSON.stringify(body),
            headers: { authorization: `Bearer ${token}` },
            method: "POST",
        });
    const job = { build: { buildId: "bld_1", commitSha: "abc", projectId: "prj_1" }, runnerId: "edge-1" }; // secret-scanner:allow -- domain field name

    it("401s anyone but a build runner (the platform admin token), and refuses a malformed stage", async () => {
        const router = createDeployRouter();
        const runMutation = vi.fn<ActionPort>();
        const environment = { __lunoraCtx: makeCtx({ runMutation }), LUNORA_ADMIN_TOKEN: "admin-secret" };

        await expect(router.fetch(runPost({ job, stage: "build" }, "nope"), environment)).resolves.toMatchObject({ status: 401 });
        await expect(router.fetch(runPost({ job, stage: "deploy" }), environment)).resolves.toMatchObject({ status: 400 });
        expect(runMutation).not.toHaveBeenCalled();
    });

    it("fails the build half with the reason when the platform has no GitHub App, under the runner's lease", async () => {
        const router = createDeployRouter();
        const calls: Record<string, unknown>[] = [];
        const runMutation = vi.fn<ActionPort>((_reference, args) => {
            calls.push(args ?? {});

            return Promise.resolve(null);
        });
        const response = await router.fetch(runPost({ job, stage: "build" }), {
            __lunoraCtx: makeCtx({ runMutation, runQuery: vi.fn<ActionPort>().mockResolvedValue(null) }),
            LUNORA_ADMIN_TOKEN: "admin-secret",
        });

        await expect(response.json()).resolves.toStrictEqual({ next: null });

        const failed = calls.find((args) => typeof args["error"] === "string");

        expect(failed).toMatchObject({ buildId: "bld_1", runnerId: "edge-1" });
        expect(failed?.["error"]).toMatch(/source fetch is not configured: the control plane has no GitHub App credentials/u);
    });
});

describe("pOST /v1/builds/dispatch", () => {
    const env = (ctx: unknown): Record<string, unknown> => {
        return { __lunoraCtx: ctx, LUNORA_ADMIN_TOKEN: "admin-secret" };
    };

    it("401s anyone but the Worker itself (the platform admin token)", async () => {
        const router = createDeployRouter();
        const runMutation = vi.fn<ActionPort>();

        const noToken = await router.fetch(dispatchPost(), env(makeCtx({ runMutation })));
        const wrongToken = await router.fetch(dispatchPost("nope"), env(makeCtx({ runMutation })));

        expect(noToken.status).toBe(401);
        expect(wrongToken.status).toBe(401);
        // Nothing was claimed: a tenant cannot drive the build queue.
        expect(runMutation).not.toHaveBeenCalled();
    });

    it("drains an empty queue", async () => {
        const router = createDeployRouter();
        const runMutation = vi.fn<ActionPort>().mockResolvedValue(null);
        const response = await router.fetch(dispatchPost("admin-secret"), env(makeCtx({ runMutation })));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual({ handedOff: [] });
    });

    /** A claimNext that hands out `bld_1` once, then reports an empty queue; every call recorded. */
    const claimOnce = () => {
        const calls: { args: Record<string, unknown> | undefined }[] = [];
        let handedOut = false;
        const runMutation = vi.fn<ActionPort>((_reference, args) => {
            calls.push({ args });

            // `claimNext` is the one call carrying only the runner id.
            const isClaim = args !== undefined && Object.keys(args).length === 1 && "runnerId" in args;

            if (isClaim && !handedOut) {
                handedOut = true;

                return Promise.resolve({ buildId: "bld_1", commitSha: "abc", projectId: "prj_1" });
            }

            return Promise.resolve(null);
        });

        return { calls, runMutation };
    };

    it("hands a claimed build to its own runner, under the tick's lease, and runs nothing itself", async () => {
        const router = createDeployRouter();
        const { calls, runMutation } = claimOnce();
        const started: { job: unknown; name: string | undefined }[] = [];
        const BUILD_RUNNER = {
            get: (id: DurableObjectId) => {
                return {
                    start: (job: unknown) => {
                        started.push({ job, name: id.name });

                        return Promise.resolve();
                    },
                };
            },
            idFromName: (name: string): DurableObjectId => {
                return { equals: () => false, name, toString: () => name };
            },
        };

        const response = await router.fetch(dispatchPost("admin-secret"), { ...env(makeCtx({ runMutation })), BUILD_RUNNER });

        await expect(response.json()).resolves.toStrictEqual({ handedOff: ["bld_1"] });
        expect(started).toStrictEqual([
            { job: { build: { buildId: "bld_1", commitSha: "abc", projectId: "prj_1" }, runnerId: calls[0]?.args?.["runnerId"] }, name: "bld_1" },
        ]);
        // Claimed, and nothing else: no log line, no failure, no completion on this tick.
        expect(calls).toHaveLength(2);
    });

    it("fails a claimed build with the reason when the cell has no build runner", async () => {
        const router = createDeployRouter();
        const { calls, runMutation } = claimOnce();

        const response = await router.fetch(dispatchPost("admin-secret"), env(makeCtx({ runMutation })));

        await expect(response.json()).resolves.toStrictEqual({ handedOff: [] });

        const failed = calls.find((call) => typeof call.args?.["error"] === "string");

        expect(failed?.args?.["error"]).toMatch(/build runner is not configured: the control plane has no BUILD_RUNNER binding/u);
    });
});
