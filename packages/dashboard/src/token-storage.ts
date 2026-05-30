/**
 * Persist the admin token in `sessionStorage` so a page reload doesn't force the
 * operator to re-paste it. `sessionStorage` (not `localStorage`) keeps it to the
 * tab's lifetime — a deliberate tradeoff: convenience without leaving a
 * long-lived admin credential on disk. All access is guarded so a missing or
 * throwing storage (SSR, privacy mode) degrades to in-memory-only.
 */
const STORAGE_KEY = "cirrus-dashboard-admin-token";

const store = (): Storage | null => {
    try {
        return (globalThis as { sessionStorage?: Storage }).sessionStorage ?? null;
    } catch {
        // Accessing sessionStorage can throw in sandboxed iframes / privacy mode.
        return null;
    }
};

/** Read the persisted admin token, or `""` when none is stored / storage is unavailable. */
export const loadToken = (): string => {
    try {
        return store()?.getItem(STORAGE_KEY) ?? "";
    } catch {
        return "";
    }
};

/** Persist (non-empty) or clear (empty) the admin token; silently no-ops without storage. */
export const saveToken = (token: string): void => {
    const storage = store();

    if (storage === null) {
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
