import type { SecretValueHost } from "@lunora/platform";
import { createReferenceHost } from "@lunora/platform/conformance";
import { describe, expect, it } from "vitest";

import { createFakeSecretValues } from "../src/fake-secret-values";

const TTL = 60_000;

interface Subject {
    advance: (ms: number) => void;
    store: SecretValueHost;
}

/**
 * The same contract assertions run against the fake and against the platform's
 * reference host, so the fake cannot quietly drift from what a real host does.
 */
const subjects: [string, () => Subject][] = [
    [
        "createFakeSecretValues",
        () => {
            const fake = createFakeSecretValues();

            return { advance: fake.advanceClock, store: fake };
        },
    ],
    [
        "platform reference host",
        () => {
            const host = createReferenceHost();

            if (host.advanceClock === undefined || host.secretValues === undefined) {
                throw new Error("the reference host must expose its secret store and clock");
            }

            return { advance: host.advanceClock, store: host.secretValues };
        },
    ],
];

describe.each(subjects)("secret value contract: %s", (_name, make) => {
    it("round-trips a value to its scope and claimant, and refuses anyone else", async () => {
        expect.assertions(4);

        const { store } = make();
        const ref = await store.put("sk-1", { scope: "t-1", ttlMs: TTL });

        await expect(store.take(ref, { claimant: "step-a", scope: "t-1" })).resolves.toBe("sk-1");
        await expect(store.take(ref, { claimant: "step-a", scope: "t-1" })).resolves.toBe("sk-1");
        await expect(store.take(ref, { claimant: "step-b", scope: "t-1" })).resolves.toBeUndefined();
        await expect(store.take(ref, { claimant: "step-c", scope: "t-2" })).resolves.toBeUndefined();
    });

    it("does not let a wrong scope consume the value", async () => {
        expect.assertions(2);

        const { store } = make();
        const ref = await store.put("sk-2", { scope: "t-1", ttlMs: TTL });

        await expect(store.take(ref, { claimant: "step-a", scope: "t-2" })).resolves.toBeUndefined();
        await expect(store.take(ref, { claimant: "step-a", scope: "t-1" })).resolves.toBe("sk-2");
    });

    it("refuses every read once the ttl has elapsed", async () => {
        expect.assertions(1);

        const { advance, store } = make();
        const ref = await store.put("sk-3", { scope: "t-1", ttlMs: TTL });

        advance(TTL);

        // Physical removal is best-effort; the read refusal is the guarantee.
        await expect(store.take(ref, { claimant: "step-a", scope: "t-1" })).resolves.toBeUndefined();
    });

    it("discards idempotently and mints distinct refs", async () => {
        expect.assertions(4);

        const { store } = make();
        const first = await store.put("sk-4", { scope: "t-1", ttlMs: TTL });
        const second = await store.put("sk-4", { scope: "t-1", ttlMs: TTL });

        expect(first).not.toBe(second);
        await expect(store.discard(first)).resolves.toBe(true);
        await expect(store.discard(first)).resolves.toBe(false);
        await expect(store.take(first, { claimant: "step-a", scope: "t-1" })).resolves.toBeUndefined();
    });

    it("rejects a value over the byte limit", async () => {
        expect.assertions(1);

        const { store } = make();

        await expect(store.put("x".repeat(9000), { scope: "t-1", ttlMs: TTL })).rejects.toMatchObject({ code: "SECRET_VALUE_TOO_LARGE" });
    });
});
