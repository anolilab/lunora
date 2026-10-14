import { storageOf } from "./browser-storage";

/**
 * Persist the admin token in `sessionStorage` so a page reload doesn't force the
 * operator to re-paste it. `sessionStorage` (not `localStorage`) keeps it to the
 * tab's lifetime — a deliberate tradeoff: convenience without leaving a
 * long-lived admin credential on disk. Access goes through {@link ./browser-storage}'s
 * shared guard so a missing or throwing storage (SSR, privacy mode) degrades to
 * in-memory-only. Not JSON (it's a raw string with a remove-on-empty semantic), so
 * it uses the guarded `storageOf` accessor rather than `loadJsonArray`/`saveJson`.
 */
const STORAGE_KEY = "lunora-studio-admin-token";

/** Read the persisted admin token, or `""` when none is stored / storage is unavailable. */
export const loadToken = (): string => {
    try {
        return storageOf("session")?.getItem(STORAGE_KEY) ?? "";
    } catch {
        return "";
    }
};

/** Persist (non-empty) or clear (empty) the admin token; silently no-ops without storage. */
export const saveToken = (token: string): void => {
    const storage = storageOf("session");

    if (storage === undefined) {
        return;
    }

    try {
        if (token === "") {
            storage.removeItem(STORAGE_KEY);
        } else {
            storage.setItem(STORAGE_KEY, token);
        }
    } catch {
        /* quota / disabled storage — token simply isn't persisted */
    }
};
