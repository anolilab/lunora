import { describe, expect, it } from "vitest";

import { sha256Hex } from "../src/deploy/keys";
import { handleBoxConnectRoute, handleBoxEnrolRoute, handleBoxRevokeRoute } from "../src/deploy/routes/boxes";
import type { RouterEnv } from "../src/deploy/routes/shared";
import readJson from "./_helpers/read-json";
import { fakeSessionNamespace } from "./support/box-session-fakes";

const TOKEN = `lbe_${"ab".repeat(32)}`;

const contextRecording = (result: unknown = {}) => {
    const calls: { args: Record<string, unknown>; reference: unknown }[] = [];

    return {
        calls,
        context: {
            runAction: () => Promise.reject(new Error("unused")),
            runMutation: (reference: unknown, args: Record<string, unknown> = {}) => {
                calls.push({ args, reference });

                return Promise.resolve(result);
            },
            runQuery: () => Promise.reject(new Error("unused")),
        } as NonNullable<RouterEnv["__lunoraCtx"]>,
    };
};

const enrolRequest = (body: unknown): Request => new Request("https://cloud.test/v1/boxes/enrol", { body: JSON.stringify(body), method: "POST" });

describe("the enrol route, POST /v1/boxes/enrol", () => {
    const body = { ipv4: "203.0.113.9", publicKey: "k".repeat(43), token: TOKEN, versions: { caddy: "v2", celld: "v0.6.0", hostd: "1.0.0" } };

    it("hashes the token at the edge and answers the box's id and hostname", async () => {
        const { calls, context } = contextRecording({ boxId: "box_1", created: true, organizationId: "org_1", slug: "bslug000001" });

        const response = await handleBoxEnrolRoute(enrolRequest(body), { __lunoraCtx: context, LUNORA_BOX_DOMAIN: "boxes.test" });

        expect(response.status).toBe(200);
        await expect(readJson(response)).resolves.toStrictEqual({
            boxId: "box_1",
            dnsError: "box DNS is not configured on this control plane (LUNORA_BOX_ZONE_ID is unset)",
            hostname: "bslug000001.boxes.test",
            organizationId: "org_1",
            slug: "bslug000001",
        });
        expect(calls[0]?.args).toStrictEqual({
            hashedToken: await sha256Hex(TOKEN),
            ipv4: "203.0.113.9",
            publicKey: "k".repeat(43),
            singleTrust: false,
            versions: body.versions,
        });
        expect(JSON.stringify(calls)).not.toContain(TOKEN);
    });

    it("refuses a malformed token without reaching the store", async () => {
        const { calls, context } = contextRecording();

        const response = await handleBoxEnrolRoute(enrolRequest({ ...body, token: "guess" }), { __lunoraCtx: context });

        expect(response.status).toBe(403);
        expect(calls).toStrictEqual([]);
    });
});

describe("the session upgrade, GET /v1/boxes/connect", () => {
    const forwarded: Request[] = [];
    const environment = {
        BOX_SESSION: fakeSessionNamespace((boxId) => {
            return {
                fetch: (request: Request) => {
                    forwarded.push(request);

                    return Promise.resolve(new Response(`id:${boxId}`, { status: 200 }));
                },
            };
        }),
    };

    it("hands the upgrade, and only the upgrade, to the box's own session object", async () => {
        const response = await handleBoxConnectRoute(
            new Request("https://cloud.test/v1/boxes/connect?box=box_1", { headers: { upgrade: "websocket" } }),
            environment,
        );

        await expect(response.text()).resolves.toBe("id:box_1");
        expect(new URL(forwarded.at(-1)?.url ?? "").searchParams.get("box")).toBe("box_1");
        expect(forwarded.at(-1)?.headers.get("upgrade")).toBe("websocket");
    });

    it.each([
        ["no box id", "https://cloud.test/v1/boxes/connect", { upgrade: "websocket" }, 400],
        ["a malformed box id", "https://cloud.test/v1/boxes/connect?box=../dispatch", { upgrade: "websocket" }, 400],
        ["no upgrade", "https://cloud.test/v1/boxes/connect?box=box_1", {}, 426],
    ])("refuses %s", async (_name, url, headers, status) => {
        const response = await handleBoxConnectRoute(new Request(url, { headers }), environment);

        expect(response.status).toBe(status);
    });

    it("answers 503 on a control plane with no box sessions bound", async () => {
        const response = await handleBoxConnectRoute(new Request("https://cloud.test/v1/boxes/connect?box=box_1", { headers: { upgrade: "websocket" } }), {});

        expect(response.status).toBe(503);
    });
});

describe("the revoke route, POST /v1/boxes/revoke", () => {
    it("revokes through the mutation, then closes the box's session", async () => {
        const { calls, context } = contextRecording({ slug: "bslug000001" });
        const closes: string[] = [];
        const response = await handleBoxRevokeRoute(
            new Request("https://cloud.test/v1/boxes/revoke", { body: JSON.stringify({ id: "box_1", organizationId: "org_1" }), method: "POST" }),
            {
                __lunoraCtx: context,
                BOX_SESSION: fakeSessionNamespace((boxId) => {
                    return {
                        close: (code: string) => {
                            closes.push(`${boxId} ${code}`);

                            return Promise.resolve(1);
                        },
                    };
                }),
            },
        );

        await expect(readJson(response)).resolves.toStrictEqual({
            dnsError: "box DNS is not configured on this control plane (LUNORA_BOX_ZONE_ID is unset)",
            ok: true,
            sessionClosed: true,
        });
        expect(calls[0]?.args).toStrictEqual({ id: "box_1", organizationId: "org_1" });
        expect(closes).toStrictEqual(["box_1 BOX_REVOKED"]);
    });
});
