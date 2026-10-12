import { stampLineage } from "../dispatcher/lineage";
import { forwardWithEgress } from "../egress/forward";
import type { EgressPolicy } from "../egress/policy";
import { parseEgressParameter } from "../egress/policy";

/**
 * The dispatch namespace's Outbound Worker (plan 365 W5, D7) — a SEPARATE
 * deployable (`outbound.wrangler.jsonc`) that every tenant `fetch()` passes
 * through on its way out. Its first job is lineage: replace whatever lineage
 * header the tenant set with one it signs itself, one hop deeper than the
 * invocation the dispatcher said this is (the `lineage` binding parameter).
 * The dispatcher verifies it if the request comes back in, and refuses a loop
 * past the depth cap (`src/dispatcher/lineage.ts`).
 *
 * Fails safe: without the secret or the parameter it stamps nothing, so the
 * dispatcher sees an ordinary outside request. It refuses a request only when
 * the dispatcher handed it an enforcing egress policy (`src/egress/forward.ts`);
 * without one it forwards everything, as it always did.
 *
 * Enabling an Outbound Worker disables `connect()` (raw TCP) for tenant
 * Workers, which is what closes the socket hole a header-only scheme leaves.
 */
export default {
    async fetch(request: Request, env: { egress?: string; lineage?: string; LUNORA_LINEAGE_SECRET?: string }): Promise<Response> {
        // The egress policy is parsed first, so a refused request is never stamped. Absent
        // means no policy, and the request goes out as before. A parameter that is present
        // but malformed is refused, never treated as "no policy".
        let policy: EgressPolicy | undefined;

        if (env.egress !== undefined) {
            policy = parseEgressParameter(env.egress);

            if (policy === undefined) {
                return Response.json({ error: "egress_policy_invalid" }, { status: 503 });
            }
        }

        // Then lineage is stamped, and the policy is enforced on the stamped request.
        const stamped = await stampLineage(request, env, Date.now());

        return forwardWithEgress(stamped, policy, (outgoing) => fetch(outgoing));
    },
};
