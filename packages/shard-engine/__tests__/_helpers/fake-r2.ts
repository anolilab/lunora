import type { R2BucketLike } from "@lunora/platform";

/**
 * Code-unit ordering, which is what R2 sorts keys by.
 *
 * Deliberately NOT `localeCompare`: a locale collator ignores case and folds
 * punctuation, so it would reorder keys the real bucket keeps adjacent — and a
 * double that orders differently from the thing it doubles is worse than no
 * double at all.
 */
const byKey = (a: string, b: string): number => {
    if (a === b) {
        return 0;
    }

    return a < b ? -1 : 1;
};

/**
 * In-memory `R2BucketLike` for the changelog-archive tests.
 *
 * `list` honours `prefix` and `startAfter` the way R2 does — keys in ascending
 * code-unit order, `startAfter` EXCLUSIVE — because that ordering is the whole
 * indexing scheme the archive's segment keys are built on. A double that
 * returned insertion order instead would pass every test while the real bucket
 * skipped segments.
 */
const createFakeR2Bucket = (): R2BucketLike & { keys: () => string[] } => {
    const objects = new Map<string, string>();

    return {
        delete: async (key: string) => {
            objects.delete(key);
        },
        get: async (key: string) => {
            const body = objects.get(key);

            return body === undefined ? null : ({ text: async () => body } as never);
        },
        keys: () => [...objects.keys()].toSorted(byKey),
        list: async (options?: { limit?: number; prefix?: string; startAfter?: string }) => {
            const matched = [...objects.keys()]
                .toSorted(byKey)
                .filter((key) => key.startsWith(options?.prefix ?? ""))
                .filter((key) => options?.startAfter === undefined || key > options.startAfter);

            return { objects: matched.slice(0, options?.limit ?? 1000).map((key) => ({ key }) as never) };
        },
        put: async (key: string, body: unknown) => {
            objects.set(key, String(body));

            return {} as never;
        },
    };
};

// eslint-disable-next-line import/prefer-default-export -- named export by repo convention (no default exports)
export { createFakeR2Bucket };
