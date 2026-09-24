/**
 * Runtime stand-in for `@lunora/storage`, which this package does not depend on.
 * Records what an item stores so a test can assert on the bytes rather than on a
 * real R2 round-trip.
 *
 * Wired in by `packages/cli/vitest.config.ts`'s `resolve.alias`.
 */
interface StoredObject {
    body: ArrayBuffer;
    contentType?: string;
    key: string;
}

/** Everything `store()` has been handed since the last {@link resetStoredObjects}. */
const storedObjects: StoredObject[] = [];

const resetStoredObjects = (): void => {
    storedObjects.length = 0;
};

const createStorage = (): {
    store: (key: string, body: ArrayBuffer, options?: { contentType?: string }) => Promise<{ key: string }>;
} => {
    return {
        store: async (key, body, options) => {
            storedObjects.push({ body, contentType: options?.contentType, key });

            return { key };
        },
    };
};

export { createStorage, resetStoredObjects, storedObjects };
