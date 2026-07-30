import type { ReactElement } from "react";

import { EmptyState } from "../../components/ui/empty-state";
import { useT } from "../../i18n/i18n-context";

/**
 * Shown when the deployment declares no `.global()` tables at all — a different
 * situation from "a table is selected and empty", so it explains what would put
 * something here rather than reporting zero rows.
 *
 * Its own component to keep the inline globe glyph out of the browser's markup,
 * which was otherwise a dozen lines of SVG sitting between two conditionals.
 */
const GlobalTablesEmptyState = (): ReactElement => {
    const t = useT();

    return (
        <div className="flex flex-1 items-center justify-center p-6">
            <EmptyState
                description={t("Tables marked .global() (D1-backed, region-replicated) will appear here.")}
                icon={
                    <svg
                        aria-hidden="true"
                        fill="none"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.6}
                        viewBox="0 0 24 24"
                    >
                        <circle cx="12" cy="12" r="9" />
                        <path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18Z" />
                    </svg>
                }
                testId="gdb-empty"
                title={t("No global tables.")}
            />
        </div>
    );
};

export { GlobalTablesEmptyState };
