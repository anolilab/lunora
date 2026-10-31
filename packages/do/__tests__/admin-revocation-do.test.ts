import { describe, expect, it } from "vitest";

import { AdminRevocationDO } from "../src/admin-revocation-do";

const ROOT = "root-admin-token";

/**
 * Storage with no `list` at all, so the store cannot depend on a listing being complete: the type
 * does not offer one, and nothing here could answer it.
 */
const createStore = (): { entries: Map<string, unknown>; state: ConstructorParameters<typeof AdminRevocationDO>[0] } => {
    const entries = new Map<string, unknown>();

    return {
        entries,
        state: {
            storage: {
                get: async <T>(key: string) => entries.get(key) as T | undefined,
                put: async (written: Record<string, unknown>) => {
                    for (const [key, entry] of Object.entries(written)) {
                        entries.set(key, entry);
                    }
                },
            },
        },
    };
};

const send = async (target: AdminRevocationDO, path: string, init: RequestInit & { bearer?: string } = {}): Promise<Response> =>
    target.fetch(
        new Request(`https://revocations.internal${path}`, {
            ...init,
            headers: { ...(init.bearer === undefined ? {} : { authorization: `Bearer ${init.bearer}` }), "content-type": "application/json" },
        }),
    );

const statusOf = async (pending: Promise<Response>): Promise<number> => {
    const response = await pending;

    return response.status;
};

const jsonOf = async (pending: Promise<Response>): Promise<unknown> => {
    const response = await pending;

    return response.json();
};

const revoke = async (target: AdminRevocationDO, name: string, createdAt: number): Promise<number> =>
    statusOf(send(target, "/revoke", { bearer: ROOT, body: JSON.stringify({ createdAt, name }), method: "POST" }));

describe(AdminRevocationDO, () => {
    it("answers whether one exact issuance is revoked, by direct lookup", async () => {
        expect.assertions(4);

        const target = new AdminRevocationDO(createStore().state, { LUNORA_ADMIN_TOKEN: ROOT });

        await expect(revoke(target, "ci", 5)).resolves.toBe(200);
        await expect(jsonOf(send(target, "/revoked?name=ci&createdAt=5", { bearer: ROOT }))).resolves.toStrictEqual({ revoked: true });
        await expect(jsonOf(send(target, "/revoked?name=ci&createdAt=6", { bearer: ROOT }))).resolves.toStrictEqual({ revoked: false });
        await expect(jsonOf(send(target, "/revoked?name=other&createdAt=5", { bearer: ROOT }))).resolves.toStrictEqual({ revoked: false });
    });

    it("stays correct with far more revocations than any page holds", async () => {
        expect.assertions(4);

        const target = new AdminRevocationDO(createStore().state, { LUNORA_ADMIN_TOKEN: ROOT });

        for (let createdAt = 1; createdAt <= 2000; createdAt += 1) {
            // Sequential on purpose: each is a separate durable write.
            // eslint-disable-next-line no-await-in-loop -- the writes are one after another, as the route makes them
            await revoke(target, "ci", createdAt);
        }

        // The oldest and the newest are both still refused, and the newest is what a re-create must pass.
        await expect(jsonOf(send(target, "/revoked?name=ci&createdAt=1", { bearer: ROOT }))).resolves.toStrictEqual({ revoked: true });
        await expect(jsonOf(send(target, "/revoked?name=ci&createdAt=2000", { bearer: ROOT }))).resolves.toStrictEqual({ revoked: true });
        await expect(jsonOf(send(target, "/latest?name=ci", { bearer: ROOT }))).resolves.toStrictEqual({ latest: 2000 });
        await expect(jsonOf(send(target, "/latest?name=nobody", { bearer: ROOT }))).resolves.toStrictEqual({ latest: null });
    });

    it("keeps the latest revoked createdAt when revocations arrive out of order", async () => {
        expect.assertions(1);

        const target = new AdminRevocationDO(createStore().state, { LUNORA_ADMIN_TOKEN: ROOT });

        await revoke(target, "ci", 50);
        await revoke(target, "ci", 10);

        await expect(jsonOf(send(target, "/latest?name=ci", { bearer: ROOT }))).resolves.toStrictEqual({ latest: 50 });
    });

    it("answers only the root token, and nothing at all without one configured", async () => {
        expect.assertions(5);

        const store = createStore();
        const target = new AdminRevocationDO(store.state, { LUNORA_ADMIN_TOKEN: ROOT });
        const body = JSON.stringify({ createdAt: 5, name: "ci" });

        await expect(statusOf(send(target, "/revoke", { body, method: "POST" }))).resolves.toBe(403);
        await expect(statusOf(send(target, "/revoke", { bearer: "other", body, method: "POST" }))).resolves.toBe(403);
        await expect(statusOf(send(target, "/revoked?name=ci&createdAt=5", { bearer: "other" }))).resolves.toBe(403);

        const unconfigured = new AdminRevocationDO(store.state, {});

        await expect(statusOf(send(unconfigured, "/revoke", { bearer: "", body, method: "POST" }))).resolves.toBe(403);
        expect(store.entries.size).toBe(0);
    });

    it("refuses a malformed revocation or lookup", async () => {
        expect.assertions(4);

        const target = new AdminRevocationDO(createStore().state, { LUNORA_ADMIN_TOKEN: ROOT });

        await expect(statusOf(send(target, "/revoke", { bearer: ROOT, body: JSON.stringify({ createdAt: "5", name: "ci" }), method: "POST" }))).resolves.toBe(
            400,
        );
        await expect(statusOf(send(target, "/revoke", { bearer: ROOT, body: "not json", method: "POST" }))).resolves.toBe(400);
        await expect(statusOf(send(target, "/revoked?name=ci", { bearer: ROOT }))).resolves.toBe(400);
        await expect(statusOf(send(target, "/latest", { bearer: ROOT }))).resolves.toBe(400);
    });
});
