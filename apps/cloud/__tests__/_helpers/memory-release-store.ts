import type { ReleaseStore } from "../../src/deploy/release-store";
import { createReleaseStore } from "../../src/deploy/release-store";

/** The real {@link createReleaseStore} over an in-memory bucket; `objects` is the bucket, keyed by R2 key. */
const memoryReleaseStore = (): { objects: Map<string, string>; store: ReleaseStore } => {
    const objects = new Map<string, string>();
    const store = createReleaseStore({
        delete: (key) => {
            objects.delete(key);

            return Promise.resolve();
        },
        get: (key) => {
            const value = objects.get(key);

            return Promise.resolve(value === undefined ? null : { text: () => Promise.resolve(value) });
        },
        put: (key, value) => {
            objects.set(key, value);

            return Promise.resolve();
        },
    });

    return { objects, store };
};

export default memoryReleaseStore;
