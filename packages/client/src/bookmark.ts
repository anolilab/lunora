import type { BookmarkStorage } from "./types.js";

/** Default in-memory bookmark store. Survives the lifetime of the client. */
export const createInMemoryBookmarkStorage = (): BookmarkStorage => {
    let value: string | null = null;

    return {
        get: () => value,
        set: (next) => {
            value = next;
        },
    };
};
