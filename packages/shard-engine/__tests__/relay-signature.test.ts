import { afterEach, describe, expect, it, vi } from "vitest";

import { signSiblingBody, verifySiblingBody } from "../src/sibling-channel";

// The key cache is module-level and outlives each test, so every test uses its own secret.
describe("relay signature key cache", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("imports the key once per secret across signed and verified frames", async () => {
        expect.assertions(2);

        const importKey = vi.spyOn(crypto.subtle, "importKey");
        const env = { LUNORA_RELAY_SECRET: "relay-cache-once" };
        const frames = ["a", "b", "c", "d", "e"];
        const signatures = await Promise.all(frames.map(async (frame) => signSiblingBody(env.LUNORA_RELAY_SECRET, frame)));
        const verified = await Promise.all(frames.map(async (frame, index) => verifySiblingBody(env, signatures[index] ?? null, frame)));

        expect(importKey).toHaveBeenCalledTimes(1);
        expect(verified.every(Boolean)).toBe(true);
    });

    it("imports a new key for a new secret and rejects a frame signed under the old one", async () => {
        expect.assertions(3);

        const importKey = vi.spyOn(crypto.subtle, "importKey");
        const signature = await signSiblingBody("relay-rotate-old", "frame");

        await expect(verifySiblingBody({ LUNORA_RELAY_SECRET: "relay-rotate-new" }, signature, "frame")).resolves.toBe(false);
        await expect(verifySiblingBody({ LUNORA_RELAY_SECRET: "relay-rotate-old" }, signature, "frame")).resolves.toBe(true);
        expect(importKey).toHaveBeenCalledTimes(2);
    });
});
