/**
 * `AdminRevocationDO` in real workerd: the root-token gate, a revoke followed by a lookup that
 * survives the object being evicted from memory, and the (name, createdAt) keying that lets a token
 * created later under a revoked name through while a restored row stays refused.
 */
import { env, evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const ROOT = "workerd-test-admin-token";

const call = async (instance: string, path: string, init: RequestInit & { bearer?: string } = {}): Promise<Response> =>
    env.ADMIN_REVOCATIONS.getByName(instance).fetch(
        new Request(`https://revocations.internal${path}`, {
            ...init,
            headers: { ...(init.bearer === undefined ? {} : { authorization: `Bearer ${init.bearer}` }), "content-type": "application/json" },
        }),
    );

const revoke = async (instance: string, name: string, createdAt: number): Promise<Response> =>
    call(instance, "/revoke", { bearer: ROOT, body: JSON.stringify({ createdAt, name }), method: "POST" });

/**
 * The status of a response, with its body drained: `evictDurableObject` waits for in-flight requests,
 * and an unread `Response` body counts as in-flight forever.
 */
const statusOf = async (pending: Promise<Response>): Promise<number> => {
    const response = await pending;

    await response.text();

    return response.status;
};

const revokedFor = async (instance: string, name: string): Promise<unknown> => {
    const response = await call(instance, `/list?name=${name}`, { bearer: ROOT });

    return response.json();
};

describe("adminRevocationDO (workerd)", () => {
    it("answers only the root admin token", async () => {
        expect.assertions(4);

        const body = JSON.stringify({ createdAt: 1, name: "ci" });

        await expect(statusOf(call("gate", "/revoke", { body, method: "POST" }))).resolves.toBe(403);
        await expect(statusOf(call("gate", "/revoke", { bearer: "not-the-root", body, method: "POST" }))).resolves.toBe(403);
        await expect(statusOf(call("gate", "/list?name=ci", { bearer: "not-the-root" }))).resolves.toBe(403);
        // Nothing the refused calls sent was recorded.
        await expect(revokedFor("gate", "ci")).resolves.toStrictEqual({ revoked: [] });
    });

    it("lists a revocation after it is made, including once the object has been evicted", async () => {
        expect.assertions(3);

        await expect(statusOf(revoke("durable", "ci", 1234))).resolves.toBe(200);
        await expect(revokedFor("durable", "ci")).resolves.toStrictEqual({ revoked: [1234] });

        await evictDurableObject(env.ADMIN_REVOCATIONS.getByName("durable"));

        await expect(revokedFor("durable", "ci")).resolves.toStrictEqual({ revoked: [1234] });
    });

    it("keys a revocation by name and createdAt", async () => {
        expect.assertions(2);

        await revoke("keyed", "ci", 100);
        await revoke("keyed", "ci", 200);
        await revoke("keyed", "other", 300);

        // Both issued credentials called "ci" are refused; a third, created later, is not listed.
        await expect(revokedFor("keyed", "ci")).resolves.toStrictEqual({ revoked: [100, 200] });
        await expect(revokedFor("keyed", "other")).resolves.toStrictEqual({ revoked: [300] });
    });
});
