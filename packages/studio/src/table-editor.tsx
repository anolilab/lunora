import { useCirrus } from "@cirrus/react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";

import { DataBrowser } from "./data-browser";
import { GlobalDataBrowser } from "./global-data-browser";
import { useT } from "./i18n-context";
import { fireAndForget } from "./internal";
import type { StorageTier } from "./storage-tier";
import { TIER_META } from "./storage-tier";

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

    // Tier + open table come from the URL. `strict: false` because the generic tab
    // routes declare no typed search schema; values are coerced or dropped.
    const search: Record<string, unknown> = useSearch({ strict: false });
    const tier: StorageTier = search["schema"] === "global" ? "global" : "shard";
    const tableParameter = typeof search["table"] === "string" ? search["table"] : undefined;

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

    const schemaSwitch = <SchemaSwitch onChange={selectTier} tier={tier} />;

    return tier === "global" ? (
        <GlobalDataBrowser initialTable={tableParameter} onSelectTable={onSelectTable} schemaSwitch={schemaSwitch} />
    ) : (
        <DataBrowser
            editable={editable}
            globalTableNames={globalTableNames}
            initialShardKey={initialShardKey}
            onNavigateToGlobal={onNavigateToGlobal}
            onSelectTable={onSelectTable}
            schemaSwitch={schemaSwitch}
            tableParam={tableParameter}
        />
    );
};

export type { TableEditorProps };
