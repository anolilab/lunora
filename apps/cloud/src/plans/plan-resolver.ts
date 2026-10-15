import readJson from "../read-json";
import type { PlanFacts } from "./plan-facts";
import { normalizeFacts, SERVABLE_PLANS, toScriptFacts, UNAVAILABLE_PLAN } from "./plan-facts";
import type { PlanReader, PlanRecord } from "./plan-store";

/**
 * The dispatcher's plan policy (plan 476): how a script's plan is looked up on the
 * control plane, cached per isolate, and decided from the stored record when the
 * control plane cannot be asked. Tenant routing lives in `targets/cloudflare-wfp/route.ts`.
 */

export interface PlanResolverOptions {
    /** Bearer for the control-plane plan endpoint. */
    controlPlaneToken: string;
    /** Control-plane base URL exposing `GET /v1/tenants/plan`. */
    controlPlaneUrl: string;
    /** Injectable fetch (defaults to the global). */
    fetch?: typeof fetch;
    /** Abort a control-plane lookup after this long, so a hung control plane reaches the fallback. Defaults to {@link PLAN_LOOKUP_TIMEOUT_MS}. */
    lookupTimeoutMs?: number;
    /** Maximum age in hours of a persisted non-suspended plan. Defaults to {@link PLAN_MAX_STALE_HOURS_DEFAULT}. */
    maxStaleHours?: number;
    /** Injectable clock (tests). */
    now?: () => number;

    /** Told how a stored answer was decided, for metrics. It never changes the answer. */
    onStore?: (outcome: StoreOutcome) => void;

    /**
     * Last-verified plans the control plane stored (plan 476). Read only, and
     * consulted only when the control plane cannot be asked. Absent ⇒ no store.
     */
    planStore?: PlanReader;
    /** Cache TTL in ms. Defaults to 60s. */
    ttlMs?: number;
}

/**
 * How the stored plan decided a request: `served` (a fresh plan), `suspended`
 * (refused at any age), `stale` (older than the bound, refused), `unreadable`
 * (the store failed, refused). A miss or an `unknown` record is not reported.
 */
export type StoreOutcome = "served" | "stale" | "suspended" | "unreadable";

/** Default maximum staleness of a persisted non-suspended plan (plan 476 §4.2). */
export const PLAN_MAX_STALE_HOURS_DEFAULT = 48;

/** The `PLAN_MAX_STALE_HOURS` var as a positive number of hours; anything else is the default. */
export const parsePlanMaxStaleHours = (raw: string | undefined): number => {
    const hours = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);

    return Number.isFinite(hours) && hours > 0 ? hours : PLAN_MAX_STALE_HOURS_DEFAULT;
};

/**
 * The plan the resolver answers when it has nothing verified to go on: a lookup
 * that failed, timed out or came back malformed, with no fresh-enough answer
 * cached. Not servable, so it is refused — never served on a default tier.
 */
export { UNAVAILABLE_PLAN } from "./plan-facts";

/**
 * How long past its TTL a cached answer still stands in for a failed refresh:
 * a control-plane blip keeps serving tenants it last saw healthy, for this
 * long, then refuses them. A `suspended` answer stands until a refresh succeeds.
 */
export const PLAN_STALE_GRACE_MS = 5 * 60_000;

/**
 * How long one control-plane plan lookup may take before it is abandoned and the
 * fallback is consulted. Without it a hung control plane never reaches the
 * fallback at all, and the request waits on the platform's own limits instead.
 */
export const PLAN_LOOKUP_TIMEOUT_MS = 5000;

/**
 * After a failed control-plane lookup, skip further lookups for this long when a store is bound.
 * The backoff is per control plane, not per script: during an outage every script would otherwise
 * pay the timeout on its first request. The trade-off: one script's failure briefly stops lookups
 * for all scripts, so a healthy script is answered from the store for up to this long.
 * A success of any script clears it.
 */
export const LOOKUP_FAILURE_BACKOFF_MS = 10_000;

/** TTL of an `unknown` answer, short so a first deploy is served within seconds of going live. */
const UNKNOWN_TTL_MS = 5000;

/**
 * One isolate-cache entry: when it expires, and the verdict it holds. The verdict is record-shaped,
 * so `verifiedAt` is the control-plane read that produced it; it may be `unknown`, which is never
 * persisted but is refused like any other unservable plan.
 */
interface CachedVerdict {
    expires: number;
    verdict: PlanRecord;
}

/**
 * What the store said about a script, as the fallback needs it: `read` when the
 * store answered (a record, or none), `failed` when it threw, `none` when no
 * store is configured, and `unread` when the isolate cache already decided and
 * the store was not asked.
 */
export type StoredRead = { state: "failed" } | { state: "none" } | { record?: PlanRecord; state: "read" } | { state: "unread" };

/** The answer to a request that the control plane could not give, with the store outcome it counts as. */
export interface FallbackDecision {
    facts: PlanFacts;

    /**
     * Set when a stored answer decided the request: a record, or an isolate verdict judged by the
     * same rules. A cache hit within grace, or a miss, reports nothing.
     */
    outcome?: StoreOutcome;
}

/**
 * Whether an isolate-cache verdict still stands on its own, without the store:
 * a `suspended` one indefinitely, any other within {@link PLAN_STALE_GRACE_MS}
 * past its expiry. The one place this is decided; the resolver asks it before
 * deciding whether to read the store at all.
 */
export const isCacheServable = (cached: CachedVerdict | undefined, now: number): cached is CachedVerdict =>
    cached !== undefined && (cached.verdict.plan === "suspended" || now < cached.expires + PLAN_STALE_GRACE_MS);

/** A refusal, reporting the store outcome that caused it when there was one. */
const refusal = (outcome?: StoreOutcome): FallbackDecision =>
    outcome === undefined ? { facts: { plan: UNAVAILABLE_PLAN } } : { facts: { plan: UNAVAILABLE_PLAN }, outcome };

/** The same rules for a stored answer, whichever backend it came from, or for a newer isolate verdict. */
const judgeStored = (record: PlanRecord, now: number, maxStaleMs: number): FallbackDecision => {
    // Suspension stands at any age: a money case never depends on the staleness bound.
    if (record.plan === "suspended") {
        return { facts: { plan: "suspended" }, outcome: "suspended" };
    }

    // The store never holds `unknown` (the parser drops it), but an isolate verdict can. Anything
    // unservable, `unknown` included, is refused.
    if (!SERVABLE_PLANS.has(record.plan)) {
        return refusal();
    }

    if (now - record.verifiedAt > maxStaleMs) {
        return refusal("stale");
    }

    return { facts: normalizeFacts(record), outcome: "served" };
};

/**
 * The store's half of {@link decideFallback}, for an isolate verdict that is not servable on its own. Kept
 * separate so that the type predicate in {@link isCacheServable} narrows only the servable branch: here
 * `cached` is still the full `CachedVerdict | undefined`.
 */
const decideFromStore = (input: { cached?: CachedVerdict; maxStaleMs: number; now: number; read: StoredRead }): FallbackDecision => {
    const { cached, maxStaleMs, now, read } = input;

    if (read.state === "failed") {
        return refusal("unreadable");
    }

    if (read.state !== "read") {
        return refusal();
    }

    const { record } = read;

    // An absent record refuses. A deleted record must not be outlived by this isolate's own
    // cached verdict: the writer deletes when the script stops being a tenant.
    if (cached !== undefined && record !== undefined && cached.verdict.verifiedAt > record.verifiedAt) {
        return judgeStored(cached.verdict, now, maxStaleMs);
    }

    return record === undefined ? refusal() : judgeStored(record, now, maxStaleMs);
};

/**
 * The single decision for a failed control-plane lookup (plan 476 §3). Pure: it
 * takes what is known and returns the facts to answer with, or
 * {@link UNAVAILABLE_PLAN} to refuse.
 *
 * - A servable isolate verdict (within grace, or `suspended`) wins, and the store
 *   is not needed. This is the warm-isolate path, and it does not read KV.
 * - Past grace, the store decides. If the isolate holds a verdict NEWER than the
 *   stored record, that verdict is the one judged, by the same rules, at its own
 *   read time: a warm isolate keeps serving its tenants for the staleness bound
 *   during an outage, and an older record cannot revert a newer protection or
 *   suspension. Without a stored record to compare with, the isolate verdict is
 *   judged the same way.
 * - With no store configured, or a failed read, a verdict past grace is refused,
 *   as it was before the store existed.
 */
export const decideFallback = (input: { cached?: CachedVerdict; maxStaleMs: number; now: number; read: StoredRead }): FallbackDecision => {
    const { cached, maxStaleMs, now, read } = input;

    if (isCacheServable(cached, now)) {
        return { facts: normalizeFacts(cached.verdict) };
    }

    // Past this point the isolate verdict is not servable on its own, so it is only ever compared, never served.
    return decideFromStore({ cached, maxStaleMs, now, read });
};

/**
 * Build a cached `resolvePlan` that asks the control plane for a script's plan
 * tier and admission (`GET /v1/tenants/plan`). Per-isolate TTL cache keeps the
 * hot path off a round-trip on every request, keyed by the script name it was
 * resolved for. The answer is only as fresh as the TTL: a suspension, a breach
 * or an alias changing owners reaches this isolate within `ttlMs` (60 s).
 *
 * Fails closed. A lookup that fails, times out ({@link PLAN_LOOKUP_TIMEOUT_MS})
 * or comes back malformed falls back through {@link decideFallback}: the isolate's
 * own verdict within {@link PLAN_STALE_GRACE_MS}, then the plan the control plane
 * stored (`planStore`), and otherwise {@link UNAVAILABLE_PLAN}, which the
 * dispatcher refuses. A never-seen tenant or a protected preview is never served
 * on a lookup that did not happen.
 *
 * The store is read here and never written. A stored answer is not copied into
 * the isolate cache, so the grace keeps counting from the last real lookup.
 */
export const createPlanResolver = (options: PlanResolverOptions): ((scriptName: string) => Promise<PlanFacts>) => {
    const fetchImpl = options.fetch ?? fetch;
    const now = options.now ?? Date.now;
    const ttl = options.ttlMs ?? 60_000;
    const timeoutMs = options.lookupTimeoutMs ?? PLAN_LOOKUP_TIMEOUT_MS;
    const maxStaleMs = (options.maxStaleHours ?? PLAN_MAX_STALE_HOURS_DEFAULT) * 3_600_000;
    const report = options.onStore ?? (() => undefined);
    const hasStore = options.planStore !== undefined;
    const cache = new Map<string, CachedVerdict>();
    // When the control plane last failed a lookup, with a store bound. Failure backoff only applies
    // with a store: without one a failed lookup is refused at once, so there is nothing to protect.
    let lastFailureAt: number | undefined;

    const readStore = async (scriptName: string): Promise<StoredRead> => {
        if (options.planStore === undefined) {
            return { state: "none" };
        }

        try {
            return { record: await options.planStore.get(scriptName), state: "read" };
        } catch {
            return { state: "failed" };
        }
    };

    const fallback = async (scriptName: string, cached: CachedVerdict | undefined): Promise<PlanFacts> => {
        const read: StoredRead = isCacheServable(cached, now()) ? { state: "unread" } : await readStore(scriptName);
        const decision = decideFallback({ cached, maxStaleMs, now: now(), read });

        if (decision.outcome !== undefined) {
            report(decision.outcome);
        }

        return decision.facts;
    };

    const backingOff = (): boolean => hasStore && lastFailureAt !== undefined && now() - lastFailureAt < LOOKUP_FAILURE_BACKOFF_MS;

    const failed = (scriptName: string, cached: CachedVerdict | undefined): Promise<PlanFacts> => {
        if (hasStore) {
            lastFailureAt = now();
        }

        return fallback(scriptName, cached);
    };

    return async (scriptName: string): Promise<PlanFacts> => {
        const cached = cache.get(scriptName);

        if (cached && cached.expires > now()) {
            return normalizeFacts(cached.verdict);
        }

        if (backingOff()) {
            return fallback(scriptName, cached);
        }

        try {
            const url = `${options.controlPlaneUrl}/v1/tenants/plan?script=${encodeURIComponent(scriptName)}`;
            // The timeout exists so a hung control plane reaches the stored fallback. Without a store there
            // is no fallback to reach, so the lookup keeps its previous, unbounded behaviour.
            const response = await fetchImpl(url, {
                headers: { authorization: `Bearer ${options.controlPlaneToken}` },
                ...(hasStore ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
            });

            if (!response.ok) {
                return failed(scriptName, cached);
            }

            const facts = toScriptFacts(await readJson<unknown>(response));

            if (facts === undefined) {
                return failed(scriptName, cached);
            }

            const readAt = now();

            lastFailureAt = undefined;
            cache.set(scriptName, {
                expires: readAt + (facts.plan === "unknown" ? Math.min(ttl, UNKNOWN_TTL_MS) : ttl),
                verdict: { ...facts, verifiedAt: readAt },
            });

            return normalizeFacts(facts);
        } catch {
            return failed(scriptName, cached);
        }
    };
};
