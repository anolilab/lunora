import { describe, expect, it } from "vitest";

import { AdminRevocationDO } from "../src/admin-revocation-do";

const ROOT = "root-admin-token";

const createStore = (): { entries: Map<string, unknown>; state: ConstructorParameters<typeof AdminRevocationDO>[0] } => {
    const entries = new Map<string, unknown>();

    return {
        entries,
        state: {
            storage: {
                list: async <T>({ prefix }: { prefix: string }) => new Map([...entries].filter(([key]) => key.startsWith(prefix)) as [string, T][]),
                put: async (key, value) => {
                    entries.set(key, value);
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

describe(AdminRevocationDO, () => {
    it("records a revocation by name and createdAt, and lists it for that name only", async () => {
        expect.assertions(3);

        const store = createStore();
        const target = new AdminRevocationDO(store.state, { LUNORA_ADMIN_TOKEN: ROOT });

        const revoked = await send(target, "/revoke", { bearer: ROOT, body: JSON.stringify({ createdAt: 5, name: "ci" }), method: "POST" });

        expect(revoked.status).toBe(200);
        await expect(jsonOf(send(target, "/list?name=ci", { bearer: ROOT }))).resolves.toStrictEqual({ revoked: [5] });
        await expect(jsonOf(send(target, "/list?name=ci2", { bearer: ROOT }))).resolves.toStrictEqual({ revoked: [] });
    });

    it("answers only the root token, and nothing at all without one configured", async () => {
        expect.assertions(5);

        const store = createStore();
        const target = new AdminRevocationDO(store.state, { LUNORA_ADMIN_TOKEN: ROOT });
        const body = JSON.stringify({ createdAt: 5, name: "ci" });

        await expect(statusOf(send(target, "/revoke", { body, method: "POST" }))).resolves.toBe(403);
        await expect(statusOf(send(target, "/revoke", { bearer: "other", body, method: "POST" }))).resolves.toBe(403);
        await expect(statusOf(send(target, "/list?name=ci", { bearer: "other" }))).resolves.toBe(403);

        const unconfigured = new AdminRevocationDO(store.state, {});

        await expect(statusOf(send(unconfigured, "/revoke", { bearer: "", body, method: "POST" }))).resolves.toBe(403);
        expect(store.entries.size).toBe(0);
    });

    it("refuses a malformed revocation", async () => {
        expect.assertions(2);

        const target = new AdminRevocationDO(createStore().state, { LUNORA_ADMIN_TOKEN: ROOT });

        await expect(statusOf(send(target, "/revoke", { bearer: ROOT, body: JSON.stringify({ createdAt: "5", name: "ci" }), method: "POST" }))).resolves.toBe(
            400,
        );
        await expect(statusOf(send(target, "/revoke", { bearer: ROOT, body: "not json", method: "POST" }))).resolves.toBe(400);
    });
});
