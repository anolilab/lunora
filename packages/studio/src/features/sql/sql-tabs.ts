import type { Dispatch, SetStateAction } from "react";
import { useEffect, useState } from "react";

import { newId, usePersistedList, usePersistedValue } from "../../lib/browser-storage";

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

const TABS_KEY = "lunora-studio-sql-tabs";
const ACTIVE_KEY = "lunora-studio-sql-active-tab";

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
const usePersistedActive = (): [string, Dispatch<SetStateAction<string>>] => usePersistedValue<string>(ACTIVE_KEY, "");

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
    // in the list.
    //
    // A lazy `useState` initialiser, not a ref written during render: the seed has
    // to survive the render that persists it AND be readable while building
    // `tabs` below, and a ref that is both written and read mid-render is exactly
    // the impure-render shape React makes no ordering guarantees about. The
    // initialiser runs once per mount; when storage already has tabs the seed is
    // simply never used.
    const [seedTab] = useState<SqlTab>(seed);

    useEffect(() => {
        if (stored.length === 0) {
            setTabs([seedTab]);
        }
    }, [seedTab, setTabs, stored.length]);

    // Never hand the panel an empty list while the seed is being persisted.
    const tabs = stored.length === 0 ? [seedTab] : stored;
    const activeId = tabs.some((tab) => tab.id === activeRaw) ? activeRaw : (tabs[0]?.id ?? "");

    return { activeId, setActiveId, setTabs, tabs };
};

/**
 * Whether closing `tab` would lose unsaved work: an unlinked scratch draft with
 * text. A linked tab auto-saves to its query and an empty tab loses nothing, so
 * neither needs a discard confirm. Shared by the single- and bulk-close guards.
 */
const isDirty = (tab: SqlTab): boolean => tab.activeId === null && tab.sql.trim() !== "";

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

/** Keep only the tab `id`, closing every other tab; that tab becomes active. */
const closeOtherTabs = (tabs: ReadonlyArray<SqlTab>, id: string): { activeId: string; tabs: SqlTab[] } => {
    const kept = tabs.filter((tab) => tab.id === id);

    return kept.length === 0 ? { activeId: tabs[0]?.id ?? "", tabs: [...tabs] } : { activeId: id, tabs: kept };
};

/** Close every tab to the right of `id`; the active tab clamps to `id` when it was one of the closed ones. */
const closeTabsToRight = (tabs: ReadonlyArray<SqlTab>, id: string, activeId: string): { activeId: string; tabs: SqlTab[] } => {
    const index = tabs.findIndex((tab) => tab.id === id);

    if (index === -1) {
        return { activeId, tabs: [...tabs] };
    }

    const kept = tabs.slice(0, index + 1);

    return { activeId: kept.some((tab) => tab.id === activeId) ? activeId : id, tabs: kept };
};

/** Close every tab, leaving one fresh empty draft (like closing the last remaining tab). */
const closeAllTabs = (makeEmpty: () => SqlTab): { activeId: string; tabs: SqlTab[] } => {
    const fresh = makeEmpty();

    return { activeId: fresh.id, tabs: [fresh] };
};

/** The tabs a bulk close would remove: every other tab, the tabs to the right of `id`, or all of them. */
const tabsClosedBy = (op: "all" | "others" | "right", tabs: ReadonlyArray<SqlTab>, id: string): SqlTab[] => {
    if (op === "others") {
        return tabs.filter((tab) => tab.id !== id);
    }

    if (op === "right") {
        const index = tabs.findIndex((tab) => tab.id === id);

        return index === -1 ? [] : tabs.slice(index + 1);
    }

    return [...tabs];
};

/**
 * Which results sub-pane a tab is showing. Declared with the tab model it belongs to,
 * so the pane and the hook cannot drift into two compatible-by-accident unions.
 */
type ResultTab = "chart" | "explain" | "results";

export { addTab, closeAllTabs, closeOtherTabs, closeTab, closeTabsToRight, isDirty, makeTab, MAX_TABS, tabsClosedBy, usePersistedTabs };
export type { ResultTab, SqlTab };
