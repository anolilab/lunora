import { describe, expect, it, vi } from "vitest";

import { createSecrets } from "../src/create-secrets";

describe("createSecrets", () => {
    it("reads a declared Secrets Store binding by name", async () => {
        expect.assertions(2);

        const get = vi.fn<() => Promise<string>>(async () => "sk_live_123");
        const secrets = createSecrets({ STRIPE_KEY: { get } });

        await expect(secrets.get("STRIPE_KEY")).resolves.toBe("sk_live_123");
        expect(get).toHaveBeenCalledTimes(1);
    });

    it("throws a directed error for an absent binding", async () => {
        expect.assertions(1);

        const secrets = createSecrets({});

        await expect(secrets.get("MISSING")).rejects.toThrow(/no Secrets Store binding named "MISSING".*secrets_store_secrets/s);
    });

    it("throws for a binding that is not a Secrets Store secret", async () => {
        expect.assertions(1);

        const secrets = createSecrets({ NOT_A_SECRET: "plain-string" });

        await expect(secrets.get("NOT_A_SECRET")).rejects.toThrow(/no Secrets Store binding named/);
    });

    it("throws (does not silently read) when the named binding is a KV namespace — `.get` collides", async () => {
        expect.assertions(2);

        // A KV namespace is `{ get, put, list, delete, getWithMetadata }`. Its
        // `.get` must NOT be mistaken for a Secrets Store secret, or `ctx.secrets.get`
        // would silently return a KV read instead of the directed error.
        const kvLike = {
            delete: vi.fn<() => unknown>(),
            get: vi.fn<() => Promise<string>>(async () => "kv-value"),
            getWithMetadata: vi.fn<() => unknown>(),
            list: vi.fn<() => unknown>(),
            put: vi.fn<() => unknown>(),
        };
        const secrets = createSecrets({ SESSIONS: kvLike });

        await expect(secrets.get("SESSIONS")).rejects.toThrow(/no Secrets Store binding named "SESSIONS"/);
        expect(kvLike.get).not.toHaveBeenCalled();
    });

    it("throws when the named binding is a Durable Object namespace — `.get(id)` collides", async () => {
        expect.assertions(2);

        const doLike = {
            get: vi.fn<() => unknown>(),
            getByName: vi.fn<() => unknown>(),
            idFromName: vi.fn<() => unknown>(),
            newUniqueId: vi.fn<() => unknown>(),
        };
        const secrets = createSecrets({ SHARD: doLike });

        await expect(secrets.get("SHARD")).rejects.toThrow(/no Secrets Store binding named "SHARD"/);
        expect(doLike.get).not.toHaveBeenCalled();
    });
});
