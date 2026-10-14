import { loadJsonArray, saveJson } from "./browser-storage";

/**
 * Recently-used shard keys, persisted in `sessionStorage` so every shard-scoped
 * panel can offer them as autocomplete. Cloudflare Durable Objects aren't
 * externally enumerable, so the studio can't discover shards server-side;
 * this remembers the ones the operator actually visited instead. The guarded
 * load/persist path is shared via {@link ./browser-storage} so a missing/throwing
 * storage (SSR, privacy mode) degrades to "no history" in one place.
 */
const STORAGE_KEY = "lunora-studio-recent-shards";

/** Cap the list so it stays a short, useful menu rather than an unbounded log. */
const MAX_RECENTS = 10;

/** Recent shard keys, most-recently-used first. Empty when storage is unavailable. */
export const loadRecentShards = (): string[] => loadJsonArray<unknown>(STORAGE_KEY, "session").filter((entry): entry is string => typeof entry === "string");

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

    saveJson(STORAGE_KEY, next, "session");

    return next;
};
