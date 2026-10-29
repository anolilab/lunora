import { describe, expect, it } from "vitest";

import type { SecretValueStore } from "../src/index";
import { encryptingSecretValueHost, SecretValueKeyError } from "../src/index";

/** A base64 string of exactly 32 bytes, the AES-256 key the host expects. */
const KEY = btoa(String.fromCodePoint(...new Uint8Array(32).fill(7)));

/** An in-memory raw store: `put` seals under a fresh ref, `take` opens the stored bytes. */
const memoryStore = (): SecretValueStore => {
    const records = new Map<string, string>();
    let next = 0;

    return {
        discard: async (ref) => records.delete(ref),
        put: async (seal) => {
            next += 1;

            const ref = `ref-${String(next)}`;

            records.set(ref, await seal(ref));

            return ref;
        },
        take: async (ref, _options, open) => {
            const stored = records.get(ref);

            return stored === undefined ? undefined : open(stored);
        },
    };
};

describe("encryptingSecretValueHost key loading", () => {
    it("loads the key on the next call after a load found it missing, instead of replaying that failure", async () => {
        expect.assertions(2);

        const configured: { key: string | undefined } = { key: undefined };
        const host = encryptingSecretValueHost(memoryStore(), {
            get key() {
                return configured.key;
            },
        });

        await expect(host.put("a value", { scope: "thread-1", ttlMs: 60_000 })).rejects.toBeInstanceOf(SecretValueKeyError);

        configured.key = KEY;

        await expect(host.put("a value", { scope: "thread-1", ttlMs: 60_000 })).resolves.toEqual(expect.any(String));
    });
});
