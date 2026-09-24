import { describe, expect, it } from "vitest";

import { assertSecureRandom } from "../src/internals";

const NO_WEBCRYPTO = /bindMutators: this runtime has no WebCrypto/u;
const NAMES_POLYFILL = /expo-crypto/u;
const NO_WEBCRYPTO_ANY = /no WebCrypto/u;

/**
 * Hermes (React Native / Expo) ships neither `crypto.randomUUID` nor
 * `crypto.getRandomValues`, so `@tanstack/db`'s `safeRandomUUID` throws on the
 * first optimistic write — from inside a transaction, where it surfaces as an
 * unhandled rejection and the row just never appears. The guard turns that into
 * a loud setup-time failure that names the polyfill.
 */
describe(assertSecureRandom, () => {
    // Swaps the WEB Crypto global to model a runtime that lacks it, then restores it.
    const withCrypto = async (value: unknown, run: () => void): Promise<void> => {
        const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");

        Object.defineProperty(globalThis, "crypto", { configurable: true, value, writable: true });

        try {
            run();
        } finally {
            if (original) {
                Object.defineProperty(globalThis, "crypto", original);
            } else {
                // eslint-disable-next-line n/no-unsupported-features/node-builtins -- the WEB Crypto global; the rule matches Node's unrelated experimental global of the same name.
                delete (globalThis as { crypto?: unknown }).crypto;
            }
        }

        await Promise.resolve();
    };

    it("passes on a runtime with `crypto.randomUUID`", async () => {
        expect.assertions(1);

        await withCrypto({ randomUUID: () => "id" }, () => {
            expect(() => {
                assertSecureRandom("defineCollections");
            }).not.toThrow();
        });
    });

    it("passes on a runtime with only `crypto.getRandomValues` (a non-secure origin)", async () => {
        expect.assertions(1);

        await withCrypto({ getRandomValues: (array: Uint8Array) => array }, () => {
            expect(() => {
                assertSecureRandom("defineCollections");
            }).not.toThrow();
        });
    });

    it("names the polyfill when the runtime has neither (Hermes)", async () => {
        expect.assertions(2);

        // Hermes exposes a `crypto` binding that is missing both members — the
        // shape a bare `globalThis.crypto === undefined` check would wave through.
        await withCrypto({}, () => {
            expect(() => {
                assertSecureRandom("bindMutators");
            }).toThrow(NO_WEBCRYPTO);

            expect(() => {
                assertSecureRandom("bindMutators");
            }).toThrow(NAMES_POLYFILL);
        });
    });

    it("throws when `crypto` is absent entirely", async () => {
        expect.assertions(1);

        await withCrypto(undefined, () => {
            expect(() => {
                assertSecureRandom("defineCollections");
            }).toThrow(NO_WEBCRYPTO_ANY);
        });
    });
});
