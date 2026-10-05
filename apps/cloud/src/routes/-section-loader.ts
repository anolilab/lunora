import type { FunctionReference, Preloaded, ReturnOf } from "@lunora/client";

import type { OrgId } from "../client/types";
import { preload } from "../ssr/loader";

/** A query whose only argument is the organization — every dashboard tab's primary read. */
type OrgScopedQuery = FunctionReference<"query", { organizationId: OrgId }>;

/**
 * Loader for a dashboard tab: preload the section's primary query on the edge as
 * the signed-in user.
 *
 * Extracted because all 18 tab routes carried a byte-identical loader body, each
 * repeating `params.organizationId as OrgId`. The cast now lives in exactly one
 * place instead of eighteen. Constraining the reference to {@link OrgScopedQuery}
 * also makes the args shape explicit, so a query needing more than the org
 * (`usage.summary`'s `periodStart`, `metrics.series`'s time range) is rejected here
 * rather than silently receiving a partial args object — those tabs keep bespoke
 * loaders.
 *
 * The route↔section type link is NOT this helper's job and does not need to be:
 * the route component passes `preloaded` into its section, and the section's
 * `SectionProps&lt;ReturnOf&lt;…>>` already makes a mismatched query a compile error at
 * the JSX site (verified: swapping a route's query for another table's fails
 * `tsc`). The `-` filename prefix keeps TanStack Router from treating this as a route.
 */
export const sectionLoader =
    <F extends OrgScopedQuery>(reference: F) =>
    async ({ params }: { params: { organizationId: string } }): Promise<{ preloaded: Preloaded<ReturnOf<F>> }> => {
        return {
            // The `OrgScopedQuery` constraint fixes `ArgsOf<F>` to this exact shape;
            // TS will not narrow it through the type parameter, so assert once here
            // instead of at all 18 call sites.
            preloaded: await preload(reference, { organizationId: params.organizationId as OrgId } as Parameters<typeof preload<F>>[1]),
        };
    };
