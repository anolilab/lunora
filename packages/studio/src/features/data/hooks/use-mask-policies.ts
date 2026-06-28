import { useAdminQuery } from "../../../hooks/use-admin-query";
import type { MaskColumnMetadata, MaskPoliciesResult } from "../../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../../lib/admin";

/** Hoisted empty list — a stable reference while the policies load (avoids a fresh `[]` each render). */
const NO_COLUMNS: ReadonlyArray<MaskColumnMetadata> = [];

/**
 * Fetch the deployment's mask metadata — the `(table, column, strategy)` entries
 * `@lunora/codegen` discovers from every `.use(mask(...))` chain, served by
 * `__lunora_admin__:maskPolicies`. Deployment-wide (root shard); the data
 * browser uses it to drive the "Mask sensitive columns" preview and the
 * per-column "masked" header chips.
 *
 * Fails soft: an older worker (or a stand-in) that doesn't serve the RPC, or one
 * that returns a non-array `columns`, yields an empty list rather than throwing —
 * the browser simply shows no masked columns. The error is never surfaced as a
 * blocking banner: masking is a preview affordance, not core to browsing rows.
 */
const useMaskPolicies = (): ReadonlyArray<MaskColumnMetadata> => {
    const { data } = useAdminQuery<MaskPoliciesResult>(ADMIN_FUNCTIONS.maskPolicies, {});

    return Array.isArray(data?.columns) ? data.columns : NO_COLUMNS;
};

export default useMaskPolicies;
