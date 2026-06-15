import { useLunora } from "@lunora/react";
import { useCallback, useEffect, useState } from "react";

import type { MaskColumnMetadata, MaskPoliciesResult } from "../../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../../lib/admin";
import { adminRef, callOptions, fireAndForget } from "../../../lib/internal";

const MASK_POLICIES = adminRef(ADMIN_FUNCTIONS.maskPolicies);

/** Hoisted empty list — a stable reference while the policies load (avoids a fresh `[]` each render). */
const NO_COLUMNS: ReadonlyArray<MaskColumnMetadata> = [];

/**
 * Fetch the deployment's mask metadata — the `(table, column, strategy)` entries
 * `@lunora/codegen` discovers from every `.use(mask(...))` chain, served by
 * `__lunora_admin__:maskPolicies`. Deployment-wide (root shard), loaded once;
 * the data browser uses it to drive the "Mask sensitive columns" preview and the
 * per-column "masked" header chips.
 *
 * Fails soft: an older worker (or a stand-in) that doesn't serve the RPC, or one
 * that returns a non-array `columns`, yields an empty list rather than throwing —
 * the browser simply shows no masked columns. The error is never surfaced as a
 * blocking banner: masking is a preview affordance, not core to browsing rows.
 */
const useMaskPolicies = (): ReadonlyArray<MaskColumnMetadata> => {
    const client = useLunora();
    const [columns, setColumns] = useState<ReadonlyArray<MaskColumnMetadata>>(NO_COLUMNS);

    const refresh = useCallback(async (): Promise<void> => {
        try {
            const result = (await client.query(MASK_POLICIES, {}, callOptions(""))) as MaskPoliciesResult;

            setColumns(Array.isArray(result.columns) ? result.columns : NO_COLUMNS);
        } catch {
            setColumns(NO_COLUMNS);
        }
    }, [client]);

    useEffect(() => {
        fireAndForget(refresh());
    }, [refresh]);

    return columns;
};

export default useMaskPolicies;
