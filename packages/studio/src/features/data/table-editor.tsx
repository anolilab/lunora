import { useLunora } from "@lunora/react";
import { useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import type { StorageTier } from "../../components/storage-tier";
import { TIER_META } from "../../components/storage-tier";
import { useMirroredRef } from "../../hooks/use-mirrored-ref";
import { useT } from "../../i18n/i18n-context";
import type { DataViewSearch } from "../../lib/data-view-params";
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

    const onSelect = (event: React.ChangeEvent<HTMLSelectElement>): void => {
        onChange(event.target.value as StorageTier);
    };

    return (
        <label className="flex w-full flex-col gap-1" htmlFor="table-editor-schema">
            <span className="font-mono text-[11px] tracking-wide uppercase text-muted-foreground">{t("Storage tier")}</span>
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

/** Copy the current deep link. A no-op where the clipboard API is unavailable (insecure context). */
const onCopyLink = (): void => {
    try {
        // eslint-disable-next-line n/no-unsupported-features/node-builtins -- this is browser-only studio UI; `navigator.clipboard` is the Web Clipboard API, not the Node global, and never runs server-side.
        fireAndForget(globalThis.navigator.clipboard.writeText(globalThis.location.href));
    } catch {
        /* clipboard unavailable (insecure context) — nothing to copy to */
    }
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
    const client = useLunora();
    const navigate = useNavigate();
    const router = useRouter();

    // The whole data-browser view comes from the URL: tier + open table plus the
    // shard / filters / search / sort that make every view a real, shareable link.
    // `strict: false` because the tab routes are built dynamically (no module-level
    // Route to type against); the `/data` route's `validateSearch`
    // (`validateDataViewSearch`) has already normalised these params on navigation,
    // so the cast to the typed {@link DataViewSearch} is sound and the downstream
    // `searchToDataView` receives a trustworthy, garbage-free shape.
    const search: DataViewSearch = useSearch({ strict: false });
    const view = searchToDataView(search);

    // Live mirror of the URL search params for `onViewChange`'s redundancy check,
    // held in a ref so that callback stays referentially stable (its dep is only
    // `navigate`). Without this, mirroring the loaded view back to the URL on a
    // deep-link load (`/data?table=…`) fires a `navigate({ to: "/data" })` that
    // clobbers an in-flight tab switch — you couldn't leave the data tab.
    const searchRef = useMirroredRef(search);

    // True while the data route is the active one. The URL-mirroring callbacks below
    // all `navigate({ to: "/data" })`; some fire from deferred effects/microtasks that
    // can land after a tab switch, so they consult this to avoid yanking the route back
    // to the data tab. Reads the router's *live* location (not a render snapshot, which
    // an unmounting panel never updates to the new route) and matches the last path
    // segment, so it holds under a mount prefix too (`/__lunora/data`).
    const onDataRoute = (): boolean => router.state.location.pathname.split("/").findLast(Boolean) === "data";
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

    // Reconcile a cross-tier table reference. A shard-tier URL that names a known
    // `.global()` table — a stale link, or a `?table=verification` deep-link into a
    // better-auth / external D1 table — would otherwise reach the shard SQLite browser
    // and surface `unknown table: …`. Once the global names are known, rewrite the URL
    // to the global tier (replace, so the bad URL leaves no back-button entry). Keeps
    // `?table` as-is; the global browser then opens it.
    useEffect(() => {
        // eslint-disable-next-line react-you-might-not-need-an-effect/no-event-handler -- not an event: this reconciles a deep-linked / stale URL against the asynchronously-loaded global table names; there is no user interaction to hang the redirect off of.
        if (tier === "shard" && tableParameter !== undefined && globalTableNames.has(tableParameter)) {
            fireAndForget(
                navigate({
                    replace: true,
                    search: (previous: Record<string, unknown>) => {
                        return { ...previous, schema: "global" };
                    },
                    to: "/data",
                }),
            );
        }
        // react-doctor-disable-next-line react-doctor/exhaustive-deps -- `tier` and `tableParameter` ARE `view.tier` / `view.table`, destructured above and listed in the deps
    }, [globalTableNames, navigate, tableParameter, tier]);

    // Switch tier via the schema dropdown: write `?schema=…` and clear `?table` (the
    // other tier lists different tables). `schema` is omitted for the shard default
    // so the URL stays clean (`/data` rather than `/data?schema=shard`).
    const selectTier = (next: StorageTier): void => {
        fireAndForget(
            navigate({
                search: (previous: Record<string, unknown>) => {
                    return { ...previous, schema: next === "global" ? "global" : undefined, table: undefined };
                },
                to: "/data",
            }),
        );
    };

    // Navigate the URL to a table (`?table=…`) so it's shareable and recorded in
    // history for back/forward. A switch opens the table CLEAN — the previous
    // table's `filters`/`order`/`search` are dropped (the shard + tier are kept) —
    // so the new table never inherits a stale view; `options.search` pre-fills the
    // search for an FK-cell traversal. Building the next search explicitly (rather
    // than spreading `previous`) also drops any unknown/stale params. Guarded by
    // {@link onDataRoute} so a mirror that lands just after a tab switch can't yank
    // the route back to the data tab.
    const onSelectTable = (table: string, options?: { search?: string }): void => {
        if (!onDataRoute()) {
            return;
        }

        fireAndForget(
            navigate({
                search: (previous: Record<string, unknown>) => {
                    return { schema: previous["schema"], search: options?.search, shard: previous["shard"], table };
                },
                to: "/data",
            }),
        );
    };

    // Follow a shard-row `v.id` ref whose target is a `.global()` table: switch to
    // the global tier and open that table — one URL push records both.
    const onNavigateToGlobal = (table: string): void => {
        fireAndForget(
            navigate({
                search: (previous: Record<string, unknown>) => {
                    return { ...previous, schema: "global", table };
                },
                to: "/data",
            }),
        );
    };

    // Mirror the loaded view (shard / search / filters / sort) into the URL so the
    // link IS the query. The browser fires this for the displayed view; we merge the
    // serialized params over the current ones (keeping `schema`/`table`), dropping any
    // that fall back to their default.
    const onViewChange = (next: Pick<DataView, "filters" | "orderBy" | "search" | "shard">): void => {
        const patch = dataViewToSearch(next);
        const { current } = searchRef;

        // Skip the mirror when the URL already reflects the loaded view — i.e.
        // the four params this callback owns are unchanged. The data browser
        // fires this on every load (including a deep-link `/data?table=…`),
        // where it would otherwise re-assert the current URL via a
        // `navigate({ to: "/data" })` that races and cancels a concurrent tab
        // switch, trapping the user on the data tab.
        const unchanged =
            (current["filters"] ?? undefined) === patch.filters &&
            (current["order"] ?? undefined) === patch.order &&
            (current["search"] ?? undefined) === patch.search &&
            (current["shard"] ?? undefined) === patch.shard;

        // Skip the mirror when the URL already reflects the loaded view, or when a
        // tab switch has already left the data route — either way a `navigate({ to:
        // "/data" })` here is at best redundant and at worst clobbers the in-flight
        // navigation, stranding the user on the data tab.
        if (unchanged || !onDataRoute()) {
            return;
        }

        fireAndForget(
            navigate({
                replace: true,
                search: (previous: Record<string, unknown>) => {
                    return { ...previous, filters: patch.filters, order: patch.order, search: patch.search, shard: patch.shard };
                },
                to: "/data",
            }),
        );
    };

    // Copy the current view's full URL to the clipboard. Best-effort: a missing/
    // throwing clipboard (insecure context) is swallowed — the URL is still in the bar.
    // Persist the current view under a name, then refresh the toolbar's list.
    const onSaveQuery = (name: string, snapshot: DataView): void => {
        setSavedQueries(saveQuery(name, snapshot));
    };

    const onDeleteQuery = (name: string): void => {
        setSavedQueries(deleteSavedQuery(name));
    };

    // Apply a saved view: navigate to the URL it encodes, which re-hydrates the
    // browser. A single push records both the table and the full view in history.
    const onApplyQuery = (query: SavedQuery): void => {
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
    };

    const queryBar = { onApplyQuery, onCopyLink, onDeleteQuery, onSaveQuery, saved: savedQueries };

    const schemaSwitch = <SchemaSwitch onChange={selectTier} tier={tier} />;

    return tier === "global" ? (
        <GlobalDataBrowser initialTable={tableParameter} onSelectTable={onSelectTable} schemaSwitch={schemaSwitch} />
    ) : (
        <DataBrowser
            editable={editable}
            globalTableNames={globalTableNames}
            initialFilters={view.filters}
            initialOrderBy={view.orderBy}
            initialPins={search.pins}
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
