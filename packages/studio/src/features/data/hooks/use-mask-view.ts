import { useState } from "react";

import type { MaskStrategy } from "../../../lib/admin";
import type { MaskView } from "../../../lib/mask-preview";
import { maskColumnsForTable, mergeSensitiveColumns } from "../../../lib/mask-preview";
import useMaskPolicies from "./use-mask-policies";

/** The mask-preview state a browser threads through its read surfaces. */
interface MaskPreview {
    /** The active table's masked columns (column → strategy). Non-empty ⇒ render the toggle and the header chips. */
    readonly maskColumns: ReadonlyMap<string, MaskStrategy>;
    readonly maskOn: boolean;
    /** The threaded view every cell / row / facet renderer reads. */
    readonly maskView: MaskView;

    /**
     * A view for a DIFFERENT table than the open one, built from that table's own
     * column names. The foreign-key hover preview fetches a row from the TARGET
     * table, so `maskView` — which covers the browsed table — does not apply to it;
     * without this the preview rendered the target's columns in the clear while the
     * grid beside it masked the same data.
     */
    readonly maskViewFor: (table: string, columns: ReadonlyArray<string>) => MaskView;
    readonly onToggleMask: () => void;
}

/**
 * The data browsers' "Mask sensitive columns" preview for one open table: which
 * columns are covered and whether the toggle is on.
 *
 * Shared by both tiers — the shard browser (via `useDataViewPreferences`, which
 * adds pins and transpose on top) and the `.global()` (D1) browser, which has no
 * pins or transpose and takes this directly. The metadata is tier-agnostic:
 * `__lunora_admin__:maskPolicies` is deployment-wide `(table, column, strategy)`
 * discovered from every `.use(mask(...))` chain, and a `.global()` table is
 * browsed under its logical schema name with its declared columns, so the same
 * `table` lookup resolves for both.
 */
const useMaskView = ({ columns, selectedTable }: { readonly columns: ReadonlyArray<string>; readonly selectedTable: null | string }): MaskPreview => {
    // The deployment's codegen-discovered mask policies (table + column + strategy),
    // loaded once. Drives the "Mask sensitive columns" preview: a render-only
    // redaction of what a `.use(mask(...))` caller would see, plus the per-column
    // "masked" header chips. The operator keeps full DB access — this is a preview,
    // not enforcement.
    const maskPolicies = useMaskPolicies();
    // Default the preview ON so plaintext secrets are hidden out of the box (the
    // operator reveals them by toggling). The toggle is only rendered when the
    // active table actually has sensitive columns, so an ordinary table is
    // unaffected; when it does, the safe-by-default state is masked.
    const [maskOn, setMaskOn] = useState<boolean>(true);
    const onToggleMask = (): void => {
        setMaskOn((current) => !current);
    };

    // The active table's masked columns (column → strategy). Explicit codegen
    // policies (`.use(mask(...))`) are layered with a name-heuristic fallback so a
    // plaintext `password` / `api_key` / `token` column with no declared policy is
    // still masked by default (as `"redact"`). Explicit policies always win.
    const explicitMaskColumns = maskColumnsForTable(maskPolicies, selectedTable ?? "");
    const maskColumns = mergeSensitiveColumns(explicitMaskColumns, columns);

    // Same layering as above, for a table that is not the open one. The policies are
    // deployment-wide, so a target table resolves without another fetch.
    const maskViewFor = (table: string, targetColumns: ReadonlyArray<string>): MaskView => {return {
        columns: mergeSensitiveColumns(maskColumnsForTable(maskPolicies, table), targetColumns),
        enabled: maskOn,
    }};

    // The chips show whenever a column is covered; cell values are only rewritten
    // when the toggle is on.
    return { maskColumns, maskOn, maskView: { columns: maskColumns, enabled: maskOn }, maskViewFor, onToggleMask };
};

export type { MaskPreview };
export { useMaskView };
