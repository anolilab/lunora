import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { newId, usePersistedList } from "../../lib/browser-storage";

/**
 * One open editor tab. Only the durable parts — the draft `sql`, the `name`
 * shown on the tab, and the `activeId` of the saved query it mirrors (if any) —
 * are persisted; the query result is ephemeral and lives in the panel's state,
 * re-run on demand after a reload.
 */
interface SqlTab {
    /** Saved-query id this tab edits, or `null` for an unsaved draft. */
    readonly activeId: null | string;
    readonly id: string;
    /** Operator-set custom title; blank means "derive the label from the draft". */
    readonly name: string;
    readonly sql: string;
}

const TABS_KEY = "cirrus-studio-sql-tabs";
const ACTIVE_KEY = "cirrus-studio-sql-active-tab";

/** Cap open tabs so the strip stays usable and storage bounded. */
const MAX_TABS = 12;

/**
 * A fresh, empty draft tab seeded with `sql` (default blank). `name` is the
 * operator-set custom title; blank by default so the tab strip falls back to a
 * label derived from the draft's first line until the operator renames it.
 */
const makeTab = (sql = "", name = ""): SqlTab => {
    // eslint-disable-next-line unicorn/no-null -- `activeId` is a JSON-persisted "no linked saved query" sentinel; undefined would vanish through JSON.stringify
    return { activeId: null, id: newId("tab"), name, sql };
};

/** A single persisted string (the active tab id) on top of the array storage helper. */
const usePersistedActive = (): [string, Dispatch<SetStateAction<string>>] => {
    const [list, setList] = usePersistedList<string>(ACTIVE_KEY);

    const setActive = useCallback<Dispatch<SetStateAction<string>>>(
        (action) => {
            setList((current) => {
                const previous = current[0] ?? "";
                const next = typeof action === "function" ? action(previous) : action;

                return [next];
            });
        },
        [setList],
    );

    return [list[0] ?? "", setActive];
};

/**
 * Persisted open-tab list + the active tab id, restored from `localStorage` on
 * mount. Guarantees at least one tab always exists (so the single-query UX is
 * just "one tab"), and that the active id always points at a real tab — a stale
 * persisted active id (tab since closed) snaps to the first tab. Returns the
 * resolved list/active plus their setters; the panel owns the higher-level
 * open/close/select operations built on these.
 */
const usePersistedTabs = (
    seed: () => SqlTab,
): {
    activeId: string;
    setActiveId: Dispatch<SetStateAction<string>>;
    setTabs: Dispatch<SetStateAction<SqlTab[]>>;
    tabs: SqlTab[];
} => {
    const [stored, setTabs] = usePersistedList<SqlTab>(TABS_KEY);
    const [activeRaw, setActiveId] = usePersistedActive();

    // Seed exactly one tab the first time storage is empty, and persist it so the
    // panel's edits (which write through `setTabs`) land on a tab that's actually
    // in the list. A ref keeps the seed stable across the seeding re-render.
    const seedTab = useRef<null | SqlTab>(null);

    if (stored.length === 0 && seedTab.current === null) {
        seedTab.current = seed();
    }

    useEffect(() => {
        if (stored.length === 0 && seedTab.current !== null) {
            const initial = seedTab.current;

            setTabs([initial]);
        }
    }, [setTabs, stored.length]);

    // Never hand the panel an empty list while the seed is being persisted.
    const tabs = useMemo<SqlTab[]>(() => (stored.length === 0 && seedTab.current !== null ? [seedTab.current] : stored), [stored]);
    const activeId = tabs.some((tab) => tab.id === activeRaw) ? activeRaw : (tabs[0]?.id ?? "");

    return { activeId, setActiveId, setTabs, tabs };
};

/** Append `tab` to `tabs`, capped at {@link MAX_TABS} (drops the oldest when full). */
const addTab = (tabs: ReadonlyArray<SqlTab>, tab: SqlTab): SqlTab[] => [...tabs, tab].slice(-MAX_TABS);

/**
 * Remove the tab `id` from `tabs`. Always leaves at least one tab: closing the
 * last remaining tab replaces it with a fresh empty draft, so the editor never
 * has zero tabs. Returns the surviving list and the id that should become active
 * (the neighbour of the closed tab, or the new draft).
 */
const closeTab = (tabs: ReadonlyArray<SqlTab>, id: string, makeEmpty: () => SqlTab): { activeId: string; tabs: SqlTab[] } => {
    const index = tabs.findIndex((tab) => tab.id === id);

    if (index === -1) {
        return { activeId: tabs[0]?.id ?? "", tabs: [...tabs] };
    }

    const remaining = tabs.filter((tab) => tab.id !== id);

    if (remaining.length === 0) {
        const fresh = makeEmpty();

        return { activeId: fresh.id, tabs: [fresh] };
    }

    // Keep the neighbour to the left selected (clamped to the new last index).
    const neighbour = remaining[Math.min(index, remaining.length - 1)] as SqlTab;

    return { activeId: neighbour.id, tabs: remaining };
};

export { addTab, closeTab, makeTab, MAX_TABS, usePersistedTabs };
export type { SqlTab };
