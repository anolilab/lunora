import { describe, expect, test } from "vitest";

import { SESSION_DO_TTL_DEFAULT, SessionDO } from "../src/session-do.js";

const TEST_SECRET = "test-session-do-secret-value";
const TEST_ENV = { SESSION_DO_SECRET: TEST_SECRET };
// Tokens must be 32–256 chars, base64url charset.
const TOK_1 = "a".repeat(32);
const TOK_2 = "b".repeat(32);
const TOK_DEAD = "c".repeat(32);
const TOK_DOOMED = "d".repeat(32);

/**
 * Tiny in-process double for `DurableObjectStorage`. We only model the three
 * methods SessionDO uses (`get`, `put`, `delete`) so a regression in the
 * SQL layer of a real DO can't hide behind a fat fake.
 */
const createFakeStorage = (): {
    storage: { delete: (k: string) => Promise<boolean>; get: (k: string) => Promise<unknown>; put: (k: string, v: unknown) => Promise<void> };
} => {
    const map = new Map<string, unknown>();

    return {
        storage: {
            async get(key) {
                return map.get(key);
            },
            async put(key, value) {
                map.set(key, value);
            },
            async delete(key) {
                return map.delete(key);
            },
        },
    };
};

const authHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
    "content-type": "application/json",
    "x-cirrus-session-do-secret": TEST_SECRET,
    ...extra,
});

describe("sessionDO", () => {
    test("create persists a record and returns it", async () => {
        expect.assertions(3);

        const state = createFakeStorage();
        const session = new SessionDO(state as any, TEST_ENV);

        const response = await session.fetch(
            new Request("https://session.internal/create", {
                method: "POST",
                headers: authHeaders(),
                body: JSON.stringify({ token: TOK_1, userId: "u1", ttlSeconds: 60 }),
            }),
        );

        expect(response.status).toBe(201);

        const body = (await response.json()) as { expiresAt: number; userId: string };

        expect(body.userId).toBe("u1");
        expect(body.expiresAt).toBeGreaterThan(Date.now());
    });

    test("get returns the persisted record, 404s for missing tokens", async () => {
        expect.assertions(2);

        const state = createFakeStorage();
        const session = new SessionDO(state as any, TEST_ENV);

        await session.fetch(
            new Request("https://session.internal/create", {
                method: "POST",
                headers: authHeaders(),
                body: JSON.stringify({ token: TOK_2, userId: "u-A", ttlSeconds: 60 }),
            }),
        );

        const found = await session.fetch(new Request("https://session.internal/get", { headers: authHeaders({ "x-cirrus-session-token": TOK_2 }) }));

        expect(found.status).toBe(200);

        const missing = await session.fetch(
            new Request("https://session.internal/get", { headers: authHeaders({ "x-cirrus-session-token": "e".repeat(32) }) }),
        );

        expect(missing.status).toBe(404);
    });

    test("get expires sessions lazily", async () => {
        expect.assertions(2);

        const state = createFakeStorage();

        // Inject an already-expired record so the lazy-expire branch runs.
        await state.storage.put(`s:${TOK_DEAD}`, { userId: "u", createdAt: Date.now() - 10_000, expiresAt: Date.now() - 1 });

        const session = new SessionDO(state as any, TEST_ENV);
        const response = await session.fetch(new Request("https://session.internal/get", { headers: authHeaders({ "x-cirrus-session-token": TOK_DEAD }) }));

        expect(response.status).toBe(404);
        await expect(state.storage.get(`s:${TOK_DEAD}`)).resolves.toBeUndefined();
    });

    test("revoke deletes the record idempotently", async () => {
        expect.assertions(2);

        const state = createFakeStorage();
        const session = new SessionDO(state as any, TEST_ENV);

        await session.fetch(
            new Request("https://session.internal/create", {
                method: "POST",
                headers: authHeaders(),
                body: JSON.stringify({ token: TOK_DOOMED, userId: "u" }),
            }),
        );

        const first = await session.fetch(
            new Request("https://session.internal/revoke", {
                method: "DELETE",
                headers: authHeaders({ "x-cirrus-session-token": TOK_DOOMED }),
            }),
        );

        expect(first.status).toBe(200);

        // Idempotent — revoking a missing token still succeeds.
        const second = await session.fetch(
            new Request("https://session.internal/revoke", {
                method: "DELETE",
                headers: authHeaders({ "x-cirrus-session-token": TOK_DOOMED }),
            }),
        );

        expect(second.status).toBe(200);
    });

    test("rejects malformed create bodies", async () => {
        expect.assertions(2);

        const state = createFakeStorage();
        const session = new SessionDO(state as any, TEST_ENV);

        const noToken = await session.fetch(
            new Request("https://session.internal/create", {
                method: "POST",
                headers: authHeaders(),
                body: JSON.stringify({ userId: "u" }),
            }),
        );

        expect(noToken.status).toBe(400);

        const noJson = await session.fetch(
            new Request("https://session.internal/create", {
                method: "POST",
                headers: authHeaders(),
                body: "not json",
            }),
        );

        expect(noJson.status).toBe(400);
    });

    test("rejects requests missing the shared secret", async () => {
        expect.assertions(1);

        const state = createFakeStorage();
        const session = new SessionDO(state as any, TEST_ENV);

        const response = await session.fetch(
            new Request("https://session.internal/create", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ token: TOK_1, userId: "u" }),
            }),
        );

        expect(response.status).toBe(401);
    });

    test("falls back to the default TTL when none is supplied", async () => {
        expect.assertions(1);

        const state = createFakeStorage();
        const session = new SessionDO(state as any, TEST_ENV);

        const response = await session.fetch(
            new Request("https://session.internal/create", {
                method: "POST",
                headers: authHeaders(),
                body: JSON.stringify({ token: TOK_1, userId: "u" }),
            }),
        );
        const body = (await response.json()) as { createdAt: number; expiresAt: number };
        const ttlMs = body.expiresAt - body.createdAt;

        expect(ttlMs).toBe(SESSION_DO_TTL_DEFAULT * 1000);
    });
});
