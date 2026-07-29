import type { ReactElement } from "react";
import { useState } from "react";

import { useT } from "../../i18n/i18n-context";
import { cn } from "../../lib/utils";
import { MigrationsPanel } from "./migrations";
import { SchemaHistoryPanel } from "./schema-history";

/** The three readings this page offers, in tab order. */
type MigrationsPane = "changes" | "data" | "diagram";

/**
 * The Migrations page: one flat row of tabs over three readings of migration
 * state — the schema canvas, the schema diff, and hand-written data migrations.
 *
 * Previously these were sections STACKED down a scrolling page, and they starved
 * each other: the canvas and the change list fought for the same vertical space,
 * and the data-migrations form sat below a fold nobody reached. Only one of the
 * three is ever the thing you are looking at, so only one is mounted, and it
 * gets the full height.
 *
 * Schema and data migrations remain separate readings, not one merged timeline —
 * schema is applied at runtime from `defineSchema`, while `defineMigration` is
 * hand-written data movement, and interleaving them would imply a causal link
 * the data does not carry. Tabs keep them distinct while letting them share the
 * viewport.
 *
 * A real component rather than inline JSX in the router, so its labels can go
 * through `useT()` — `buildRouter` is a plain function and cannot call hooks,
 * which is how these headings once shipped hard-coded in English.
 */
export const MigrationsRoutePanel = ({ initialShardKey }: { readonly initialShardKey?: string }): ReactElement => {
    const t = useT();

    const [pane, setPane] = useState<MigrationsPane>("diagram");

    const tabClass = (active: boolean): string =>
        cn(
            "border-b-2 px-3 py-2 font-mono text-[11px] tracking-widest uppercase outline-none transition-colors",
            active ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
        );

    const tab = (key: MigrationsPane, label: string, testId: string): ReactElement => (
        <button
            aria-selected={pane === key}
            className={tabClass(pane === key)}
            data-testid={testId}
            onClick={() => {
                setPane(key);
            }}
            role="tab"
            type="button"
        >
            {label}
        </button>
    );

    return (
        <div className="flex min-h-0 flex-1 flex-col" data-testid="lunora-migrations">
            <div className="flex shrink-0 items-center gap-1 border-b border-border px-3" data-testid="mg-panes" role="tablist">
                {tab("diagram", t("Diagram"), "mg-pane-diagram")}
                {tab("changes", t("Changes"), "mg-pane-changes")}
                {tab("data", t("Data migrations"), "mg-pane-data")}
            </div>

            {/* Only the selected pane is mounted, so the React Flow canvas is not
                measuring and re-fitting behind a form nobody is looking at. */}
            <div className="flex min-h-0 flex-1 flex-col px-4 pt-4">
                {pane === "data" ? (
                    <div className="min-h-0 flex-1 overflow-y-auto px-1">
                        <MigrationsPanel initialShardKey={initialShardKey} />
                    </div>
                ) : (
                    <SchemaHistoryPanel pane={pane} shardKey={initialShardKey} />
                )}
            </div>
        </div>
    );
};
