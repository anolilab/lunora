import type { Dispatch, SetStateAction } from "react";
import { useEffect, useState } from "react";

/**
 * Best-effort `localStorage` handle, guarded so a missing or throwing storage
 * (SSR, sandboxed iframe, privacy mode) degrades to in-memory-only rather than
 * crashing the render. Mirrors {@link ./token-storage}'s `sessionStorage` guard.
 */
const store = (): Storage | undefined => {
    try {
        return (globalThis as { localStorage?: Storage }).localStorage;
    } catch {
        // Accessing localStorage can throw in sandboxed iframes / privacy mode.
        return undefined;
    }
};

/** Read a JSON array from `localStorage`; returns `[]` on any miss, non-array, or parse/access throw. */
export const loadJsonArray = <T>(key: string): T[] => {
    try {
        const raw = store()?.getItem(key) ?? undefined;
        const parsed = raw === undefined ? [] : (JSON.parse(raw) as unknown);

        return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
        return [];
    }
};

/** Persist `value` as JSON; silently no-ops when storage is unavailable or a write throws (quota / privacy mode). */
export const saveJson = (key: string, value: unknown): void => {
    const storage = store();

    if (storage === undefined) {
        return;
    }

    try {
        storage.setItem(key, JSON.stringify(value));
    } catch {
        /* quota / disabled storage — the value simply isn't persisted */
    }
};

/**
 * A {@link useState} whose array value is mirrored to `localStorage` under `key`:
 * lazily seeded from storage on mount, then written back (best-effort, guarded)
 * whenever it changes. Collapses the hand-rolled load-initializer + persist-effect
 * triad the SQL editor and dashboards panels would otherwise each duplicate — and,
 * unlike those, never lets a `setItem` quota/privacy throw escape into the render.
 */
export const usePersistedList = <T>(key: string): [T[], Dispatch<SetStateAction<T[]>>] => {
    const [value, setValue] = useState<T[]>(() => loadJsonArray<T>(key));

    useEffect(() => {
        saveJson(key, value);
    }, [key, value]);

    return [value, setValue];
};

/**
 * A best-effort unique id for a browser-persisted record: `crypto.randomUUID`
 * when available, else a `prefix`-tagged high-resolution timestamp.
 */
export const newId = (prefix: string): string =>
    (globalThis.crypto as { randomUUID?: () => string } | undefined)?.randomUUID?.() ?? `${prefix}-${globalThis.performance.now().toString(36)}`;
