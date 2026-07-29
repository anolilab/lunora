import { useNavigate, useSearch } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useMemo } from "react";

import { ErrorAlert } from "../../components/error-alert";
import type { StorageTier } from "../../components/storage-tier";
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

/**
 * One row in the version timeline.
 *
 * Tertiary layer: mono, small, low-contrast. The rail is scenery you scan, not
 * the thing you read — the selected version is marked by an aurora rule and a
 * contrast step, never by a heavier weight or a larger size.
 */
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
                "flex w-full flex-col items-start gap-1 border-s-2 px-4 py-3 text-start outline-none transition-colors",
                selected
                    ? "border-s-primary bg-accent/60 text-foreground"
                    : "border-s-transparent text-muted-foreground hover:bg-accent/30 hover:text-foreground",
            )}
            data-testid={`sh-version-${hash}`}
            onClick={() => {
                onSelect(hash);
            }}
            type="button"
        >
            <span className="flex w-full items-baseline gap-2">
                <span className="font-mono text-[13px] tabular-nums">v{seq}</span>
                <span className="ms-auto font-mono text-[10px] tracking-wider text-muted-foreground/70 uppercase">{hash.slice(0, 7)}</span>
            </span>
            <span className="font-mono text-[10px] tracking-wide text-muted-foreground/70">{formatTimestamp(appliedAt)}</span>
        </button>
    </li>
);

/**
 * The diff verdict — the PRIMARY layer, and the one thing this page exists to
 * answer: how much moved, and can it be deployed.
 *
 * A number at display size, because the count is the answer. Everything else on
 * the page is the evidence behind it. `breaking` is the only place colour
 * appears, and it lands on the value rather than on a label, so a safe migration
 * reads as pure monochrome and a dangerous one is impossible to miss.
 */
const DiffVerdict = ({ breaking, count, first }: { readonly breaking: number; readonly count: number; readonly first: boolean }): ReactElement => {
    const t = useT();

    if (first) {
        return (
            <div className="flex items-baseline gap-3" data-testid="sh-summary">
                <span className="text-3xl leading-none font-light tracking-tight tabular-nums">{count}</span>
                <span className="font-mono text-[11px] tracking-widest text-muted-foreground uppercase">{t("tables")}</span>
                <span className="font-mono text-[11px] tracking-widest text-muted-foreground/60 uppercase">· {t("first recorded version")}</span>
            </div>
        );
    }

    return (
        <div className="flex items-baseline gap-3" data-testid="sh-summary">
            <span className={cn("text-3xl leading-none font-light tracking-tight tabular-nums", breaking > 0 && "text-destructive")}>{count}</span>
            <span className="font-mono text-[11px] tracking-widest text-muted-foreground uppercase">{count === 1 ? t("change") : t("changes")}</span>
            {breaking > 0 && (
                <span className="font-mono text-[11px] tracking-widest text-destructive uppercase">· {t("{count} breaking", { count: breaking })}</span>
            )}
        </div>
    );
};

/** Small mono section label — the tertiary layer's only chrome. */
const RailLabel = ({ children }: { readonly children: string }): ReactElement => (
    <div className="px-4 pt-4 pb-2 font-mono text-[10px] tracking-widest text-muted-foreground/70 uppercase">{children}</div>
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
    const versions = historyQuery.data?.versions ?? [];

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

    // The next three MEMOS ARE LOAD-BEARING, unlike `versions` above. They flow
    // into `SchemaDiagram`, whose react-flow node/edge state is re-seeded by an
    // effect keyed on those props' identity — hand it a fresh object each render
    // and the effect sets state on every render, which is an infinite loop rather
    // than a slow one. React Compiler would keep them stable; a bail-out must not
    // be able to hang the page.
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

    const changes = model?.changes ?? [];

    return (
        <div className="flex min-h-0 flex-1 gap-6" data-testid="lunora-schema-history">
            {/* Tertiary: the rail is scenery. Sharp-edged, borderless on three
                sides — a single hairline separates it from the content rather
                than boxing it into a card. */}
            <nav className="flex w-56 shrink-0 flex-col overflow-hidden border-e border-border" data-testid="sh-timeline-rail">
                <RailLabel>{t("Schema versions")}</RailLabel>
                <ul className="min-h-0 flex-1 overflow-y-auto" data-testid="sh-timeline">
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
            </nav>

            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-5 pe-1">
                {/* The one thing you look at first. Given vast space above the
                    evidence so the squint test resolves to it. */}
                <DiffVerdict
                    breaking={model?.breakingCount ?? 0}
                    count={previousHash === undefined ? diagramTables.length : changes.length}
                    first={previousHash === undefined}
                />

                {/* The canvas carries no border — it already reads as a distinct
                    surface, and boxing it doubled the chrome. */}
                {/* flex-[2] against the list's flex-1 — the canvas gets the
                    larger share but no longer a hardcoded height that pushed the
                    verdict below the fold. */}
                <div className="flex min-h-0 flex-[2] flex-col">
                    <SchemaDiagram fill nodeClasses={nodeClasses} tables={diagramTables} testIdPrefix="sh" />
                </div>

                {/* Was a 160px strip with its own scrollbar — the third nested
                    scroll region on the page, holding the actual verdict. It now
                    takes a real share of the column and scrolls only when it
                    genuinely overflows. */}
                <ul className="min-h-0 flex-1 overflow-y-auto border-t border-border" data-testid="sh-changes">
                    {changes.map((change) => (
                        <li
                            className="flex items-baseline gap-3 border-s-2 py-2 ps-3 text-[13px] transition-colors hover:bg-accent/30"
                            key={`${change.type}-${change.summary}`}
                        >
                            {/* No badge. Every row of a safe migration said
                                "safe", so the chip carried no information while
                                dominating the row. Severity is a rule on the
                                left and colour on the value — an event, not a
                                default. */}
                            <span
                                aria-hidden="true"
                                className={cn("-ms-3 h-3.5 w-0.5 shrink-0 self-center", change.severity === "breaking" ? "bg-destructive" : "bg-border")}
                            />
                            {change.severity === "breaking" && (
                                <span className="font-mono text-[10px] tracking-widest text-destructive uppercase">{t("breaking")}</span>
                            )}
                            <span className={cn("min-w-0", change.severity === "breaking" ? "text-foreground" : "text-muted-foreground")}>
                                {change.summary}
                            </span>
                        </li>
                    ))}
                </ul>
            </div>
        </div>
    );
};

export type { SchemaHistoryPanelProps };
