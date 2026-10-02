import { DatabaseSync } from "node:sqlite";

import { mcp as betterAuthMcp } from "@better-auth/mcp";
import { createWorker, withFrameworkWorker } from "@lunora/runtime";
import { describe, expect, it, vi } from "vitest";

import { LunoraAuthDO } from "../src/auth-do";
import type { LunoraAuthOptions } from "../src/create-auth";
import { createAuth } from "../src/create-auth";
import { authDiscoveryPaths, authDiscoveryPathsFor, handleAuthDiscoveryRequest } from "../src/discovery";
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

    // better-auth keeps a path-bearing baseURL as the base URL and ignores basePath.
    it("takes the issuer path from a path-bearing baseURL over basePath", () => {
        expect.assertions(1);

        expect(authDiscoveryPaths({ ...mcpOptions(), basePath: "/ignored", baseURL: `${ORIGIN}/auth/v1` })).toContain(
            "/.well-known/oauth-authorization-server/auth/v1",
        );
    });

    // With `disableJwtPlugin`, oauth-provider's issuer is the base URL, not jwt.issuer.
    it("ignores jwt.issuer when the provider disables the jwt plugin", () => {
        expect.assertions(1);

        expect(
            authDiscoveryPaths({
                ...mcpOptions(),
                plugins: [
                    jwt({ jwt: { issuer: `${ORIGIN}/issuer` } }),
                    mcp({ consentPage: "/c", disableJwtPlugin: true, loginPage: "/l", resource: RESOURCE }),
                ],
            }),
        ).toContain(AS_PATH);
    });

    // `@better-auth/mcp`'s own `mcp`, or a spread copy, carries no Lunora mark.
    it("falls back to the provider's only resource for an unmarked mcp()", () => {
        expect.assertions(2);

        const plain = betterAuthMcp({ consentPage: "/c", loginPage: "/l", resource: RESOURCE });

        expect(authDiscoveryPaths({ ...mcpOptions(), plugins: [jwt(), plain] })).toContain(PRM_PATH);
        expect(authDiscoveryPaths({ ...mcpOptions(), plugins: [jwt(), { ...mcp({ consentPage: "/c", loginPage: "/l", resource: RESOURCE }) }] })).toContain(
            PRM_PATH,
        );
    });

    it("refuses at construction an unmarked mcp() whose MCP resource is ambiguous", () => {
        expect.assertions(1);

        const plain = betterAuthMcp({ consentPage: "/c", loginPage: "/l", resource: RESOURCE, resources: ["https://other.example.com/api"] });

        expect(() => createAuth({ ...mcpOptions(), plugins: [jwt(), plain] })).toThrow(expect.objectContaining({ code: "AUTH_MCP_RESOURCE_AMBIGUOUS" }));
    });

    it("keeps a plain oauthProvider() with several resources working", () => {
        expect.assertions(1);

        const provider = oauthProvider({ consentPage: "/c", loginPage: "/l", resources: ["https://a.example.com/api", "https://b.example.com/api"] });

        expect(authDiscoveryPaths({ plugins: [jwt(), provider], secret: SECRET })).toStrictEqual([AS_PATH]);
    });
});

// The GET/HEAD rule is the auth side's to own: the runtime offers every request
// that missed the app's routes.
describe("discovery handlers refuse anything but GET/HEAD", () => {
    const post = (): Request => new Request(`${ORIGIN}${PRM_PATH}`, { body: "{}", method: "POST" });

    it("in D1 mode", async () => {
        expect.assertions(1);

        await expect(handleAuthDiscoveryRequest(createMemoryAuth(mcpOptions()), post())).resolves.toBeUndefined();
    });

    it("in DO mode, without a round-trip to the object", async () => {
        expect.assertions(2);

        const objectFetch = vi.fn<(request: Request) => Promise<Response>>(async () => new Response("{}"));
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

        await expect(wiring.discoveryHandler(post())).resolves.toBeUndefined();
        expect(objectFetch).not.toHaveBeenCalled();
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
    const d1Worker = () => {
        const auth = createMemoryAuth(mcpOptions());

        return buildWorker({
            authDiscoveryHandler: async (request) => await handleAuthDiscoveryRequest(auth, request),
            authHandler: async (request) => await handleAuthRequest(auth, request),
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

    // A framework-hosted worker rebuilds its options on every request. The paths
    // codegen passes come from `authDiscoveryPathsFor`, so the declaration's
    // `options(env)` — which rebuilds every plugin — runs once, not per request.
    it("derives the paths once across many framework-mode requests", async () => {
        expect.assertions(2);

        const authDo = new LunoraAuthDO({ storage: createDoStorage(new DatabaseSync(":memory:")) }, () => mcpOptions(), { internalSecret: INTERNAL_SECRET });
        const declaration = { options: vi.fn<(env: unknown) => LunoraAuthOptions>(() => mcpOptions()) };
        const worker = withFrameworkWorker(
            () => new Response(null, { status: 404 }),
            (env) => {
                const wiring = createDoAuthWiring({
                    discoveryPaths: authDiscoveryPathsFor(declaration, env),
                    internalSecret: INTERNAL_SECRET,
                    namespace: {
                        get: () => {
                            return { fetch: async (request: Request) => await authDo.fetch(request) };
                        },
                        idFromName: (name) => name,
                    },
                });

                return { authDiscoveryHandler: wiring.discoveryHandler, authHandler: wiring.authHandler, shardDO: unusedShards };
            },
        );

        const responses = await Promise.all([PRM_PATH, AS_PATH, PRM_PATH, AS_PATH, PRM_PATH].map(async (path) => await get(worker, path)));

        expect(responses.map((response) => response.status)).toStrictEqual([200, 200, 200, 200, 200]);
        expect(declaration.options).toHaveBeenCalledTimes(1);
    });
});
