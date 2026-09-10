import { describe, expect, it, vi } from "vitest";

import { createDeployRouter } from "../src/deploy/router";

/**
 * `POST /v1/tenants/preview-auth` is an admin-token route, and for a while it
 * only said so.
 *
 * Its docblock claimed "Admin-token gated like the rest of `/v1/tenants/*`" and
 * the handler performed no check, while every sibling route did the comparison
 * inline. That made it an unauthenticated password oracle over
 * `internal.projects.verifyPreviewPassword`: anyone able to reach the control
 * plane could post a script name and a guess and read back yes or no, for any
 * protected preview on the platform, with only a rate limit in the way — and that
 * rate limit was keyed on a header the caller sets.
 *
 * These pin both halves, because a route-metadata declaration (`spec.auth`) is
 * validated for presence and enforces nothing at runtime.
 */

type ActionPort = (reference: unknown, args?: Record<string, unknown>) => Promise<unknown>;

const makeCtx = () => {
    return {
        runAction: vi.fn<ActionPort>().mockResolvedValue({}),
        runMutation: vi.fn<ActionPort>().mockResolvedValue("id_1"),
        runQuery: vi.fn<ActionPort>().mockResolvedValue({ ok: true }),
    };
};

const ADMIN_TOKEN = "platform-admin-token";

const attempt = (headers: Record<string, string> = {}): Request =>
    new Request("https://control.lunora.app/v1/tenants/preview-auth", {
        body: JSON.stringify({ password: "hunter2hunter2", scriptName: "acme-app-pr-7" }),
        headers: { "cf-connecting-ip": "attacker", "content-type": "application/json", ...headers },
        method: "POST",
    });

describe("preview-auth route", () => {
    it("refuses an unauthenticated attempt without consulting the password at all", async () => {
        const ctx = makeCtx();
        const response = await createDeployRouter().fetch(attempt(), { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN, __lunoraCtx: ctx });

        expect(response.status).toBe(401);
        // The point: the oracle is never reached, so a rejected caller learns
        // nothing about the password or whether the script exists.
        expect(ctx.runQuery).not.toHaveBeenCalled();
    });

    it("refuses a wrong bearer", async () => {
        const ctx = makeCtx();
        const response = await createDeployRouter().fetch(attempt({ authorization: "Bearer not-the-token" }), {
            LUNORA_ADMIN_TOKEN: ADMIN_TOKEN,
            __lunoraCtx: ctx,
        });

        expect(response.status).toBe(401);
        expect(ctx.runQuery).not.toHaveBeenCalled();
    });

    it("fails closed when the platform has no admin token configured", async () => {
        const ctx = makeCtx();
        const response = await createDeployRouter().fetch(attempt({ authorization: "Bearer anything" }), { __lunoraCtx: ctx });

        expect(response.status).toBe(401);
        expect(ctx.runQuery).not.toHaveBeenCalled();
    });

    it("verifies the password for the platform dispatcher", async () => {
        const ctx = makeCtx();
        const response = await createDeployRouter().fetch(attempt({ authorization: `Bearer ${ADMIN_TOKEN}` }), {
            LUNORA_ADMIN_TOKEN: ADMIN_TOKEN,
            __lunoraCtx: ctx,
        });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual({ ok: true });
        expect(ctx.runQuery).toHaveBeenCalledTimes(1);
    });
});
