import { useCirrus } from "@cirrus/react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { StorageTier } from "../../components/storage-tier";
import { TIER_META } from "../../components/storage-tier";
import { useT } from "../../i18n/i18n-context";
import { dataViewToSearch, searchToDataView } from "../../lib/data-view-params";
import { fireAndForget } from "../../lib/internal";
import type { DataView, SavedQuery } from "../../lib/saved-queries";
import { deleteSavedQuery, loadSavedQueries, saveQuery } from "../../lib/saved-queries";
import { DataBrowser } from "./data-browser";
import { GlobalDataBrowser } from "./global-data-browser";

interface TableEditorProps {
    /**
     * Allow editing the shard-local tables (insert/edit/delete). Forwarded to the
     * shard {@link DataBrowser}; the global D1 browser is always read-only. Off by
     * default — see {@link DataBrowser}.
     */
    readonly editable?: boolean;
    /** Shard key the shard browser targets on first load. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

/**
 * The schema/source selector — Supabase's `schema public ▾`. Picks which storage
 * tier the Table editor browses: per-shard SQLite (`.shardBy(...)`) or the global
 * D1 tables (`.global()`). A native select for keyboard and test friendliness,
 * styled to sit at the top of the table-list sidebar header. The `title` carries
 * each tier's long-form explanation so the distinction stays legible on hover.
 */
const SchemaSwitch = ({ onChange, tier }: { readonly onChange: (tier: StorageTier) => void; readonly tier: StorageTier }): ReactElement => {
    const t = useT();

    const onSelect = useCallback(
        (event: React.ChangeEvent<HTMLSelectElement>): void => {
            onChange(event.target.value as StorageTier);
        },
        [onChange],
    );

    return (
        <label className="flex w-full flex-col gap-1" htmlFor="table-editor-schema">
            <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{t("Storage tier")}</span>
            <select
                className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:border-ring"
                data-testid="table-editor-schema"
                id="table-editor-schema"
                onChange={onSelect}
                title={TIER_META[tier].title}
                value={tier}
            >
                <option value="shard">{TIER_META.shard.label}</option>
                <option value="global">{TIER_META.global.label}</option>
            </select>
        </label>
    );
};

/**
 * The Table editor: browses your application's tables across both storage tiers
 * from one section. A schema switch in the sidebar header (Supabase's
 * `schema public ▾`) toggles between the per-shard SQLite browser
 * (`.shardBy(...)`, editable when the host opts in) and the read-only global D1
 * browser (`.global()`) — folding what used to be a separate "Global Tables" tab
 * into a single editor (`STUDIO-REDESIGN-PLAN.md` §2).
 *
 * The active tier and open table live in the URL search params (`?schema=global`,
 * `?table=…`) rather than component state, so every selection is a real, shareable
 * URL and browser back/forward moves between tables and tiers. The browsers push on
 * selection and re-open whatever the URL names.
 */
export const TableEditor = ({ editable = false, initialShardKey }: TableEditorProps): ReactElement => {
    const client = useCirrus();
    const navigate = useNavigate();

    // The whole data-browser view comes from the URL: tier + open table plus the
    // shard / filters / search / sort that make every view a real, shareable link.
    // `strict: false` because the generic tab routes declare no typed search schema;
    // values are coerced or dropped by `searchToDataView`.
    const search: Record<string, unknown> = useSearch({ strict: false });
    const view = useMemo<DataView>(() => searchToDataView(search), [search]);
    const tier: StorageTier = view.tier ?? "shard";
    const tableParameter = view.table;

    // The persisted (localStorage) saved views, surfaced in the data browser's
    // canned-query toolbar. Seeded from storage once; mutated through the helpers.
    const [savedQueries, setSavedQueries] = useState<SavedQuery[]>(() => loadSavedQueries());

    // The `.global()` table names, so a shard-row ref into one routes to the global
    // tier instead of 404-ing against the shard's SQLite (global tables live in D1).
    const [globalTableNames, setGlobalTableNames] = useState<ReadonlySet<string>>(() => new Set<string>());

    // Learn the global table names once. Best-effort: when globals aren't configured
    // the call rejects and the set stays empty — there are then no global refs to
    // route anyway. `client` is context-stable, so this runs once.
    useEffect(() => {
        fireAndForget(
            (async (): Promise<void> => {
                try {
                    const tables = await client.listGlobalTables();

                    setGlobalTableNames(new Set(tables.map((table) => table.name)));
                } catch {
                    // Globals not configured — leave the set empty.
                }
            })(),
        );
    }, [client]);

    // Switch tier via the schema dropdown: write `?schema=…` and clear `?table` (the
    // other tier lists different tables). `schema` is omitted for the shard default
    // so the URL stays clean (`/data` rather than `/data?schema=shard`).
    const selectTier = useCallback(
        (next: StorageTier): void => {
            fireAndForget(
                navigate({
                    search: (previous: Record<string, unknown>) => {
                        return { ...previous, schema: next === "global" ? "global" : undefined, table: undefined };
                    },
                    to: "/data",
                }),
            );
        },
        [navigate],
    );

    // Mirror a table selection to the URL (`?table=…`) so it's shareable and recorded
    // in history for back/forward.
    const onSelectTable = useCallback(
        (table: string): void => {
            fireAndForget(
                navigate({
                    search: (previous: Record<string, unknown>) => {
                        return { ...previous, table };
                    },
                    to: "/data",
                }),
            );
        },
        [navigate],
    );

    // Follow a shard-row `v.id` ref whose target is a `.global()` table: switch to
    // the global tier and open that table — one URL push records both.
    const onNavigateToGlobal = useCallback(
        (table: string): void => {
            fireAndForget(
                navigate({
                    search: (previous: Record<string, unknown>) => {
                        return { ...previous, schema: "global", table };
                    },
                    to: "/data",
                }),
            );
        },
        [navigate],
    );

    // Mirror the loaded view (shard / search / filters / sort) into the URL so the
    // link IS the query. The browser fires this for the displayed view; we merge the
    // serialized params over the current ones (keeping `schema`/`table`), dropping any
    // that fall back to their default.
    const onViewChange = useCallback(
        (next: Pick<DataView, "filters" | "orderBy" | "search" | "shard">): void => {
            const patch = dataViewToSearch(next);

            fireAndForget(
                navigate({
                    replace: true,
                    search: (previous: Record<string, unknown>) => {
                        return { ...previous, filters: patch.filters, order: patch.order, search: patch.search, shard: patch.shard };
                    },
                    to: "/data",
                }),
            );
        },
        [navigate],
    );

    // Copy the current view's full URL to the clipboard. Best-effort: a missing/
    // throwing clipboard (insecure context) is swallowed — the URL is still in the bar.
    const onCopyLink = useCallback((): void => {
        try {
            // eslint-disable-next-line n/no-unsupported-features/node-builtins -- this is browser-only studio UI; `navigator.clipboard` is the Web Clipboard API, not the Node global, and never runs server-side.
            fireAndForget(globalThis.navigator.clipboard.writeText(globalThis.location.href));
        } catch {
            /* clipboard unavailable (insecure context) — nothing to copy to */
        }
    }, []);

    // Persist the current view under a name, then refresh the toolbar's list.
    const onSaveQuery = useCallback((name: string, snapshot: DataView): void => {
        setSavedQueries(saveQuery(name, snapshot));
    }, []);

    const onDeleteQuery = useCallback((name: string): void => {
        setSavedQueries(deleteSavedQuery(name));
    }, []);

    // Apply a saved view: navigate to the URL it encodes, which re-hydrates the
    // browser. A single push records both the table and the full view in history.
    const onApplyQuery = useCallback(
        (query: SavedQuery): void => {
            const patch = dataViewToSearch(query.view);

            fireAndForget(
                navigate({
                    search: () => {
                        return {
                            filters: patch.filters,
                            order: patch.order,
                            schema: patch.schema,
                            search: patch.search,
                            shard: patch.shard,
                            table: patch.table,
                        };
                    },
                    to: "/data",
                }),
            );
        },
        [navigate],
    );

    const queryBar = useMemo(() => {
        return { onApplyQuery, onCopyLink, onDeleteQuery, onSaveQuery, saved: savedQueries };
    }, [onApplyQuery, onCopyLink, onDeleteQuery, onSaveQuery, savedQueries]);

    const schemaSwitch = <SchemaSwitch onChange={selectTier} tier={tier} />;

    return tier === "global" ? (
        <GlobalDataBrowser initialTable={tableParameter} onSelectTable={onSelectTable} schemaSwitch={schemaSwitch} />
    ) : (
        <DataBrowser
            editable={editable}
            globalTableNames={globalTableNames}
            initialFilters={view.filters}
            initialOrderBy={view.orderBy}
            initialSearch={view.search}
            initialShardKey={view.shard ?? initialShardKey}
            onNavigateToGlobal={onNavigateToGlobal}
            onSelectTable={onSelectTable}
            onViewChange={onViewChange}
            queryBar={queryBar}
            schemaSwitch={schemaSwitch}
            tableParam={tableParameter}
        />
    );
};

export type { TableEditorProps };
