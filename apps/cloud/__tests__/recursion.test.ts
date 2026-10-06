import { afterEach, describe, expect, it, vi } from "vitest";

import { recordRecursionStop, setRecursionPolicy } from "../lunora/edge";
import { LINEAGE_HEADER, MAX_LINEAGE_DEPTH, parseLineageParameter, readLineage, signLineage, stampLineage } from "../src/dispatcher/lineage";
import dispatcher from "../src/dispatcher/worker";
import type { AnalyticsEngineDatasetLike } from "../src/targets/cloudflare-wfp/analytics";
import { makeCtx, owner } from "./_helpers/fake-ctx";

const SECRET = "lineage-test-secret";
const ROOT = "0123456789abcdef0123456789abcdef"; // eslint-disable-line no-secrets/no-secrets -- a test chain id, not a secret
const NOW = 1_700_000_000_000;

describe("signed lineage", () => {
    it("verifies what it signed", async () => {
        const header = await signLineage(SECRET, { depth: 3, root: ROOT }, NOW);

        await expect(readLineage(header, SECRET, NOW + 1000)).resolves.toStrictEqual({ lineage: { depth: 3, root: ROOT }, status: "valid" });
    });

    it("refuses a header whose depth was rewritten to reset the chain", async () => {
        const header = await signLineage(SECRET, { depth: 15, root: ROOT }, NOW);

        await expect(readLineage(header.replace("v1.15.", "v1.1."), SECRET, NOW)).resolves.toStrictEqual({ status: "invalid" });
    });

    it("refuses a header signed with another key, a stale one, and garbage", async () => {
        await expect(readLineage(await signLineage("not-the-key", { depth: 1, root: ROOT }, NOW), SECRET, NOW)).resolves.toStrictEqual({ status: "invalid" });
        await expect(readLineage(await signLineage(SECRET, { depth: 1, root: ROOT }, NOW), SECRET, NOW + 120_000)).resolves.toStrictEqual({
            status: "invalid",
        });
        await expect(readLineage("v1.0.root.0.sig", SECRET, NOW)).resolves.toStrictEqual({ status: "invalid" });
    });

    it("is inert without a secret: a header is neither honoured nor refused", async () => {
        await expect(readLineage("anything", undefined, NOW)).resolves.toStrictEqual({ status: "none" });
        await expect(readLineage(null, SECRET, NOW)).resolves.toStrictEqual({ status: "none" });
    });
});

describe(stampLineage, () => {
    it("replaces a lineage header the tenant set with the platform's, one hop deeper", async () => {
        const forged = new Request("https://acme.lunora.app/", { headers: { [LINEAGE_HEADER]: "v1.0.forged", "x-other": "kept" } });
        const stamped = await stampLineage(forged, { LUNORA_LINEAGE_SECRET: SECRET, lineage: `4.${ROOT}` }, NOW);

        await expect(readLineage(stamped.headers.get(LINEAGE_HEADER), SECRET, NOW)).resolves.toStrictEqual({
            lineage: { depth: 5, root: ROOT },
            status: "valid",
        });
        expect(stamped.headers.get("x-other")).toBe("kept");
    });

    it("strips and stamps nothing without the secret or a well-formed parameter", async () => {
        const forged = new Request("https://acme.lunora.app/", { headers: { [LINEAGE_HEADER]: "v1.0.forged" } });

        const unsigned = await stampLineage(forged, { lineage: `4.${ROOT}` }, NOW);
        const malformed = await stampLineage(forged, { LUNORA_LINEAGE_SECRET: SECRET, lineage: "4.not-a-root" }, NOW);

        expect(unsigned.headers.get(LINEAGE_HEADER)).toBeNull();
        expect(malformed.headers.get(LINEAGE_HEADER)).toBeNull();
    });
});

type Get = (
    name: string,
    args?: unknown,
    options?: { limits?: unknown; outbound?: { lineage?: string } },
) => { fetch: (request: Request) => Promise<Response> };

const metrics = () => vi.fn<AnalyticsEngineDatasetLike["writeDataPoint"]>();

const makeEnv = (tenant: (request: Request) => Promise<Response>, extra: Record<string, unknown> = {}) => {
    const writeDataPoint = metrics();

    return {
        env: {
            DISPATCHER: { get: vi.fn<Get>().mockReturnValue({ fetch: tenant }) },
            LUNORA_APP_DOMAIN: "lunora.app",
            LUNORA_LINEAGE_SECRET: SECRET,
            PLATFORM_METRICS: { writeDataPoint },
            ...extra,
        },
        writeDataPoint,
    };
};

/** The recursion rows the dispatcher wrote: `[outcome, depth]`. */
const recursionPoints = (writeDataPoint: ReturnType<typeof metrics>) =>
    writeDataPoint.mock.calls
        .map(([point]) => point)
        .filter((point) => point?.blobs?.[0] === "recursion")
        .map((point) => [point?.blobs?.[2], point?.doubles?.[0]]);

const signedRequest = async (depth: number, host = "acme.lunora.app") =>
    new Request(`https://${host}/`, { headers: { [LINEAGE_HEADER]: await signLineage(SECRET, { depth, root: ROOT }, Date.now()) } });

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("dispatcher recursion protection", () => {
    it("starts a request from outside at depth 0 and hands the Outbound Worker its lineage", async () => {
        const { env } = makeEnv(async () => new Response("ok"));

        await dispatcher.fetch(new Request("https://acme.lunora.app/"), env as never);

        const lineage = parseLineageParameter(env.DISPATCHER.get.mock.calls[0]?.[2]?.outbound?.lineage);

        expect(lineage?.depth).toBe(0);
    });

    it("carries a verified depth and never shows the tenant the header", async () => {
        const tenant = vi.fn(async (_request: Request) => new Response("ok"));
        const { env } = makeEnv(tenant);

        await dispatcher.fetch(await signedRequest(3), env as never);

        expect(env.DISPATCHER.get.mock.calls[0]?.[2]?.outbound?.lineage).toBe(`3.${ROOT}`);
        expect(tenant.mock.calls[0]?.[0].headers.get(LINEAGE_HEADER)).toBeNull();
    });

    it("refuses a forged lineage header before the tenant runs, and meters it", async () => {
        const tenant = vi.fn(async () => new Response("ok"));
        const { env, writeDataPoint } = makeEnv(tenant);
        const forged = new Request("https://acme.lunora.app/", {
            headers: { [LINEAGE_HEADER]: `v1.0.${ROOT}.${String(Math.floor(Date.now() / 1000))}.${"0".repeat(64)}` },
        });

        const response = await dispatcher.fetch(forged, env as never);

        expect(response.status).toBe(400);
        expect(tenant).not.toHaveBeenCalled();
        expect(recursionPoints(writeDataPoint)).toStrictEqual([["forged", 0]]);
    });

    it("terminates a chain at the depth cap with 508, a metric and an audit report", async () => {
        // The plan lookup answers a verified plan (admission fails closed on anything else); every other call is the recursion report.
        const reports = vi.fn(async (url: string, _init?: RequestInit) =>
            Response.json(new URL(url).pathname === "/v1/tenants/plan" ? { plan: "pro" } : { recorded: true }),
        );

        vi.stubGlobal("fetch", reports);

        const tenant = vi.fn(async () => new Response("ok"));
        const { env, writeDataPoint } = makeEnv(tenant, { CONTROL_PLANE_TOKEN: "admin", CONTROL_PLANE_URL: "https://cp.example" });

        const response = await dispatcher.fetch(await signedRequest(MAX_LINEAGE_DEPTH, "loopy.lunora.app"), env as never);

        expect(response.status).toBe(508);
        expect(tenant).not.toHaveBeenCalled();
        expect(recursionPoints(writeDataPoint)).toStrictEqual([["terminated", MAX_LINEAGE_DEPTH]]);

        const report = reports.mock.calls.find(([url]) => url.endsWith("/v1/tenants/recursion"));

        const body = report?.[1]?.body;

        expect(JSON.parse(typeof body === "string" ? body : "null")).toStrictEqual({ depth: MAX_LINEAGE_DEPTH, scriptName: "loopy" });
    });

    it("lets the chain through under an org's `allow` policy, and still meters it", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => (url.includes("/v1/tenants/plan") ? Response.json({ plan: "pro", recursion: "allow" }) : Response.json({}))),
        );

        const tenant = vi.fn(async () => new Response("ok"));
        const { env, writeDataPoint } = makeEnv(tenant, { CONTROL_PLANE_TOKEN: "admin-allow", CONTROL_PLANE_URL: "https://cp-allow.example" });

        const response = await dispatcher.fetch(await signedRequest(MAX_LINEAGE_DEPTH, "allowed.lunora.app"), env as never);

        expect(response.status).toBe(200);
        expect(recursionPoints(writeDataPoint)).toStrictEqual([["allowed", MAX_LINEAGE_DEPTH]]);
    });

    it("stops a self-calling tenant after the cap, end to end through the Outbound Worker", async () => {
        let invocations = 0;
        const { env } = makeEnv(async () => new Response("never"));

        // Each invocation fetches its own hostname; the Outbound Worker stamps the
        // lineage the dispatcher passed it, and the request comes back in.
        env.DISPATCHER.get.mockImplementation((_name, _args, options) => {
            return {
                fetch: async (request: Request) => {
                    invocations += 1;

                    const outgoing = await stampLineage(request, { LUNORA_LINEAGE_SECRET: SECRET, lineage: options?.outbound?.lineage }, Date.now());

                    return dispatcher.fetch(outgoing, env as never);
                },
            };
        });

        const response = await dispatcher.fetch(new Request("https://acme.lunora.app/"), env as never);

        expect(response.status).toBe(508);
        expect(invocations).toBe(MAX_LINEAGE_DEPTH);
    });

    it("is inert without the secret: a header is stripped and nothing is refused", async () => {
        const tenant = vi.fn(async (_request: Request) => new Response("ok"));
        const { env } = makeEnv(tenant, { LUNORA_LINEAGE_SECRET: undefined });
        const response = await dispatcher.fetch(new Request("https://acme.lunora.app/", { headers: { [LINEAGE_HEADER]: "garbage" } }), env as never);

        expect(response.status).toBe(200);
    });
});

describe("recursion audit and policy", () => {
    const now = 1_700_000_000_000;

    it("audits a terminated chain under the org that owns the script's deployment", async () => {
        const { ctx, ops } = makeCtx({ auditLog: [], deployments: [{ _id: "dep1", organizationId: "org1", scriptName: "loopy" }] }, { now });

        await expect(recordRecursionStop.handler(ctx, { depth: 16, scriptName: "loopy" })).resolves.toStrictEqual({ recorded: true });
        expect(ops.find((op) => op.kind === "insert" && op.table === "auditLog")).toMatchObject({
            document: { action: "recursion.terminate", actorUserId: "system:dispatcher", organizationId: "org1", target: "loopy at depth 16" },
        });
    });

    it("records nothing for a script that is no deployment, and dedupes within a minute", async () => {
        const unknown = makeCtx({ auditLog: [], deployments: [] }, { now });

        await expect(recordRecursionStop.handler(unknown.ctx, { depth: 16, scriptName: "ghost" })).resolves.toStrictEqual({ recorded: false });

        const recent = makeCtx(
            {
                auditLog: [{ _id: "a1", action: "recursion.terminate", createdAt: now - 1000, organizationId: "org1", target: "loopy at depth 16" }],
                deployments: [{ _id: "dep1", organizationId: "org1", scriptName: "loopy" }],
            },
            { now },
        );

        await expect(recordRecursionStop.handler(recent.ctx, { depth: 16, scriptName: "loopy" })).resolves.toStrictEqual({ recorded: false });
    });

    it("sets the policy for owners and admins only, from the verified membership, audited", async () => {
        const { ctx, ops } = makeCtx({ members: [owner("org1")], organizations: [{ _id: "org1" }] }, { now });

        await setRecursionPolicy.handler(ctx, { organizationId: "org1", policy: "allow" } as never);

        expect(ops).toContainEqual({ id: "org1", kind: "patch", patch: { recursionPolicy: "allow" } });
        expect(ops.find((op) => op.kind === "insert" && op.table === "auditLog")).toMatchObject({ document: { action: "recursion.policy", target: "allow" } });

        const viewer = makeCtx({ members: [{ ...owner("org1"), role: "viewer" }], organizations: [{ _id: "org1" }] }, { now });

        await expect(setRecursionPolicy.handler(viewer.ctx, { organizationId: "org1", policy: "allow" } as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
});
