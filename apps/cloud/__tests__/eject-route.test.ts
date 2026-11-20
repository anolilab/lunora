import { afterEach, describe, expect, it, vi } from "vitest";

import { EJECT_HEADERS, handleEjectRoute } from "../src/deploy/routes/eject";

type Port = (reference: unknown, args?: Record<string, unknown>) => Promise<unknown>;

const TARGET = { adminToken: "tenant-admin", organizationId: "org_1", projectSlug: "acme", scriptName: "acme-v3", url: "https://acme.lunora.app" };

const ejectRequest = (): Request =>
    new Request("https://control.lunora.app/v1/eject", {
        body: JSON.stringify({ deploymentId: "dep_1" }),
        headers: { authorization: "Bearer lk_live_key", "content-type": "application/json" },
        method: "POST",
    });

describe("post /v1/eject", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("passes the tenant's export through as the body, unread, with the deployment's identity in headers", async () => {
        expect.assertions(4);

        let sent = false;
        let finish = (): void => undefined;
        const finished = new Promise<void>((resolve) => {
            finish = resolve;
        });
        // One row, then an export still in flight: a route that buffered the export before answering would not answer yet.
        const inFlight = new ReadableStream<Uint8Array>({
            pull: async (controller) => {
                if (!sent) {
                    sent = true;
                    controller.enqueue(new TextEncoder().encode('{"table":"users","doc":{}}\n'));

                    return;
                }

                await finished;
                controller.close();
            },
        });

        vi.stubGlobal(
            "fetch",
            vi.fn<typeof fetch>(() => Promise.resolve(new Response(inFlight, { status: 200 }))),
        );

        const context = { runMutation: vi.fn<Port>().mockResolvedValue(null), runQuery: vi.fn<Port>().mockResolvedValue(TARGET) };
        const response = await handleEjectRoute(ejectRequest(), { __lunoraCtx: context } as never);

        expect(response.status).toBe(200);
        expect(Object.fromEntries(Object.values(EJECT_HEADERS).map((name) => [name, response.headers.get(name)]))).toStrictEqual({
            [EJECT_HEADERS.projectSlug]: "acme",
            [EJECT_HEADERS.scriptName]: "acme-v3",
            [EJECT_HEADERS.url]: "https://acme.lunora.app",
        });

        const reader = (response.body as ReadableStream<Uint8Array>).getReader();
        const first = await reader.read();

        expect(new TextDecoder().decode(first.value)).toContain('"table":"users"');

        finish();

        await expect(reader.read()).resolves.toMatchObject({ done: true });
    });
});
