import { afterEach, describe, expect, it, vi } from "vitest";

import { signRequeue, verifyRequeue } from "../src/requeue-mac";

// The key cache is module-level and outlives each test, so every test uses its own secret.
describe("requeue MAC key cache", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("imports the key once per secret across signs and verifies", async () => {
        expect.assertions(2);

        const importKey = vi.spyOn(crypto.subtle, "importKey");
        const secret = "requeue-cache-once";

        const ids = ["msg-0", "msg-1", "msg-2", "msg-3", "msg-4"];
        const macs = await Promise.all(ids.map(async (id) => signRequeue(secret, "scheduler", id, "{}")));

        await Promise.all(ids.map(async (id, index) => verifyRequeue(secret, "scheduler", id, "{}", macs[index])));

        expect(importKey).toHaveBeenCalledTimes(1);
        await expect(verifyRequeue(secret, "scheduler", "msg-0", "{}", await signRequeue(secret, "scheduler", "msg-0", "{}"))).resolves.toBe(true);
    });

    it("imports a new key for a new secret and rejects a MAC made under the old one", async () => {
        expect.assertions(3);

        const importKey = vi.spyOn(crypto.subtle, "importKey");
        const mac = await signRequeue("requeue-rotate-old", "scheduler", "msg-1", "{}");

        await expect(verifyRequeue("requeue-rotate-new", "scheduler", "msg-1", "{}", mac)).resolves.toBe(false);
        await expect(verifyRequeue("requeue-rotate-old", "scheduler", "msg-1", "{}", mac)).resolves.toBe(true);
        expect(importKey).toHaveBeenCalledTimes(2);
    });
});
