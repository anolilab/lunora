import { stampLineage } from "../dispatcher/lineage";

/**
 * The dispatch namespace's Outbound Worker (plan 365 W5, D7) — a SEPARATE
 * deployable (`outbound.wrangler.jsonc`) that every tenant `fetch()` passes
 * through on its way out. Its one job is lineage: replace whatever lineage
 * header the tenant set with one it signs itself, one hop deeper than the
 * invocation the dispatcher said this is (the `lineage` binding parameter).
 * The dispatcher verifies it if the request comes back in, and refuses a loop
 * past the depth cap (`src/dispatcher/lineage.ts`).
 *
 * Fails safe: without the secret or the parameter it stamps nothing, so the
 * dispatcher sees an ordinary outside request. It never refuses a request
 * itself — a request to anywhere but the platform costs the platform nothing,
 * and only the dispatcher knows the target organization's policy.
 *
 * Enabling an Outbound Worker disables `connect()` (raw TCP) for tenant
 * Workers, which is what closes the socket hole a header-only scheme leaves.
 */
export default {
    async fetch(request: Request, env: { lineage?: string; LUNORA_LINEAGE_SECRET?: string }): Promise<Response> {
        return fetch(await stampLineage(request, env, Date.now()));
    },
};
