/**
 * Recently-used shard keys, persisted in `sessionStorage` so every shard-scoped
 * panel can offer them as autocomplete. Cloudflare Durable Objects aren't
 * externally enumerable, so the dashboard can't discover shards server-side;
 * this remembers the ones the operator actually visited instead. Guarded so a
 * missing/throwing storage (SSR, privacy mode) degrades to "no history".
 */
const STORAGE_KEY = "cirrus-dashboard-recent-shards";

/** Cap the list so it stays a short, useful menu rather than an unbounded log. */
const MAX_RECENTS = 10;

const store = (): Storage | null => {
    try {
        return (globalThis as { sessionStorage?: Storage }).sessionStorage ?? null;
    } catch {
        return null;
    }
};

/** Recent shard keys, most-recently-used first. Empty when storage is unavailable. */
export const loadRecentShards = (): string[] => {
    try {
        const raw = store()?.getItem(STORAGE_KEY);

        if (raw === null || raw === undefined) {
            return [];
        }

        const parsed = JSON.parse(raw) as unknown;

        return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
    } catch {
        return [];
    }
};

/**
 * Record `shardKey` as recently used (moved to the front, de-duplicated, capped).
 * Empty/whitespace keys (the root shard) are ignored — there's nothing to recall.
 * Returns the updated list so a caller can update state without re-reading.
 */
export const recordShard = (shardKey: string): string[] => {
    const trimmed = shardKey.trim();

    if (trimmed === "") {
        return loadRecentShards();
    }

    const next = [trimmed, ...loadRecentShards().filter((entry) => entry !== trimmed)].slice(0, MAX_RECENTS);
    const storage = store();

    if (storage !== null) {
        try {
            storage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch {
            /* quota / disabled storage — history simply isn't persisted */
        }
    }

    return next;
};
