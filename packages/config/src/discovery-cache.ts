/**
 * An invocation-scoped memo for project discovery. A CLI command creates one,
 * threads it through every `discover*` / `inferLunoraBindings` call it makes,
 * and clears it after anything rewrites the sources discovery reads (codegen).
 * Deliberately not module-level: tests and long-lived processes never see a
 * stale result.
 */
interface DiscoveryCache {
    /** Drop every memoised result. */
    clear: () => void;
    /** Return the result memoised under `key`, computing it on first use. */
    memo: <T>(key: string, compute: () => T) => T;
}

const createDiscoveryCache = (): DiscoveryCache => {
    const entries = new Map<string, unknown>();

    return {
        clear: () => {
            entries.clear();
        },
        memo: <T>(key: string, compute: () => T): T => {
            if (entries.has(key)) {
                return entries.get(key) as T;
            }

            const value = compute();

            entries.set(key, value);

            return value;
        },
    };
};

export type { DiscoveryCache };
export { createDiscoveryCache };
