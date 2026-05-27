import { describe, expect, test } from "vitest";

import { SessionDO, SESSION_DO_TTL_DEFAULT } from "../src/SessionDO.js";

/**
 * Tiny in-process double for `DurableObjectStorage`. We only model the three
 * methods SessionDO uses (`get`, `put`, `delete`) so a regression in the
 * SQL layer of a real DO can't hide behind a fat fake.
 */
const createFakeStorage = (): { storage: { get: (k: string) => Promise<unknown>; put: (k: string, v: unknown) => Promise<void>; delete: (k: string) => Promise<boolean> } } => {
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

describe("SessionDO", () => {
    test("create persists a record and returns it", async () => {
        const state = createFakeStorage();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const session = new SessionDO(state as any, {});

        const response = await session.fetch(
            new Request("https://session.internal/create", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ token: "tok-1", userId: "u1", ttlSeconds: 60 }),
            }),
        );

        expect(response.status).toBe(201);

        const body = (await response.json()) as { userId: string; expiresAt: number };

        expect(body.userId).toBe("u1");
        expect(body.expiresAt).toBeGreaterThan(Date.now());
    });

    test("get returns the persisted record, 404s for missing tokens", async () => {
        const state = createFakeStorage();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const session = new SessionDO(state as any, {});

        await session.fetch(
            new Request("https://session.internal/create", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ token: "tok-A", userId: "u-A", ttlSeconds: 60 }),
            }),
        );

        const found = await session.fetch(new Request("https://session.internal/get?token=tok-A"));

        expect(found.status).toBe(200);

        const missing = await session.fetch(new Request("https://session.internal/get?token=other"));

        expect(missing.status).toBe(404);
    });

    test("get expires sessions lazily", async () => {
        const state = createFakeStorage();
        // Inject an already-expired record so the lazy-expire branch runs.
        await state.storage.put("s:dead", { userId: "u", createdAt: Date.now() - 10_000, expiresAt: Date.now() - 1 });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const session = new SessionDO(state as any, {});
        const response = await session.fetch(new Request("https://session.internal/get?token=dead"));

        expect(response.status).toBe(404);
        expect(await state.storage.get("s:dead")).toBeUndefined();
    });

    test("revoke deletes the record idempotently", async () => {
        const state = createFakeStorage();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const session = new SessionDO(state as any, {});

        await session.fetch(
            new Request("https://session.internal/create", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ token: "doomed", userId: "u" }),
            }),
        );

        const first = await session.fetch(new Request("https://session.internal/revoke?token=doomed", { method: "DELETE" }));

        expect(first.status).toBe(200);

        // Idempotent — revoking a missing token still succeeds.
        const second = await session.fetch(new Request("https://session.internal/revoke?token=doomed", { method: "DELETE" }));

        expect(second.status).toBe(200);
    });

    test("rejects malformed create bodies", async () => {
        const state = createFakeStorage();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const session = new SessionDO(state as any, {});

        const noToken = await session.fetch(
            new Request("https://session.internal/create", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ userId: "u" }),
            }),
        );

        expect(noToken.status).toBe(400);

        const noJson = await session.fetch(
            new Request("https://session.internal/create", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: "not json",
            }),
        );

        expect(noJson.status).toBe(400);
    });

    test("falls back to the default TTL when none is supplied", async () => {
        const state = createFakeStorage();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const session = new SessionDO(state as any, {});

        const response = await session.fetch(
            new Request("https://session.internal/create", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ token: "t", userId: "u" }),
            }),
        );
        const body = (await response.json()) as { createdAt: number; expiresAt: number };
        const ttlMs = body.expiresAt - body.createdAt;

        expect(ttlMs).toBe(SESSION_DO_TTL_DEFAULT * 1000);
    });
});
