import { describe, expect, it } from "vitest";

import { SESSION_DO_TTL_DEFAULT, SessionDO } from "../src/session-do";

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
            async delete(key) {
                return map.delete(key);
            },
            async get(key) {
                return map.get(key);
            },
            async put(key, value) {
                map.set(key, value);
            },
        },
    };
};

/**
 * A fuller double that also models the GC-sweep surface (`list` + alarms),
 * which the three-method {@link createFakeStorage} deliberately omits. Sessions
 * routed through the `ShardKvStore`/`ShardAlarms` contracts read these, so the
 * sweep path needs a storage that exposes them.
 */
const createGcStorage = (): {
    armedAlarm: () => number | null;
    storage: {
        delete: (k: string) => Promise<boolean>;
        get: (k: string) => Promise<unknown>;
        getAlarm: () => Promise<number | null>;
        list: (options?: { prefix?: string }) => Promise<Map<string, unknown>>;
        put: (k: string, v: unknown) => Promise<void>;
        setAlarm: (t: number) => Promise<void>;
    };
} => {
    const map = new Map<string, unknown>();
    let alarm: number | null = null;

    return {
        armedAlarm: () => alarm,
        storage: {
            async delete(key) {
                return map.delete(key);
            },
            async get(key) {
                return map.get(key);
            },
            async getAlarm() {
                return alarm;
            },
            async list(options) {
                const prefix = options?.prefix ?? "";
                const result = new Map<string, unknown>();

                for (const [key, value] of map) {
                    if (key.startsWith(prefix)) {
                        result.set(key, value);
                    }
                }

                return result;
            },
            async put(key, value) {
                map.set(key, value);
            },
            async setAlarm(t) {
                alarm = t;
            },
        },
    };
};

const authHeaders = (extra: Record<string, string> = {}): Record<string, string> => {
    return {
        "content-type": "application/json",
        "x-lunora-session-do-secret": TEST_SECRET,
        ...extra,
    };
};

describe("sessionDO", () => {
    it("create persists a record and returns it", async () => {
        expect.assertions(3);

        const state = createFakeStorage();
        const session = new SessionDO(state as any, TEST_ENV);

        const response = await session.fetch(
            new Request("https://session.internal/create", {
                body: JSON.stringify({ token: TOK_1, ttlSeconds: 60, userId: "u1" }),
                headers: authHeaders(),
                method: "POST",
            }),
        );

        expect(response.status).toBe(201);

        const body = await response.json<{ expiresAt: number; userId: string }>();

        expect(body.userId).toBe("u1");
        expect(body.expiresAt).toBeGreaterThan(Date.now());
    });

    it("get returns the persisted record, 404s for missing tokens", async () => {
        expect.assertions(2);

        const state = createFakeStorage();
        const session = new SessionDO(state as any, TEST_ENV);

        await session.fetch(
            new Request("https://session.internal/create", {
                body: JSON.stringify({ token: TOK_2, ttlSeconds: 60, userId: "u-A" }),
                headers: authHeaders(),
                method: "POST",
            }),
        );

        const found = await session.fetch(new Request("https://session.internal/get", { headers: authHeaders({ "x-lunora-session-token": TOK_2 }) }));

        expect(found.status).toBe(200);

        const missing = await session.fetch(
            new Request("https://session.internal/get", { headers: authHeaders({ "x-lunora-session-token": "e".repeat(32) }) }),
        );

        expect(missing.status).toBe(404);
    });

    it("get expires sessions lazily", async () => {
        expect.assertions(2);

        const state = createFakeStorage();

        // Inject an already-expired record so the lazy-expire branch runs.
        await state.storage.put(`s:${TOK_DEAD}`, { createdAt: Date.now() - 10_000, expiresAt: Date.now() - 1, userId: "u" });

        const session = new SessionDO(state as any, TEST_ENV);
        const response = await session.fetch(new Request("https://session.internal/get", { headers: authHeaders({ "x-lunora-session-token": TOK_DEAD }) }));

        expect(response.status).toBe(404);
        await expect(state.storage.get(`s:${TOK_DEAD}`)).resolves.toBeUndefined();
    });

    it("revoke deletes the record idempotently", async () => {
        expect.assertions(2);

        const state = createFakeStorage();
        const session = new SessionDO(state as any, TEST_ENV);

        await session.fetch(
            new Request("https://session.internal/create", {
                body: JSON.stringify({ token: TOK_DOOMED, userId: "u" }),
                headers: authHeaders(),
                method: "POST",
            }),
        );

        const first = await session.fetch(
            new Request("https://session.internal/revoke", {
                headers: authHeaders({ "x-lunora-session-token": TOK_DOOMED }),
                method: "DELETE",
            }),
        );

        expect(first.status).toBe(200);

        // Idempotent — revoking a missing token still succeeds.
        const second = await session.fetch(
            new Request("https://session.internal/revoke", {
                headers: authHeaders({ "x-lunora-session-token": TOK_DOOMED }),
                method: "DELETE",
            }),
        );

        expect(second.status).toBe(200);
    });

    it("rejects malformed create bodies", async () => {
        expect.assertions(2);

        const state = createFakeStorage();
        const session = new SessionDO(state as any, TEST_ENV);

        const noToken = await session.fetch(
            new Request("https://session.internal/create", {
                body: JSON.stringify({ userId: "u" }),
                headers: authHeaders(),
                method: "POST",
            }),
        );

        expect(noToken.status).toBe(400);

        const noJson = await session.fetch(
            new Request("https://session.internal/create", {
                body: "not json",
                headers: authHeaders(),
                method: "POST",
            }),
        );

        expect(noJson.status).toBe(400);
    });

    it("rejects requests missing the shared secret", async () => {
        expect.assertions(1);

        const state = createFakeStorage();
        const session = new SessionDO(state as any, TEST_ENV);

        const response = await session.fetch(
            new Request("https://session.internal/create", {
                body: JSON.stringify({ token: TOK_1, userId: "u" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );

        expect(response.status).toBe(401);
    });

    it("sweeps expired records through the KV list contract and re-arms while sessions remain", async () => {
        expect.assertions(4);

        const state = createGcStorage();

        // One expired, one live — seeded straight into storage so the sweep runs
        // deterministically without waiting out a real TTL.
        await state.storage.put(`s:${TOK_DEAD}`, { createdAt: Date.now() - 10_000, expiresAt: Date.now() - 1, userId: "dead" });
        await state.storage.put(`s:${TOK_1}`, { createdAt: Date.now(), expiresAt: Date.now() + 60_000, userId: "live" });

        const session = new SessionDO(state as any, TEST_ENV);
        await session.alarm();

        // Expired swept, live kept.
        await expect(state.storage.get(`s:${TOK_DEAD}`)).resolves.toBeUndefined();
        await expect(state.storage.get(`s:${TOK_1}`)).resolves.toBeDefined();

        // A survivor remains, so the recurring sweep re-arms for the future.
        const armed = state.armedAlarm();

        expect(armed).not.toBeNull();
        expect(armed).toBeGreaterThan(Date.now());
    });

    it("create arms a single GC alarm through the alarm contract", async () => {
        expect.assertions(2);

        const state = createGcStorage();
        const session = new SessionDO(state as any, TEST_ENV);

        await session.fetch(
            new Request("https://session.internal/create", {
                body: JSON.stringify({ token: TOK_2, ttlSeconds: 60, userId: "u" }),
                headers: authHeaders(),
                method: "POST",
            }),
        );

        const firstArm = state.armedAlarm();

        expect(firstArm).not.toBeNull();

        // A second create must not re-arm — one recurring sweep, not a thrash.
        await session.fetch(
            new Request("https://session.internal/create", {
                body: JSON.stringify({ token: TOK_1, ttlSeconds: 60, userId: "u" }),
                headers: authHeaders(),
                method: "POST",
            }),
        );

        expect(state.armedAlarm()).toBe(firstArm);
    });

    it("falls back to the default TTL when none is supplied", async () => {
        expect.assertions(1);

        const state = createFakeStorage();
        const session = new SessionDO(state as any, TEST_ENV);

        const response = await session.fetch(
            new Request("https://session.internal/create", {
                body: JSON.stringify({ token: TOK_1, userId: "u" }),
                headers: authHeaders(),
                method: "POST",
            }),
        );
        const body = await response.json<{ createdAt: number; expiresAt: number }>();
        const ttlMs = body.expiresAt - body.createdAt;

        expect(ttlMs).toBe(SESSION_DO_TTL_DEFAULT * 1000);
    });
});
