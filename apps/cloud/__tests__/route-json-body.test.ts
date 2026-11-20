import { describe, expect, it, vi } from "vitest";

import { handleAdminRoute } from "../src/deploy/routes/admin-proxy";
import { handleDomainAddRoute } from "../src/deploy/routes/domains";
import type { RouterEnv } from "../src/deploy/routes/shared";
import { MAX_JSON_BODY_BYTES, withContext } from "../src/deploy/routes/shared";

/**
 * The control plane is one Worker shared by every tenant, so a route reads its JSON
 * body only up to a cap and answers 413 past it, without buffering the rest. A chunked
 * body declares no length, so the cap must hold while the body streams in.
 */

type ActionPort = (reference: unknown, args?: Record<string, unknown>) => Promise<unknown>;

const makeCtx = () => {
    return {
        runAction: vi.fn<ActionPort>().mockResolvedValue({}),
        runMutation: vi.fn<ActionPort>().mockResolvedValue({ id: "dom_1", txtName: "_lunora.example.com", txtToken: "t" }),
        runQuery: vi.fn<ActionPort>().mockResolvedValue(null),
    };
};

const environment = (ctx: ReturnType<typeof makeCtx>): RouterEnv => {
    return { __lunoraCtx: ctx as unknown as RouterEnv["__lunoraCtx"] };
};

const encoder = new TextEncoder();

/** A JSON object body padded to about `bytes`, streamed in 16 KiB chunks with no content-length. `pulled` counts the chunks read. */
const streamed = (fields: Record<string, unknown>, bytes: number) => {
    const text = JSON.stringify({ ...fields, padding: "x".repeat(bytes) });
    const counter = { pulled: 0 };
    let offset = 0;
    const chunk = 16 * 1024;
    const body = new ReadableStream<Uint8Array>({
        pull: (controller) => {
            if (offset >= text.length) {
                controller.close();

                return;
            }

            counter.pulled += 1;
            controller.enqueue(encoder.encode(text.slice(offset, offset + chunk)));
            offset += chunk;
        },
    });

    return { body, counter, total: Math.ceil(text.length / chunk) };
};

const post = (path: string, body: ReadableStream<Uint8Array> | string): Request =>
    new Request(`https://control.lunora.app${path}`, { body, duplex: "half", headers: { "content-type": "application/json" }, method: "POST" } as RequestInit);

const domain = { hostname: "example.com", organizationId: "org_1", projectId: "proj_1" };

describe("a control-plane route's JSON body cap", () => {
    it("answers 413 to a streamed body past the default cap, before reading the rest or running the route", async () => {
        const ctx = makeCtx();
        const { body, counter, total } = streamed(domain, 4 * MAX_JSON_BODY_BYTES);

        const response = await withContext(handleDomainAddRoute)(post("/v1/domains", body), environment(ctx));

        expect(response.status).toBe(413);
        expect(counter.pulled).toBeLessThan(total);
        expect(ctx.runMutation).not.toHaveBeenCalled();
    });

    it("answers 413 to a body whose content-length is past the cap, unread", async () => {
        const ctx = makeCtx();
        const request = new Request("https://control.lunora.app/v1/domains", {
            body: JSON.stringify({ ...domain, padding: "x".repeat(MAX_JSON_BODY_BYTES) }),
            method: "POST",
        });

        const response = await withContext(handleDomainAddRoute)(request, environment(ctx));

        expect(response.status).toBe(413);
        expect(ctx.runMutation).not.toHaveBeenCalled();
    });

    it("reads a body under the cap", async () => {
        const ctx = makeCtx();
        const { body } = streamed(domain, MAX_JSON_BODY_BYTES / 2);

        const response = await withContext(handleDomainAddRoute)(post("/v1/domains", body), environment(ctx));

        expect(response.status).toBe(200);
        expect(ctx.runMutation).toHaveBeenCalledTimes(1);
    });

    it("still answers 400 to a body that is not JSON", async () => {
        const response = await withContext(handleDomainAddRoute)(post("/v1/domains", "{"), environment(makeCtx()));

        expect(response.status).toBe(400);
    });

    it("lets the admin proxy carry a body as large as the tenant runtime accepts", async () => {
        const ctx = makeCtx();
        const { body } = streamed({ deploymentId: "dep_1", organizationId: "org_1", path: "tables" }, 1024 * 1024);

        const response = await withContext(handleAdminRoute)(post("/v1/admin", body), environment(ctx));

        // No target resolves in this context: the proxy got past the body and answered for the missing deployment.
        expect(response.status).toBe(404);
        expect(ctx.runQuery).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ deploymentId: "dep_1", organizationId: "org_1" }));
    });
});
