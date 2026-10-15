import type { EgressPolicy } from "../egress/policy";
import { validateEgressPolicy } from "../egress/policy";

/**
 * What the control plane answers for one script, and how the dispatcher and the plan sweep
 * both read that answer. One parser, so a body the dispatcher refuses is never written to the
 * store by the sweep either. Every field a plan carries is decided in {@link normalizeFacts},
 * so adding a flag is a change to this file alone.
 */

/**
 * The plan the dispatcher refuses without asking the store: an answer that names an egress
 * policy it cannot validate. Never served, and never persisted (see `planRecordFor`).
 */
export const UNAVAILABLE_PLAN = "unavailable";

/** The facts a plan answer or a stored record carries: the tier, the two flags and the egress policy. */
export interface PlanFacts {
    /**
     * Outbound egress policy (plan 477). Present only when the control plane sends a valid one. A
     * policy that does not validate refuses the script; it is never served without one.
     */
    egress?: EgressPolicy;
    /** Plan name (free/pro/enterprise) the tenant is on, for runtime limits. */
    plan?: string;
    /** True when this is a PREVIEW deployment whose project has a password set (deployment protection). */
    protected?: boolean;
    /** `allow` when the org opted out of recursion termination (plan 365 W5); absent ⇒ `terminate`. */
    recursion?: "allow";
}

/** The plan answers a tenant is served on. Anything else — `suspended`, `unknown`, a lookup that failed — is refused. */
export const SERVABLE_PLANS: ReadonlySet<string> = new Set(["enterprise", "free", "pro"]);

/** Every answer `GET /v1/tenants/plan` may give; any other body is malformed and treated as a failed lookup. */
const KNOWN_PLANS: ReadonlySet<string> = new Set([...SERVABLE_PLANS, "suspended", "unknown"]);

/**
 * Keep only the fields a plan carries, in a fixed order. `protected` survives only as `true`; `recursion`
 * only as `allow`, because only an explicit `allow` opts out of recursion termination (plan 365 W5) and
 * anything else keeps it on, fail closed.
 */
export const normalizeFacts = (input: { egress?: EgressPolicy; plan?: string; protected?: unknown; recursion?: unknown }): PlanFacts => {
    return {
        ...(input.egress === undefined ? {} : { egress: input.egress }),
        ...(input.plan === undefined ? {} : { plan: input.plan }),
        ...(input.protected === true ? { protected: true } : {}),
        ...(input.recursion === "allow" ? { recursion: "allow" as const } : {}),
    };
};

/**
 * The egress field of a plan body, validated. `absent` means no policy was sent; `invalid` means one
 * was sent and does not validate, which every reader must refuse rather than drop (dropping it would
 * serve the tenant with no policy, which fails open). Both the control-plane answer and the stored
 * record read through this one function.
 */
export const egressOf = (body: Record<string, unknown>): { kind: "absent" } | { kind: "invalid" } | { kind: "valid"; policy: EgressPolicy } => {
    if (body["egress"] === undefined) {
        return { kind: "absent" };
    }

    const checked = validateEgressPolicy(body["egress"]);

    return checked.ok ? { kind: "valid", policy: checked.policy } : { kind: "invalid" };
};

/** Whether two sets of facts say the same thing. Compares the normalised forms, so a flag added to {@link normalizeFacts} is compared too. */
export const sameFacts = (a: PlanFacts, b: PlanFacts): boolean => JSON.stringify(normalizeFacts(a)) === JSON.stringify(normalizeFacts(b));

/** A plan answer, or `undefined` when the body is not one `GET /v1/tenants/plan` gives. */
export const toScriptFacts = (data: unknown): (PlanFacts & { plan: string }) | undefined => {
    const body = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
    const { plan } = body;

    if (typeof plan !== "string" || !KNOWN_PLANS.has(plan) || (body["protected"] !== undefined && typeof body["protected"] !== "boolean")) {
        return undefined;
    }

    const egress = egressOf(body);

    // An egress field that does not validate refuses the script. Returning `undefined` here would be a
    // failed lookup, and the resolver would fall back to a stored record, which fails open.
    if (egress.kind === "invalid") {
        return { plan: UNAVAILABLE_PLAN };
    }

    return {
        ...normalizeFacts({ egress: egress.kind === "valid" ? egress.policy : undefined, plan, protected: body["protected"], recursion: body["recursion"] }),
        plan,
    };
};
