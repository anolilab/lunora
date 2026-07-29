import { useNavigate, useSearch } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useMemo } from "react";

import type { DriftChange } from "../../../../../shared/schema-snapshot";
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
    /**
     * Which reading of the diff to show. CONTROLLED by the route, because its
     * tab strip also selects the sibling Data-migrations pane — one flat row of
     * tabs beats a tab inside a tab.
     */
    readonly pane: "changes" | "diagram";
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

/** The three verbs a change can carry. Rendered per row, since the list groups by table. */
type ChangeAction = "added" | "changed" | "removed";

/**
 * Split a change discriminator into its verb and its subject kind.
 *
 * The `summary` string already reads "added table channels", but rendering seven
 * of those stacks the same two words down the left edge and buries the only
 * varying part — the identifier — mid-sentence. Splitting on `type` (the
 * machine-readable field, not the prose) lets the verb become a group heading and
 * the kind a fixed-width column, so the names line up as something you can scan.
 */
const CHANGE_SHAPE: Readonly<Record<DriftChange["type"], { action: ChangeAction; kind: string }>> = {
    addedIndex: { action: "added", kind: "index" },
    addedOptionalField: { action: "added", kind: "field?" },
    addedRelation: { action: "added", kind: "relation" },
    addedRequiredField: { action: "added", kind: "field" },
    addedTable: { action: "added", kind: "table" },
    changedFieldKind: { action: "changed", kind: "field kind" },
    changedIndex: { action: "changed", kind: "index" },
    changedJurisdiction: { action: "changed", kind: "jurisdiction" },
    changedShardMode: { action: "changed", kind: "shard mode" },
    fieldOptionalToRequired: { action: "changed", kind: "field → required" },
    fieldRequiredToOptional: { action: "changed", kind: "field → optional" },
    removedField: { action: "removed", kind: "field" },
    removedIndex: { action: "removed", kind: "index" },
    removedRelation: { action: "removed", kind: "relation" },
    removedTable: { action: "removed", kind: "table" },
};

/**
 * The identifier a change is about, with the prose stripped.
 *
 * `summary` leads with the verb and kind ("added table channels"), which the row
 * now renders as structure — so repeating them in the text would say everything
 * twice. Falls back to the full summary when the leading words do not match,
 * because a summary the diff model words differently must still be readable.
 */
const changeSubject = (change: DriftChange, kind: string): string => {
    const prefix = `${CHANGE_SHAPE[change.type].action} ${kind} `;

    return change.summary.startsWith(prefix) ? change.summary.slice(prefix.length) : change.summary;
};

/** One table's changes, in the order the list renders them. */
interface TableChangeGroup {
    readonly changes: ReadonlyArray<DriftChange>;
    /** The owning table, or `""` for schema-scoped changes (jurisdiction, shard mode). */
    readonly table: string;
}

/**
 * Group changes by the table they belong to.
 *
 * By TABLE rather than by verb, because once a diff carries field-level changes
 * "what happened to `users`?" is the question being asked, and a verb-first list
 * scatters one table's changes across three headings. The verb moves onto the
 * row, where it belongs next to the kind.
 *
 * `DriftChange.table` is set for every table-scoped change; the schema-scoped
 * ones (a jurisdiction or shard-mode move) have none and collect under a single
 * `""` group rendered last, since they describe the database rather than a table.
 *
 * Insertion-ordered: the diff model already emits changes in a stable order
 * (added/changed per table, then removals), so preserving it keeps successive
 * renders of the same diff identical.
 */
const groupChangesByTable = (changes: ReadonlyArray<DriftChange>): TableChangeGroup[] => {
    const byTable = new Map<string, DriftChange[]>();

    for (const change of changes) {
        const table = change.table ?? "";
        const bucket = byTable.get(table);

        if (bucket === undefined) {
            byTable.set(table, [change]);
        } else {
            bucket.push(change);
        }
    }

    const groups = [...byTable].map(([table, grouped]) => {
        return { changes: grouped, table };
    });

    // Schema-scoped last — it is context for the table groups above it.
    return [...groups.filter((group) => group.table !== ""), ...groups.filter((group) => group.table === "")];
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
export const SchemaHistoryPanel = ({ pane, shardKey = "" }: SchemaHistoryPanelProps): ReactElement => {
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
            {/* Tertiary: the rail is scenery. A single hairline separates it from
                the content rather than boxing it into a card. */}
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

            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 pe-1">
                {/* The one thing you look at first. */}
                <DiffVerdict
                    breaking={model?.breakingCount ?? 0}
                    count={previousHash === undefined ? diagramTables.length : changes.length}
                    first={previousHash === undefined}
                />

                {pane === "diagram" ? (
                    <div className="flex min-h-0 flex-1 flex-col">
                        <SchemaDiagram fill nodeClasses={nodeClasses} tables={diagramTables} testIdPrefix="sh" />
                    </div>
                ) : (
                    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="sh-changes">
                        {groupChangesByTable(changes).map((group) => {
                            // Column count comes from the diff model's table, which
                            // the canvas already loaded — free context on an added
                            // table, and absent for a schema-scoped group.
                            const meta = (model?.tables ?? []).find((entry) => entry.name === group.table);

                            return (
                                <section className="mb-6" key={group.table}>
                                    <div className="flex items-baseline gap-3 border-b border-border/60 pb-1.5">
                                        <span className="font-mono text-[13px] text-foreground">{group.table === "" ? t("schema") : group.table}</span>
                                        {meta !== undefined && (
                                            <span className="font-mono text-[10px] tracking-widest text-muted-foreground/70 tabular-nums uppercase">
                                                {t("{count} columns", { count: meta.columns.length })}
                                            </span>
                                        )}
                                        {/* Only when it counts something. Every group
                                            of a first-version diff holds exactly one
                                            change, and a column of "1"s is noise. */}
                                        {group.changes.length > 1 && (
                                            <span className="ms-auto font-mono text-[10px] tracking-widest text-muted-foreground/70 tabular-nums">
                                                {group.changes.length}
                                            </span>
                                        )}
                                    </div>

                                    <ul>
                                        {group.changes.map((change) => {
                                            const { action, kind } = CHANGE_SHAPE[change.type];
                                            const breaking = change.severity === "breaking";
                                            const subject = changeSubject(change, kind);

                                            return (
                                                <li
                                                    className="flex items-baseline gap-4 border-s-2 py-1.5 ps-3 transition-colors hover:bg-accent/30"
                                                    key={`${change.type}-${change.summary}`}
                                                >
                                                    {/* Severity is a rule on the edge, not a badge: every
                                                        row of a safe migration said "safe", so the chip
                                                        carried no information. */}
                                                    <span
                                                        aria-hidden="true"
                                                        className={cn("-ms-3 h-3 w-0.5 shrink-0 self-center", breaking ? "bg-destructive" : "bg-transparent")}
                                                    />
                                                    {/* Verb + kind in one fixed-width column, so the
                                                        subjects below line up as something scannable. */}
                                                    <span className="w-44 shrink-0 font-mono text-[10px] tracking-widest text-muted-foreground/70 uppercase">
                                                        {t(action)} {kind}
                                                    </span>
                                                    {/* An added TABLE's subject is the group heading — no
                                                        point saying `channels` under `channels`. */}
                                                    {subject !== group.table && (
                                                        <span
                                                            className={cn("min-w-0 font-mono text-[13px]", breaking ? "text-destructive" : "text-foreground")}
                                                        >
                                                            {subject}
                                                        </span>
                                                    )}
                                                    {breaking && (
                                                        <span className="ms-auto shrink-0 font-mono text-[10px] tracking-widest text-destructive uppercase">
                                                            {t("breaking")}
                                                        </span>
                                                    )}
                                                </li>
                                            );
                                        })}
                                    </ul>
                                </section>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
};

export type { SchemaHistoryPanelProps };
