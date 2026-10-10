import { beforeEach, describe, expect, it, vi } from "vitest";

import { installApp, listCatalog } from "../src/catalog/service";
import { createDeployPacer } from "../src/deploy/pacing";
import { handleCatalogInstallRoute, handleCatalogRoute } from "../src/deploy/routes/catalog";
import type { RouterEnv } from "../src/deploy/routes/shared";
import readJson from "./_helpers/read-json";

const session = vi.hoisted(() => {
    return { userId: undefined as string | undefined };
});

// eslint-disable-next-line vitest/prefer-import-in-mock -- the session stub is partial, which the real module type rejects
vi.mock("../src/auth", () => {
    return {
        currentAuth: () => {
            return {
                api: {
                    getSession: () => Promise.resolve(session.userId === undefined ? null : { user: { id: session.userId } }),
                },
            };
        },
    };
});

vi.mock(import("../src/catalog/service"), async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/catalog/service")>();

    return { ...actual, installApp: vi.fn<typeof actual.installApp>(), listCatalog: vi.fn<typeof actual.listCatalog>() };
});

const KEY = "k".repeat(64);
const RELEASES = {} as NonNullable<RouterEnv["RELEASES"]>;

/** A context whose reads return the given members, and whose writes are never expected. */
const contextWith = (members: { role: string; userId: string }[]): NonNullable<RouterEnv["__lunoraCtx"]> =>
    ({
        runAction: () => Promise.reject(new Error("unused")),
        runMutation: () => Promise.reject(new Error("unexpected write")),
        runQuery: () => Promise.resolve(members),
    }) as NonNullable<RouterEnv["__lunoraCtx"]>;

const environmentWith = (members: { role: string; userId: string }[], overrides: Partial<RouterEnv> = {}): RouterEnv => {
    return {
        RELEASES,
        SECRET_ENCRYPTION_KEY: KEY,
        __lunoraCtx: contextWith(members),
        ...overrides,
    };
};

const pacer = createDeployPacer();
const OWNER = [{ role: "owner", userId: "user_owner" }];

const listRequest = (query: string): Request => new Request(`https://cloud.test/v1/catalog${query}`);
const installRequest = (body: unknown): Request =>
    new Request("https://cloud.test/v1/catalog/install", { body: typeof body === "string" ? body : JSON.stringify(body), method: "POST" });

const validBody = { organizationId: "org_1", projectId: "proj_1", slug: "counter", values: { secrets: {}, vars: {} } };

describe("the catalog routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        session.userId = "user_owner";
    });

    describe("the catalog listing, GET /v1/catalog", () => {
        it("refuses a request without an organization before reading the catalog", async () => {
            const response = await handleCatalogRoute(listRequest(""), environmentWith(OWNER));

            expect(response.status).toBe(400);
            await expect(readJson(response)).resolves.toStrictEqual({ error: "organizationId is required" });
            expect(listCatalog).not.toHaveBeenCalled();
        });

        it("answers the verified apps and the skipped ones", async () => {
            vi.mocked(listCatalog).mockResolvedValueOnce({
                apps: [{ form: { secrets: [], vars: [] }, installs: [], name: "Counter", slug: "counter", summary: "A counter.", version: "1.0.0" }],
                ok: true,
                skipped: [{ reason: "its manifest does not match the sha256 the index names", slug: "notes", version: "2.0.0" }],
            });

            const response = await handleCatalogRoute(listRequest("?organizationId=org_1"), environmentWith(OWNER));

            expect(response.status).toBe(200);
            await expect(readJson(response)).resolves.toStrictEqual({
                apps: [{ form: { secrets: [], vars: [] }, installs: [], name: "Counter", slug: "counter", summary: "A counter.", version: "1.0.0" }],
                skipped: [{ reason: "its manifest does not match the sha256 the index names", slug: "notes", version: "2.0.0" }],
            });
        });

        it("answers 503 with the reason when the catalog cannot be read", async () => {
            vi.mocked(listCatalog).mockResolvedValueOnce({ error: "the official index failed verification", ok: false });

            const response = await handleCatalogRoute(listRequest("?organizationId=org_1"), environmentWith(OWNER));

            expect(response.status).toBe(503);
            await expect(readJson(response)).resolves.toStrictEqual({ error: "the official index failed verification" });
        });

        it("answers 500 without leaking the error when the listing throws", async () => {
            vi.mocked(listCatalog).mockRejectedValueOnce(new Error("socket reset with internal details"));

            const response = await handleCatalogRoute(listRequest("?organizationId=org_1"), environmentWith(OWNER));

            expect(response.status).toBe(500);
            await expect(readJson(response)).resolves.toStrictEqual({ error: "catalog unavailable" });
        });
    });

    describe("the install route, POST /v1/catalog/install", () => {
        it("refuses a body that is not a JSON object before anything is checked", async () => {
            const response = await handleCatalogInstallRoute(installRequest("null"), environmentWith(OWNER), pacer);

            expect(response.status).toBe(400);
            await expect(readJson(response)).resolves.toStrictEqual({ error: "a JSON object body is required" });
            expect(installApp).not.toHaveBeenCalled();
        });

        it("names the missing field", async () => {
            const response = await handleCatalogInstallRoute(installRequest({ ...validBody, slug: undefined }), environmentWith(OWNER), pacer);

            expect(response.status).toBe(400);
            await expect(readJson(response)).resolves.toStrictEqual({ error: "slug is required", field: "slug" });
        });

        it("names the secret whose value is not a string", async () => {
            const body = { ...validBody, values: { secrets: { DB_PASSWORD: 42 }, vars: {} } };

            const response = await handleCatalogInstallRoute(installRequest(body), environmentWith(OWNER), pacer);

            expect(response.status).toBe(400);
            await expect(readJson(response)).resolves.toStrictEqual({ error: "DB_PASSWORD must be a string", field: "DB_PASSWORD" });
        });

        it("answers 401 when no one is signed in", async () => {
            session.userId = undefined;

            const response = await handleCatalogInstallRoute(installRequest(validBody), environmentWith(OWNER), pacer);

            expect(response.status).toBe(401);
            expect(installApp).not.toHaveBeenCalled();
        });

        it("refuses a member who is neither owner nor admin, before anything is written", async () => {
            const members = [{ role: "member", userId: "user_owner" }];

            const response = await handleCatalogInstallRoute(installRequest(validBody), environmentWith(members), pacer);

            expect(response.status).toBe(403);
            await expect(readJson(response)).resolves.toStrictEqual({ error: "only owners and admins can install a catalog app" });
            expect(installApp).not.toHaveBeenCalled();
        });

        it("refuses a signed-in user who is not a member of the organization", async () => {
            const response = await handleCatalogInstallRoute(installRequest(validBody), environmentWith([]), pacer);

            expect(response.status).toBe(403);
            expect(installApp).not.toHaveBeenCalled();
        });

        it("installs as the signed-in user and answers the outcome", async () => {
            vi.mocked(installApp).mockResolvedValueOnce({
                deploymentId: "dep_1",
                generated: ["SIGNING_KEY"],
                kept: ["DB_PASSWORD"],
                ok: true,
                recorded: true,
                url: "https://acme.example.test",
            });

            const response = await handleCatalogInstallRoute(installRequest(validBody), environmentWith(OWNER), pacer);

            expect(response.status).toBe(200);
            await expect(readJson(response)).resolves.toStrictEqual({
                deploymentId: "dep_1",
                generated: ["SIGNING_KEY"],
                kept: ["DB_PASSWORD"],
                recorded: true,
                url: "https://acme.example.test",
            });
            expect(vi.mocked(installApp).mock.calls[0]?.[1]).toMatchObject({ installedBy: "user_owner", organizationId: "org_1", slug: "counter" });
        });

        it("answers without a url when the release has none", async () => {
            vi.mocked(installApp).mockResolvedValueOnce({ deploymentId: "dep_1", generated: [], kept: [], ok: true, recorded: false });

            const response = await handleCatalogInstallRoute(installRequest(validBody), environmentWith(OWNER), pacer);

            await expect(readJson(response)).resolves.toStrictEqual({ deploymentId: "dep_1", generated: [], kept: [], recorded: false });
        });

        it.each([
            ["busy", 409],
            ["conflict", 409],
            ["internal", 500],
            ["invalidInput", 400],
            ["notFound", 404],
            ["unavailable", 503],
            ["upstream", 502],
            ["verification", 422],
        ] as const)("answers a %s failure with %i", async (kind, status) => {
            vi.mocked(installApp).mockResolvedValueOnce({ error: `the ${kind} reason`, kind, ok: false });

            const response = await handleCatalogInstallRoute(installRequest(validBody), environmentWith(OWNER), pacer);

            expect(response.status).toBe(status);
            await expect(readJson(response)).resolves.toStrictEqual({ error: `the ${kind} reason` });
        });

        it("carries the artifact error code and the field of a failure", async () => {
            vi.mocked(installApp).mockResolvedValueOnce({
                code: "HASH_MISMATCH",
                error: "worker.js does not match its sha256",
                field: "worker.js",
                kind: "verification",
                ok: false,
            });

            const response = await handleCatalogInstallRoute(installRequest(validBody), environmentWith(OWNER), pacer);

            expect(response.status).toBe(422);
            await expect(readJson(response)).resolves.toStrictEqual({
                code: "HASH_MISMATCH",
                error: "worker.js does not match its sha256",
                field: "worker.js",
            });
        });

        it("answers 500 when no release bucket is configured, since a release could not be rolled back", async () => {
            const response = await handleCatalogInstallRoute(installRequest(validBody), environmentWith(OWNER, { RELEASES: undefined }), pacer);

            expect(response.status).toBe(500);
            expect(installApp).not.toHaveBeenCalled();
        });

        it("answers 500 when secrets cannot be sealed, before anything is written", async () => {
            const response = await handleCatalogInstallRoute(installRequest(validBody), environmentWith(OWNER, { SECRET_ENCRYPTION_KEY: undefined }), pacer);

            expect(response.status).toBe(500);
            await expect(readJson(response)).resolves.toStrictEqual({ error: "SECRET_ENCRYPTION_KEY not configured" });
            expect(installApp).not.toHaveBeenCalled();
        });
    });
});
