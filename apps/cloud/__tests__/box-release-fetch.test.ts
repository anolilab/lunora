import { describe, expect, it } from "vitest";

import { ownsDeployment } from "../lunora/boxes";
import { randomBase64Url } from "../src/boxes/encoding";
import type { SigningBox } from "../src/boxes/signed-request";
import { TIMESTAMP_WINDOW_MS, verifyBoxRequest } from "../src/boxes/signed-request";
import { createReleaseStore } from "../src/deploy/release-store";
import { isRoutePattern, matchRoutePath } from "../src/deploy/route-path";
import { createDeployRouter } from "../src/deploy/router";
import { handleBoxReleaseRoute } from "../src/deploy/routes/boxes";
import type { RouterEnv } from "../src/deploy/routes/shared";
import { makeCtx } from "./_helpers/fake-ctx";
import memoryReleaseStore from "./_helpers/memory-release-store";
import type { BoxKey } from "./support/box-session-fakes";
import { boxKey, fakeState, namespaceOver, signedHeaders, TestBoxSession } from "./support/box-session-fakes";
import { memoryStore } from "./support/memory-store";

const NOW = 1_700_000_000_000;
const PATH = "/v1/boxes/releases/dep_1";

/** What the router hands the route for {@link PATH}. */
const PARAMETERS = { deploymentId: "dep_1" };
const BUNDLE = btoa("export default {}");

const signedRequest = async (key: BoxKey, overrides: { boxId?: string; nonce?: string; path?: string; timestamp?: number } = {}): Promise<Request> => {
    const nonce = overrides.nonce ?? randomBase64Url();
    const headers = await signedHeaders(key, {
        boxId: overrides.boxId ?? "box_1",
        method: "GET",
        nonce,
        path: overrides.path ?? PATH,
        timestamp: overrides.timestamp ?? NOW,
    });

    return new Request(`https://cloud.test${PATH}`, { headers });
};

/** Nonce claims kept the way the session object keeps them: until they expire. */
const nonceLedger = (): { claimNonce: (boxId: string, nonce: string, expiresAt: number) => Promise<boolean>; claims: Map<string, number> } => {
    const claims = new Map<string, number>();

    return {
        claimNonce: (boxId, nonce, expiresAt) => {
            const key = `${boxId}:${nonce}`;

            if ((claims.get(key) ?? 0) > NOW) {
                return Promise.resolve(false);
            }

            claims.set(key, expiresAt);

            return Promise.resolve(true);
        },
        claims,
    };
};

describe("box-signed requests", () => {
    const portsFor = (key: BoxKey, box: Partial<SigningBox> = {}) => {
        const ledger = nonceLedger();

        return {
            ledger,
            ports: {
                claimNonce: ledger.claimNonce,
                loadBox: (boxId: string) =>
                    Promise.resolve(boxId === "box_1" ? { organizationId: "org_1", publicKey: key.publicKey, revoked: false, ...box } : null),
                now: NOW,
            },
        };
    };

    it("accepts a request signed by the box, and remembers its nonce until the window closes", async () => {
        const key = await boxKey();
        const { ledger, ports } = portsFor(key);

        await expect(verifyBoxRequest(await signedRequest(key, { nonce: "n".repeat(22) }), ports)).resolves.toStrictEqual({
            boxId: "box_1",
            organizationId: "org_1",
        });
        expect(ledger.claims.get(`box_1:${"n".repeat(22)}`)).toBe(NOW + TIMESTAMP_WINDOW_MS);
    });

    it("refuses a request without a timestamp, even one validly signed — nothing would ever expire it", async () => {
        const key = await boxKey();
        const { ledger, ports } = portsFor(key);
        const nonce = "u".repeat(22);
        // The untimed payload the protocol used to allow: an empty timestamp line.
        const untimed = new TextEncoder().encode(["lunora-hostd-request:v1", "GET", PATH, "box_1", "", nonce].join("\n"));
        const request = new Request(`https://cloud.test${PATH}`, {
            headers: { "x-lunora-box-id": "box_1", "x-lunora-box-nonce": nonce, "x-lunora-box-signature": await key.sign(untimed) },
        });

        await expect(verifyBoxRequest(request, ports)).resolves.toBeNull();
        expect(ledger.claims.size).toBe(0);
    });

    it("refuses a request from a day ago, whatever happened to its nonce", async () => {
        const key = await boxKey();
        const { ledger, ports } = portsFor(key);

        await expect(verifyBoxRequest(await signedRequest(key, { timestamp: NOW - 24 * 60 * 60 * 1000 }), ports)).resolves.toBeNull();
        expect(ledger.claims.size).toBe(0);
    });

    it("refuses a replayed nonce", async () => {
        const key = await boxKey();
        const { ports } = portsFor(key);
        const nonce = randomBase64Url();

        await expect(verifyBoxRequest(await signedRequest(key, { nonce }), ports)).resolves.not.toBeNull();
        await expect(verifyBoxRequest(await signedRequest(key, { nonce }), ports)).resolves.toBeNull();
    });

    it.each([
        ["a signature for another path", { path: "/v1/boxes/releases/dep_2" }],
        ["a timestamp outside the window", { timestamp: NOW - TIMESTAMP_WINDOW_MS - 1 }],
        ["an unknown box", { boxId: "box_2" }],
    ])("refuses %s", async (_name, overrides) => {
        const key = await boxKey();
        const { ledger, ports } = portsFor(key);

        await expect(verifyBoxRequest(await signedRequest(key, overrides), ports)).resolves.toBeNull();
        expect(ledger.claims.size).toBe(0);
    });

    it("refuses another key's signature and a revoked box, without burning the nonce", async () => {
        const key = await boxKey();
        const intruder = await boxKey();

        await expect(verifyBoxRequest(await signedRequest(intruder), portsFor(key).ports)).resolves.toBeNull();
        await expect(verifyBoxRequest(await signedRequest(key), portsFor(key, { revoked: true }).ports)).resolves.toBeNull();
    });

    it("refuses an unsigned or malformed request", async () => {
        const key = await boxKey();

        await expect(verifyBoxRequest(new Request(`https://cloud.test${PATH}`), portsFor(key).ports)).resolves.toBeNull();
        await expect(
            verifyBoxRequest(
                new Request(`https://cloud.test${PATH}`, { headers: { "x-lunora-box-id": "box_1", "x-lunora-box-nonce": "short" } }),
                portsFor(key).ports,
            ),
        ).resolves.toBeNull();
    });
});

describe("route patterns", () => {
    it("matches one id-shaped segment per parameter, and nothing else", () => {
        expect(isRoutePattern("/v1/boxes/releases/:deploymentId")).toBe(true);
        expect(isRoutePattern("/v1/boxes/connect")).toBe(false);
        expect(matchRoutePath("/v1/boxes/releases/:deploymentId", "/v1/boxes/releases/dep_1")).toStrictEqual({ deploymentId: "dep_1" });
        expect(matchRoutePath("/v1/boxes/releases/:deploymentId", "/v1/boxes/releases/a.b")).toBeNull();
        expect(matchRoutePath("/v1/boxes/releases/:deploymentId", "/v1/boxes/releases/dep_1/x")).toBeNull();
        expect(matchRoutePath("/v1/boxes/releases/:deploymentId", "/v1/boxes/releases/")).toBeNull();
    });

    it("dispatches a pattern route through the router", async () => {
        const response = await createDeployRouter().fetch(new Request(`https://cloud.test${PATH}`), { __lunoraCtx: {} });

        // Reached the handler (which refuses without the bindings), not the router's 404.
        expect(response.status).toBe(503);
    });
});

describe("boxes.ownsDeployment", () => {
    const tables = (deployment: Record<string, unknown> = {}, project: Record<string, unknown> = {}) => {
        return {
            boxes: [{ _id: "box_1", organizationId: "org_1", status: "online" }],
            deployments: [{ _id: "dep_1", organizationId: "org_1", projectId: "proj_1", target: "celld-vps", ...deployment }],
            projects: [{ _id: "proj_1", organizationId: "org_1", placementRef: "box_1", ...project }],
        };
    };

    it("answers true only for a celld-vps deployment of a project on that box", async () => {
        const run = (seed: ReturnType<typeof tables>) => ownsDeployment.handler(makeCtx(seed).ctx, { boxId: "box_1" as never, deploymentId: "dep_1" as never });

        await expect(run(tables())).resolves.toBe(true);
        await expect(run(tables({ target: "cloudflare-wfp" }))).resolves.toBe(false);
        await expect(run(tables({}, { placementRef: "box_2" }))).resolves.toBe(false);
        await expect(run(tables({ organizationId: "org_2" }))).resolves.toBe(false);
    });
});

describe("the release download, GET /v1/boxes/releases/:deploymentId", () => {
    const setup = async (owns = true) => {
        const key = await boxKey();
        const session = new TestBoxSession(fakeState(), memoryStore());
        const releases = memoryReleaseStore();

        await releases.store.put("dep_1", { bundle: BUNDLE, manifest: { bindings: [] } });

        const environment: RouterEnv & { BOX_SESSION: ReturnType<typeof namespaceOver> } = {
            __lunoraCtx: {
                runAction: () => Promise.reject(new Error("unused")),
                runMutation: () => Promise.reject(new Error("unused")),
                runQuery: <R>(_reference: unknown, args: Record<string, unknown> = {}) =>
                    Promise.resolve(("deploymentId" in args ? owns : { organizationId: "org_1", publicKey: key.publicKey, revoked: false, slug: "b1" }) as R),
            },
            BOX_SESSION: namespaceOver(session),
            RELEASES: {
                delete: () => Promise.resolve(),
                get: (objectKey) => {
                    const value = releases.objects.get(objectKey);

                    return Promise.resolve(value === undefined ? null : { text: () => Promise.resolve(value) });
                },
                put: () => Promise.resolve(),
            },
        };

        return { environment, key };
    };

    it("streams the stored release to the box it belongs to, once per nonce", async () => {
        const { environment, key } = await setup();
        const nonce = randomBase64Url();
        const timestamp = Date.now();
        const request = async () =>
            new Request(`https://cloud.test${PATH}`, { headers: await signedHeaders(key, { boxId: "box_1", method: "GET", nonce, path: PATH, timestamp }) });

        const response = await handleBoxReleaseRoute(await request(), environment, PARAMETERS);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual({ bundle: BUNDLE, manifest: { bindings: [] } });
        await expect(handleBoxReleaseRoute(await request(), environment, PARAMETERS)).resolves.toMatchObject({ status: 401 });
    });

    it("answers 404 for a release that is not this box's", async () => {
        const { environment, key } = await setup(false);
        const response = await handleBoxReleaseRoute(
            new Request(`https://cloud.test${PATH}`, {
                headers: await signedHeaders(key, { boxId: "box_1", method: "GET", nonce: randomBase64Url(), path: PATH, timestamp: Date.now() }),
            }),
            environment,
            PARAMETERS,
        );

        expect(response.status).toBe(404);
    });

    it("answers 401 to an unsigned request", async () => {
        const { environment } = await setup();

        await expect(handleBoxReleaseRoute(new Request(`https://cloud.test${PATH}`), environment, PARAMETERS)).resolves.toMatchObject({ status: 401 });
    });

    it("streams through the release store without parsing the release", async () => {
        const stream = await createReleaseStore({
            delete: () => Promise.resolve(),
            get: () => Promise.resolve({ body: new Response('{"bundle":"x"}').body ?? undefined, text: () => Promise.reject(new Error("must not buffer")) }),
            put: () => Promise.resolve(),
        }).open("dep_1");

        await expect(new Response(stream).text()).resolves.toBe('{"bundle":"x"}');
    });
});
