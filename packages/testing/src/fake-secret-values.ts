import { randomUUID } from "node:crypto";

import type { SecretValueHost } from "@lunora/platform";
import { assertSecretValueSize, clampSecretValueTtl } from "@lunora/platform";

/** A {@link SecretValueHost} whose clock the test moves forward by hand. */
interface FakeSecretValues extends SecretValueHost {
    /** Move the store's clock forward, so a value put earlier can expire. */
    advanceClock: (ms: number) => void;
}

interface StoredSecret {
    claimant?: string;
    expiresAt: number;
    scope: string;
    value: string;
}

/**
 * In-memory {@link SecretValueHost} for harness suites. Follows the contract in
 * `@lunora/platform` (unguessable refs, scope, one claimant, expiry refuses
 * reads) with a clock that starts at zero, so a test controls every expiry
 * through {@link FakeSecretValues.advanceClock}.
 */
const createFakeSecretValues = (): FakeSecretValues => {
    const records = new Map<string, StoredSecret>();
    let clock = 0;

    return {
        advanceClock: (ms: number): void => {
            clock += ms;
        },
        discard: (ref) => Promise.resolve(records.delete(ref)),
        put: (value, options) => {
            const ref = `secret-${randomUUID()}`;

            // Settled as a rejection, not a synchronous throw, like the host's async put.
            return Promise.resolve().then(() => {
                assertSecretValueSize(value);
                records.set(ref, { expiresAt: clock + clampSecretValueTtl(options.ttlMs), scope: options.scope, value });

                return ref;
            });
        },
        take: (ref, options) => {
            const stored = records.get(ref);

            if (stored === undefined || stored.expiresAt <= clock || stored.scope !== options.scope) {
                return Promise.resolve(undefined);
            }

            stored.claimant ??= options.claimant;

            return Promise.resolve(stored.claimant === options.claimant ? stored.value : undefined);
        },
    };
};

export type { FakeSecretValues };
export { createFakeSecretValues };
