import { useNavigate, useSearch } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useMemo } from "react";

import { ErrorAlert } from "../../components/error-alert";
import type { StorageTier } from "../../components/storage-tier";
import { Badge } from "../../components/ui/badge";
import { EmptyState } from "../../components/ui/empty-state";
import { useAdminQuery } from "../../hooks/use-admin-query";
import { useT } from "../../i18n/i18n-context";
import type { SchemaVersionDetail, SchemaVersionsResult } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { fireAndForget, formatTimestamp } from "../../lib/internal";
import { cn } from "../../lib/utils";
import type { DiagramTable } from "../schema/schema-diagram";
import { SchemaDiagram } from "../schema/schema-diagram";
import type { DiffTable, TableStatus } from "./schema-diff-model";
import { buildSchemaDiffModel, snapshotFromJson } from "./schema-diff-model";

interface SchemaHistoryPanelProps {
    /** Shard key whose ledger is shown. Defaults to the root shard. */
    readonly shardKey?: string;
}

/** Ring colour per table status. `context` is deliberately unstyled — it is scenery, not signal. */
const STATUS_RING: Readonly<Record<TableStatus, string>> = {
    added: "ring-2 ring-emerald-500/60",
    changed: "ring-2 ring-amber-500/70",
    context: "opacity-55",
    removed: "opacity-70 ring-2 ring-destructive/60",
};

/** Map a snapshot's shard mode onto the diagram's storage tier. */
const tierOf = (shardMode: string): StorageTier => (shardMode === "global" ? "global" : "shard");

/** One row in the version timeline. */
const VersionRow = ({
    appliedAt,
    hash,
    onSelect,
    selected,
    seq,
}: {
    readonly appliedAt: number;
    readonly hash: string;
    readonly onSelect: (hash: string) => void;
    readonly selected: boolean;
    readonly seq: number;
}): ReactElement => (
    <li>
        <button
            className={cn(
                "flex w-full flex-col items-start gap-0.5 border-s-2 px-3 py-2 text-start outline-none transition-colors hover:bg-accent focus-visible:bg-accent",
                selected ? "border-s-primary bg-accent" : "border-s-transparent",
            )}
            data-testid={`sh-version-${hash}`}
            onClick={() => {
                onSelect(hash);
            }}
            type="button"
        >
            <span className="flex w-full items-center gap-2">
                <span className="text-xs font-medium">v{seq}</span>
                <span className="ms-auto font-mono text-[10px] text-muted-foreground">{hash.slice(0, 8)}</span>
            </span>
            <span className="text-[11px] text-muted-foreground">{formatTimestamp(appliedAt)}</span>
        </button>
    </li>
);

/**
 * The schema-version timeline and its visual diff.
 *
 * Every distinct schema shape a shard has run is recorded in its
 * `__lunora_schema_history` ledger by `runShardMigrations` (see
 * `@lunora/do`'s `schema-history.ts`). Selecting a version diffs it against the
 * one before it and renders the result on the same React Flow canvas the schema
 * viewer uses: added tables ringed green, tables whose own shape moved ringed
 * amber, removed tables ringed red, and untouched neighbours dimmed as context.
 *
 * The change list under the canvas is the shared `DriftChange[]` — the exact
 * verdict `lunora deploy`'s drift gate blocks on, so the UI and the gate cannot
 * tell different stories.
 */
export const SchemaHistoryPanel = ({ shardKey = "" }: SchemaHistoryPanelProps): ReactElement => {
    const t = useT();

    const navigate = useNavigate();
    // `strict: false` — this panel is also rendered outside a typed route in tests.
    const search: { version?: string } = useSearch({ strict: false });
    const picked = search.version;

    const setPicked = (version: string): void => {
        fireAndForget(navigate({ search: { version }, to: "/migrations" }));
    };

    const historyQuery = useAdminQuery<SchemaVersionsResult>(ADMIN_FUNCTIONS.schemaHistory, {}, { shardKey });
    const versions = useMemo(() => historyQuery.data?.versions ?? [], [historyQuery.data]);

    // The selection is DERIVED, not synced in an effect: default to the newest
    // version, and fall back to it whenever the picked hash is not in the current
    // ledger (pruned past the retention cap, or a shard switch). Syncing this with
    // `setState` in an effect would render once with a stale selection and once
    // more to correct it — and is a lint error in this repo besides.
    const selected = picked !== undefined && versions.some((version) => version.hash === picked) ? picked : versions[0]?.hash;

    const selectedIndex = versions.findIndex((version) => version.hash === selected);
    // The ledger is newest-first, so the PREVIOUS version is the next index.
    const previousHash = selectedIndex === -1 ? undefined : versions[selectedIndex + 1]?.hash;

    const afterQuery = useAdminQuery<SchemaVersionDetail>(
        ADMIN_FUNCTIONS.schemaVersion,
        { hash: selected ?? "" },
        { enabled: selected !== undefined, shardKey },
    );
    const beforeQuery = useAdminQuery<SchemaVersionDetail>(
        ADMIN_FUNCTIONS.schemaVersion,
        { hash: previousHash ?? "" },
        { enabled: previousHash !== undefined, shardKey },
    );

    const model = useMemo(() => {
        const after = snapshotFromJson(afterQuery.data?.version?.snapshotJson);

        if (after === undefined) {
            return undefined;
        }

        return buildSchemaDiffModel(snapshotFromJson(beforeQuery.data?.version?.snapshotJson), after);
    }, [afterQuery.data, beforeQuery.data]);

    // The canvas consumes the schema viewer's `DiagramTable`, so the diff maps
    // onto it and passes the per-table status as a separate ring map — reusing
    // one laid-out, exportable canvas instead of forking a second one.
    const diagramTables = useMemo<DiagramTable[]>(
        () =>
            (model?.tables ?? []).map((table: DiffTable) => {
                return { columns: table.columns, name: table.name, tier: tierOf(table.shardMode) };
            }),
        [model],
    );
    const nodeClasses = useMemo<Record<string, string>>(() => {
        const classes: Record<string, string> = {};

        for (const table of model?.tables ?? []) {
            classes[table.name] = STATUS_RING[table.status];
        }

        return classes;
    }, [model]);

    // An unreachable RPC (an older worker, a missing admin token) also yields no
    // versions. Rendering the empty state for it would assert something about the
    // database that the studio does not know — so the failure is shown as a
    // failure, and only a genuinely empty ledger gets the empty state.
    if (historyQuery.error !== null) {
        return <ErrorAlert error={historyQuery.errorSource} testId="sh-error" />;
    }

    if (versions.length === 0) {
        return (
            <EmptyState
                description={t("Each distinct schema shape this shard runs is recorded here, so you can see what changed and when.")}
                testId="sh-empty"
                title={t("No schema versions recorded yet.")}
            />
        );
    }

    return (
        <div className="flex min-h-0 flex-1 gap-3" data-testid="lunora-schema-history">
            <ul className="w-48 shrink-0 overflow-y-auto rounded-xl border border-border bg-card py-1" data-testid="sh-timeline">
                {versions.map((version) => (
                    <VersionRow
                        appliedAt={version.appliedAt}
                        hash={version.hash}
                        key={version.hash}
                        onSelect={setPicked}
                        selected={version.hash === selected}
                        seq={version.seq}
                    />
                ))}
            </ul>

            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
                <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="sh-summary">
                    {previousHash === undefined ? (
                        <span>{t("First recorded version — every table is new.")}</span>
                    ) : (
                        <span>
                            {t("{count} change(s)", { count: model?.changes.length ?? 0 })}
                            {(model?.breakingCount ?? 0) > 0 && (
                                <Badge className="ms-2" variant="destructive">
                                    {t("{count} breaking", { count: model?.breakingCount ?? 0 })}
                                </Badge>
                            )}
                        </span>
                    )}
                </div>

                <div className="min-h-0 flex-1">
                    <SchemaDiagram nodeClasses={nodeClasses} tables={diagramTables} testIdPrefix="sh" />
                </div>

                <ul className="max-h-40 shrink-0 overflow-y-auto rounded-xl border border-border bg-card" data-testid="sh-changes">
                    {(model?.changes ?? []).map((change) => (
                        <li className="flex items-start gap-2 px-3 py-1.5 text-xs" key={`${change.type}-${change.summary}`}>
                            <Badge className="mt-px shrink-0" variant={change.severity === "breaking" ? "destructive" : "secondary"}>
                                {change.severity === "breaking" ? t("breaking") : t("safe")}
                            </Badge>
                            <span className="min-w-0 text-muted-foreground">{change.summary}</span>
                        </li>
                    ))}
                </ul>
            </div>
        </div>
    );
};

export type { SchemaHistoryPanelProps };
