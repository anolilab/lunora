import type { Dispatch, SetStateAction } from "react";
import { useEffect, useRef, useState } from "react";

/** Which Web Storage area a helper targets: `localStorage` (persists across sessions) or `sessionStorage` (tab-lifetime). */
export type StorageKind = "local" | "session";

/**
 * Best-effort Web Storage handle for `kind`, guarded so a missing or throwing
 * storage (SSR, sandboxed iframe, privacy mode) degrades to in-memory-only rather
 * than crashing the render. The single guarded accessor for both storage areas, so
 * every persisted-store helper (`saved-queries`, `shard-history`, `token-storage`)
 * shares one place to fix if e.g. a poisoned value ever needs handling.
 */
export const storageOf = (kind: StorageKind = "local"): Storage | undefined => {
    try {
        return kind === "local" ? (globalThis as { localStorage?: Storage }).localStorage : (globalThis as { sessionStorage?: Storage }).sessionStorage;
    } catch {
        // Accessing storage can throw in sandboxed iframes / privacy mode.
        return undefined;
    }
};

/** Read a JSON array from the given storage area; returns `[]` on any miss, non-array, or parse/access throw. */
export const loadJsonArray = function <T>(key: string, kind: StorageKind = "local"): T[] {
    try {
        const raw = storageOf(kind)?.getItem(key) ?? undefined;
        const parsed = raw === undefined ? [] : (JSON.parse(raw) as unknown);

        return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
        return [];
    }
};

/** Persist `value` as JSON; silently no-ops when storage is unavailable or a write throws (quota / privacy mode). */
export const saveJson = (key: string, value: unknown, kind: StorageKind = "local"): void => {
    const storage = storageOf(kind);

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
export const usePersistedList = function <T>(key: string): [T[], Dispatch<SetStateAction<T[]>>] {
    const [value, setValue] = useState<T[]>(() => loadJsonArray<T>(key));
    // The `key` the current in-memory `value` was loaded/persisted under. When `key`
    // changes across renders we must NOT write the old key's value under the new key
    // (that would clobber whatever was persisted there) — instead reload from the new
    // key so the state reflects it, and let the next render persist normally.
    const keyRef = useRef(key);

    useEffect(() => {
        if (keyRef.current !== key) {
            keyRef.current = key;
            // react-doctor-disable-next-line react-doctor/no-chain-state-updates -- the write and the persisted-value update are deliberately separate: one is React state, the other is localStorage, and they cannot be one update
            setValue(loadJsonArray<T>(key));

            return;
        }

        saveJson(key, value);
    }, [key, value]);

    return [value, setValue];
};

/**
 * A single persisted scalar on top of {@link usePersistedList}: the value is
 * stored as a one-element array so it reuses the same guarded load/persist path.
 * `fallback` is returned whenever storage holds nothing. Supports functional
 * updaters like {@link useState}. The canonical home for "one persisted value"
 * so panels stop hand-rolling the one-element-list wrapper.
 */
export const usePersistedValue = function <T>(key: string, fallback: T): [T, Dispatch<SetStateAction<T>>] {
    const [list, setList] = usePersistedList<T>(key);

    const setValue: Dispatch<SetStateAction<T>> = (action) => {
        setList((current) => {
            const previous = current[0] ?? fallback;

            return [typeof action === "function" ? (action as (previous: T) => T)(previous) : action];
        });
    };

    return [list[0] ?? fallback, setValue];
};

/**
 * A best-effort unique id for a browser-persisted record: `crypto.randomUUID`
 * when available, else a `prefix`-tagged high-resolution timestamp.
 */
export const newId = (prefix: string): string =>
    (globalThis.crypto as { randomUUID?: () => string } | undefined)?.randomUUID?.() ?? `${prefix}-${globalThis.performance.now().toString(36)}`;
