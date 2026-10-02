import { DatabaseSync } from "node:sqlite";

import { createWorker } from "@lunora/runtime";
import { describe, expect, it, vi } from "vitest";

import { LunoraAuthDO } from "../src/auth-do";
import type { LunoraAuthOptions } from "../src/create-auth";
import { authDiscoveryPaths, handleAuthDiscoveryRequest } from "../src/discovery";
import { createDoAuthWiring } from "../src/do-wiring";
import { handleAuthRequest } from "../src/handler";
import { jwt, mcp, oauthProvider } from "../src/plugins";
import createDoStorage from "./helpers/do-storage";
import createMemoryAuth from "./helpers/memory-auth";

/**
 * The OAuth discovery documents served by a Lunora worker (plan 461 B): which
 * paths an auth configuration derives, and both documents fetched through a real
 * `createWorker` wired the way codegen wires it, in D1 mode (the auth instance in
 * the worker) and DO mode (better-auth inside a `LunoraAuthDO`).
 */

const ORIGIN = "https://api.example.com";
const RESOURCE = `${ORIGIN}/mcp`;
/** The issuer the authorization-server URL below is built from: `baseURL` + `/api/auth`. */
const ISSUER = `${ORIGIN}/api/auth`;
const PRM_PATH = "/.well-known/oauth-protected-resource/mcp";
const AS_PATH = "/.well-known/oauth-authorization-server/api/auth";
const SECRET = "x".repeat(32);
const INTERNAL_SECRET = "discovery-internal-secret"; // secret-scanner:allow

const mcpOptions = (): Omit<LunoraAuthOptions, "database"> => {
    return {
        baseURL: ORIGIN,
        plugins: [jwt(), mcp({ consentPage: "/consent", loginPage: "/login", resource: RESOURCE, scopes: ["lunora:read"] })],
        secret: SECRET,
    };
};

const executionContext = { passThroughOnException: () => undefined, waitUntil: () => undefined };

/** A shard namespace no request in this suite reaches. */
const unusedShards = {
    get: () => {
        return { fetch: async () => new Response(null, { status: 500 }) };
    },
    idFromName: (name: string) => name,
};

type WorkerOptions = Parameters<typeof createWorker>[0];

const buildWorker = (options: Partial<WorkerOptions>) => createWorker({ shardDO: unusedShards, ...options });

const get = async (worker: ReturnType<typeof createWorker>, path: string): Promise<Response> =>
    await worker.fetch(new Request(`${ORIGIN}${path}`), {}, executionContext);

describe(authDiscoveryPaths, () => {
    it("derives nothing without an oauth-provider plugin", () => {
        expect.assertions(1);

        expect(authDiscoveryPaths({ plugins: [jwt()], secret: SECRET })).toStrictEqual([]);
    });

    it("derives the resource's and the issuer's paths for mcp()", () => {
        expect.assertions(1);

        expect(authDiscoveryPaths(mcpOptions())).toStrictEqual([PRM_PATH, AS_PATH]);
    });

    it("derives only the issuer's path for a plain oauthProvider()", () => {
        expect.assertions(1);

        expect(authDiscoveryPaths({ plugins: [jwt(), oauthProvider({ consentPage: "/c", loginPage: "/l" })], secret: SECRET })).toStrictEqual([AS_PATH]);
    });

    it("follows a custom base path and a jwt issuer", () => {
        expect.assertions(2);

        expect(authDiscoveryPaths({ ...mcpOptions(), basePath: "/auth" })).toContain("/.well-known/oauth-authorization-server/auth");
        expect(
            authDiscoveryPaths({
                ...mcpOptions(),
                plugins: [jwt({ jwt: { issuer: `${ORIGIN}/issuer` } }), mcp({ consentPage: "/c", loginPage: "/l", resource: RESOURCE })],
            }),
        ).toContain("/.well-known/oauth-authorization-server/issuer");
    });
});

/** Assert both documents through `worker`, and that the AS issuer is the one its URL was built from. */
const expectBothDocuments = async (worker: ReturnType<typeof createWorker>): Promise<void> => {
    const prm = await get(worker, PRM_PATH);
    const prmBody: { authorization_servers: string[]; resource: string } = await prm.json();
    const as = await get(worker, AS_PATH);
    const asBody: { issuer: string } = await as.json();

    expect(prm.status).toBe(200);
    expect(prmBody.resource).toBe(RESOURCE);
    expect(prmBody.authorization_servers).toStrictEqual([ISSUER]);
    expect(as.status).toBe(200);
    // RFC 8414 §3.3: a client discards metadata whose issuer differs from the one it
    // built the well-known URL from.
    expect(asBody.issuer).toBe(ISSUER);
};

describe("discovery through createWorker, D1 mode", () => {
    /** The two handlers codegen emits for D1-backed auth. */
    const d1Worker = (extra: Partial<WorkerOptions> = {}) => {
        const auth = createMemoryAuth(mcpOptions());

        return buildWorker({
            authDiscoveryHandler: async (request) => await handleAuthDiscoveryRequest(auth, request),
            authHandler: async (request) => await handleAuthRequest(auth, request),
            ...extra,
        });
    };

    it("serves both documents", async () => {
        expect.assertions(5);

        await expectBothDocuments(d1Worker());
    });

    it("serves no other /.well-known path", async () => {
        expect.assertions(1);

        await expect(get(d1Worker(), "/.well-known/oauth-protected-resource")).resolves.toHaveProperty("status", 404);
    });

    it("lets an app route at the same path win", async () => {
        expect.assertions(2);

        const router = {
            fetch: async (request: Request) => (new URL(request.url).pathname === PRM_PATH ? new Response("app's own") : new Response(null, { status: 404 })),
        };
        const response = await get(d1Worker({ httpRouter: router }), PRM_PATH);

        expect(response.status).toBe(200);
        await expect(response.text()).resolves.toBe("app's own");
    });

    it("serves nothing for an app without mcp() or oauthProvider()", async () => {
        expect.assertions(1);

        const auth = createMemoryAuth({ baseURL: ORIGIN, plugins: [jwt()], secret: SECRET });
        const worker = buildWorker({ authDiscoveryHandler: async (request) => await handleAuthDiscoveryRequest(auth, request) });

        await expect(get(worker, AS_PATH)).resolves.toHaveProperty("status", 404);
    });
});

describe("discovery through createWorker, DO mode", () => {
    /** The wiring codegen emits for DO-backed auth, over a real `LunoraAuthDO`. */
    const doWorker = () => {
        const authDo = new LunoraAuthDO({ storage: createDoStorage(new DatabaseSync(":memory:")) }, () => mcpOptions(), { internalSecret: INTERNAL_SECRET });
        const objectFetch = vi.fn<(request: Request) => Promise<Response>>(async (request) => await authDo.fetch(request));
        const wiring = createDoAuthWiring({
            discoveryPaths: authDiscoveryPaths(mcpOptions()),
            internalSecret: INTERNAL_SECRET,
            namespace: {
                get: () => {
                    return { fetch: objectFetch };
                },
                idFromName: (name) => name,
            },
        });

        return {
            objectFetch,
            worker: buildWorker({ authDiscoveryHandler: wiring.discoveryHandler, authHandler: wiring.authHandler }),
        };
    };

    it("serves both documents from the object", async () => {
        expect.assertions(5);

        await expectBothDocuments(doWorker().worker);
    });

    // The paths are derived in the worker: any other probe is answered there.
    it("never asks the object about a path it does not serve", async () => {
        expect.assertions(2);

        const { objectFetch, worker } = doWorker();

        await expect(get(worker, "/.well-known/security.txt")).resolves.toHaveProperty("status", 404);
        expect(objectFetch).not.toHaveBeenCalled();
    });
});
