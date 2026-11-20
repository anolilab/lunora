import { describe, expect, it, vi } from "vitest";

import { createDeployPacer } from "../src/deploy/pacing";
import { handleAccountEraseRoute, handleOwnerPromoteRoute } from "../src/deploy/routes/account";
import { handleAlertTestRoute } from "../src/deploy/routes/alerts";
import { handleCloudflareAccountConnectRoute, handleCloudflareAlertRecipientsRoute } from "../src/deploy/routes/cloudflare-accounts";
import { createDeployRoutes } from "../src/deploy/routes/deploy";
import { handleHostdRolloutRoute } from "../src/deploy/routes/hostd";
import type { RouterEnv } from "../src/deploy/routes/shared";
import { MAX_JSON_BODY_BYTES, withContext } from "../src/deploy/routes/shared";
import { handleTenantRecursionRoute } from "../src/deploy/routes/tenant-admin";
import { handleCloudflareCostsRoute, handleUsageSummaryRoute } from "../src/deploy/routes/usage";

/**
 * Every control-plane JSON route reads its body through `readJsonObject`: an array or a scalar is
 * the route's own 400, and a body past the shared cap is a 413 before the Worker buffers the rest.
 */

type Port = (reference: unknown, args?: Record<string, unknown>) => Promise<unknown>;

const makeCtx = () => {
    return {
        runAction: vi.fn<Port>().mockResolvedValue({}),
        runMutation: vi.fn<Port>().mockResolvedValue({}),
        runQuery: vi.fn<Port>().mockResolvedValue(null),
    };
};

/** The hostd rollout's environment, a superset of every other route's; its bindings are present so it reaches the body. */
const environment = (ctx: ReturnType<typeof makeCtx>): Parameters<typeof handleHostdRolloutRoute>[1] => {
    return {
        __lunoraCtx: ctx as unknown as RouterEnv["__lunoraCtx"],
        BOX_SESSION: {} as never,
        DB: {},
        LUNORA_ORIGIN_URL: "https://control.lunora.app",
        SECRET_ENCRYPTION_KEY: "k",
    };
};

type Handler = (request: Request, environment: RouterEnv) => Promise<Response>;

const { handleBuildRunRoute } = createDeployRoutes(createDeployPacer());

const routes: { error: string; handler: Handler; name: string }[] = [
    { error: "userId is required", handler: handleAccountEraseRoute, name: "account erase" },
    { error: "organizationId and userId are required", handler: handleOwnerPromoteRoute, name: "owner promotion" },
    { error: "organizationId and ruleId are required", handler: async (request, env) => handleAlertTestRoute(request, env), name: "alert test" },
    { error: "organizationId, accountId and token are required", handler: handleCloudflareAccountConnectRoute, name: "cloudflare connect" },
    {
        error: "organizationId is required",
        handler: async (request, env) => handleCloudflareAlertRecipientsRoute(request, env),
        name: "cloudflare alert recipients",
    },
    { error: "job and stage are required", handler: handleBuildRunRoute, name: "build run" },
    {
        error: "releaseId is required; boxIds, when given, is a list of box ids",
        handler: handleHostdRolloutRoute,
        name: "hostd rollout",
    },
    { error: "scriptName and depth are required", handler: handleTenantRecursionRoute, name: "tenant recursion" },
    { error: "organizationId is required; periodStart, when given, is a number", handler: handleUsageSummaryRoute, name: "usage summary" },
    { error: "organizationId and id are required", handler: handleCloudflareCostsRoute, name: "cloudflare costs" },
];

const post = (body: string): Request =>
    new Request("https://control.lunora.app/v1/route", {
        body,
        headers: { authorization: "Bearer key_1", "content-type": "application/json" },
        method: "POST",
    });

const expectNothingRan = (ctx: ReturnType<typeof makeCtx>): void => {
    expect(ctx.runQuery).not.toHaveBeenCalled();
    expect(ctx.runMutation).not.toHaveBeenCalled();
    expect(ctx.runAction).not.toHaveBeenCalled();
};

describe("a control-plane route's JSON body shape and cap", () => {
    it.each(routes)("answers the $name route's 400 to an array body, running nothing", async ({ error, handler }) => {
        const ctx = makeCtx();

        const response = await withContext(handler)(post("[]"), environment(ctx));

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toStrictEqual({ error });

        expectNothingRan(ctx);
    });

    it.each(routes)("answers 413 to a $name body past the shared cap, running nothing", async ({ handler }) => {
        const ctx = makeCtx();

        const response = await withContext(handler)(post(JSON.stringify({ padding: "x".repeat(MAX_JSON_BODY_BYTES) })), environment(ctx));

        expect(response.status).toBe(413);

        expectNothingRan(ctx);
    });

    it("refuses a build run whose job is not an object", async () => {
        const ctx = makeCtx();

        const response = await withContext(handleBuildRunRoute)(post(JSON.stringify({ job: "build_1", stage: "build" })), environment(ctx));

        expect(response.status).toBe(400);

        expectNothingRan(ctx);
    });
});
