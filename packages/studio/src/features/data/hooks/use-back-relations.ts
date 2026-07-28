import { useLunora } from "@lunora/react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { BackRelation, BackRelationCountsResult } from "../../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../../lib/admin";
import { adminRef, callOptions, fireAndForget } from "../../../lib/internal";
import { backRelationKey } from "../back-relations";

const BACK_RELATION_COUNTS = adminRef(ADMIN_FUNCTIONS.backRelationCounts);

/** Counts for the loaded page: relation key → parent id → child count. */
type CountsByRelation = Readonly<Record<string, Readonly<Record<string, number>>>>;

/**
 * Resolve reverse-relation counts for the rows currently on screen.
 *
 * Only the relations the operator has switched ON are requested, and only for
 * the ids of the loaded page — resolving every reverse edge of every row would
 * make a wide table slow to serve a feature most sessions never open, which is
 * why the whole thing is opt-in.
 *
 * Best-effort: a failure leaves the previous counts in place and renders no
 * number rather than an error. These are supplementary context beside real row
 * data, so a broken count must never take the grid down with it.
 */
const useBackRelations = (
    enabled: ReadonlySet<string>,
    relations: ReadonlyArray<BackRelation>,
    ids: ReadonlyArray<string>,
    shardKey: string,
): CountsByRelation => {
    const client = useLunora();

    const [counts, setCounts] = useState<CountsByRelation>({});

    const requested = useMemo(() => relations.filter((relation) => enabled.has(backRelationKey(relation))), [enabled, relations]);

    // Serialised so an equal-but-new array identity doesn't re-fire the fetch on
    // every render — the ids change per page, which is exactly when it should.
    const signature = JSON.stringify([requested, ids]);

    const load = useCallback(
        async (token: { cancelled: boolean }): Promise<void> => {
            const [relationsToLoad, idsToLoad] = JSON.parse(signature) as [BackRelation[], string[]];

            if (relationsToLoad.length === 0 || idsToLoad.length === 0) {
                if (!token.cancelled) {
                    setCounts({});
                }

                return;
            }

            try {
                const result = (await client.query(
                    BACK_RELATION_COUNTS,
                    { ids: idsToLoad, relations: relationsToLoad },
                    callOptions(shardKey),
                )) as BackRelationCountsResult;

                if (!token.cancelled) {
                    setCounts(Object.fromEntries(result.relations.map((relation) => [backRelationKey(relation), relation.counts])));
                }
            } catch {
                // Supplementary context: keep whatever was shown rather than
                // blanking the grid over an optional column.
            }
        },
        [client, shardKey, signature],
    );

    useEffect(() => {
        const token = { cancelled: false };

        fireAndForget(load(token));

        return () => {
            token.cancelled = true;
        };
    }, [load]);

    return counts;
};

export { useBackRelations };
export type { CountsByRelation };
