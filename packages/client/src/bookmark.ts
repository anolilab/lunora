import type { BookmarkStorage } from "./types.js";

/** Default in-memory bookmark store. Survives the lifetime of the client. */
const createInMemoryBookmarkStorage = (): BookmarkStorage => {
    // The bookmark value is part of the public `BookmarkStorage` contract
    // (`get: () => string | null`) and is sent on the wire as the
    // `x-d1-bookmark` header — keep `null` as the absent-value sentinel.
    // eslint-disable-next-line unicorn/no-null -- public wire/contract sentinel
    let value: string | null = null;

    return {
        get: () => value,
        set: (next) => {
            value = next;
        },
    };
};

export default createInMemoryBookmarkStorage;
