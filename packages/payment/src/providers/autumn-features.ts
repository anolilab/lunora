/**
 * Autumn-native feature surface.
 *
 * The generic `PaymentAdapter` covers checkout, subscriptions, entitlements, and usage — the
 * cross-provider vocabulary. Autumn also ships concepts with no provider-agnostic equivalent:
 * `entities` (per-seat / per-workspace sub-customers with their own feature balances), `referrals`
 * (codes and redemptions), events analytics (query/aggregate a reference's raw usage over a range),
 * the plan catalog, and a native checkout with Autumn-only options (free trials, prepaid feature
 * quantities, entity scoping, reward codes).
 *
 * These live in this companion facade — deliberately separate from `createAutumnAdapter` — so the
 * provider-agnostic path stays generic and only Autumn apps reach for them. The public `client` is
 * the small structural {@link AutumnFeaturesClientLike} (a real `autumn-js` `Autumn` instance
 * satisfies it, no cast); internally it is used as the real `Autumn` so calls are checked against
 * the SDK. It is resource-based — `billing.attach`, `entities.*`, `events.*`, `plans.list`,
 * `referrals.*` — and every call takes a single camelCase params object. Share the same underlying
 * `Autumn` client between this facade and `createAutumnAdapter`.
 *
 * SECURITY: unlike the `ctx.payments` facade, these methods do **not** authorize the caller — each
 * takes the `referenceId` (and `entityId`) positionally and trusts it. Before exposing any of them on
 * a request handler, check that the caller owns the reference by matching it against the
 * authenticated user; forwarding an unvalidated reference from the request is an app-layer IDOR. // secret-scanner:allow -- prose only, no secret
 *
 * Credit systems need no method here — Autumn models them as features, so credit balances flow
 * through the adapter's `checkEntitlement` / `getBalances` like any other feature.
 */
import type { Autumn } from "autumn-js";

import { asRecord, readNumber, readString } from "../json";

/**
 * A per-seat / per-workspace sub-customer with its own feature balances.
 * @experimental
 */
interface AutumnEntity {
    readonly featureId?: string;
    readonly id: string;
    readonly name?: string;
    /** The raw provider record, for fields this facade does not normalize. */
    readonly raw: Record<string, unknown>;
}

/**
 * `CreateEntityInput` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
interface CreateEntityInput {
    /** The feature the entity consumes a seat/allowance of (e.g. `"seats"`). */
    readonly featureId: string;
    /** Caller-chosen stable id — Autumn requires an entity id on create. */
    readonly id: string;
    readonly name?: string;
}

/**
 * One point in a usage-events aggregation.
 * @experimental
 */
interface UsageEventPoint {
    readonly count: number;
    readonly period?: string;
    readonly raw: Record<string, unknown>;
}

/**
 * `EventsListInput` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
interface EventsListInput {
    /** Feature(s) to report on. */
    readonly featureId: ReadonlyArray<string> | string;
}

/**
 * `EventsAggregateInput` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
interface EventsAggregateInput extends EventsListInput {
    /** Time window to aggregate over (aggregate only — `list` ignores it, so it isn't accepted there). */
    readonly range?: "7d" | "24h" | "30d" | "90d" | "last_cycle";
}

/**
 * A prepaid feature quantity purchased at checkout (e.g. buy 5 seats up front).
 * @experimental
 */
interface PrepaidOption {
    readonly featureId: string;
    readonly quantity: number;
}

/**
 * Autumn-native checkout — richer than the generic `createCheckout` (trials, prepaid, entities, rewards).
 * @experimental
 */
interface AutumnCheckoutInput {
    /** Scope the checkout to a specific entity (seat/workspace) rather than the top-level customer. */
    readonly entityId?: string;

    /**
     * Autumn applies a plan's configured free trial automatically. Pass `false` to opt out of that
     * trial for this checkout; leave unset (or `true`) to keep the plan default.
     */
    readonly freeTrial?: boolean;
    /** Prepaid feature quantities to purchase up front. */
    readonly options?: ReadonlyArray<PrepaidOption>;
    /** The plan to attach (Autumn's plan id — the successor to the classic "product" id). */
    readonly planId: string;
    /** An Autumn reward id to apply as a discount. */
    readonly reward?: string;
    readonly successUrl?: string;
}

/**
 * The subset of the Autumn SDK surface the native facade calls. A real `Autumn` instance satisfies it.
 * @experimental
 */
interface AutumnFeaturesClientLike {
    readonly billing: unknown;
    readonly entities: unknown;
    readonly events: unknown;
    readonly plans: unknown;
    readonly referrals: unknown;
}

/**
 * `AutumnFeaturesOptions` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
interface AutumnFeaturesOptions {
    readonly client: AutumnFeaturesClientLike;
}

/** The SDK's `featureId` param is `string | string[]` (mutable); copy the readonly input into it. */
const toFeatureId = (featureId: ReadonlyArray<string> | string): string | string[] => (typeof featureId === "string" ? featureId : [...featureId]);

const entityFrom = (record: Record<string, unknown>): AutumnEntity => {
    return {
        featureId: readString(record, "featureId") ?? readString(record, "feature_id"),
        id: readString(record, "id") ?? "",
        name: readString(record, "name"),
        raw: record,
    };
};

/** Autumn returns the rows under `list` (aggregate/list responses); normalize to points. */
const pointsFrom = (result: Record<string, unknown>): UsageEventPoint[] => {
    const list = result.list ?? result.data ?? result.events;
    const rows = Array.isArray(list) ? list : [];

    return rows.map((entry) => {
        const record = asRecord(entry);

        return { count: readNumber(record, "count") ?? readNumber(record, "value") ?? 0, period: readString(record, "period"), raw: record };
    });
};

/**
 * The Autumn-native feature facade returned by {@link createAutumnFeatures}.
 * @experimental
 */
interface AutumnFeatures {
    readonly checkout: (referenceId: string, input: AutumnCheckoutInput) => Promise<{ raw: Record<string, unknown>; url: string }>;
    readonly entities: {
        readonly create: (referenceId: string, input: CreateEntityInput) => Promise<AutumnEntity>;
        readonly delete: (referenceId: string, entityId: string) => Promise<void>;
        readonly get: (referenceId: string, entityId: string) => Promise<AutumnEntity>;
    };
    readonly events: {
        readonly aggregate: (referenceId: string, input: EventsAggregateInput) => Promise<UsageEventPoint[]>;
        readonly list: (referenceId: string, input: EventsListInput) => Promise<UsageEventPoint[]>;
    };
    readonly plans: {
        readonly list: () => Promise<Record<string, unknown>[]>;
    };
    readonly referrals: {
        readonly createCode: (referenceId: string, programId: string) => Promise<{ code: string; raw: Record<string, unknown> }>;
        readonly redeemCode: (referenceId: string, code: string) => Promise<Record<string, unknown>>;
    };
}

/**
 * Build the Autumn-native feature facade over an injected client. Companion to `createAutumnAdapter`;
 * share the same underlying `autumn-js` `Autumn` client between them.
 * @experimental
 */
export const createAutumnFeatures = (options: AutumnFeaturesOptions): AutumnFeatures => {
    // Public param is the tiny structural shim; internally it is the real SDK so calls are checked.
    const client = options.client as unknown as Autumn;

    return {
        /**
         * Native Autumn checkout — supports opting out of a plan's free trial, prepaid feature
         * quantities, entity scoping, and reward codes. Returns the hosted checkout URL (empty when
         * Autumn applied the change directly without a payment step).
         */
        checkout: async (referenceId: string, input: AutumnCheckoutInput): Promise<{ raw: Record<string, unknown>; url: string }> => {
            const result = asRecord(
                await client.billing.attach({
                    customerId: referenceId,
                    // Autumn applies the plan's configured trial by default; `null` opts this checkout out.
                    // eslint-disable-next-line unicorn/no-null -- the SDK's customize.freeTrial requires null (not undefined) to disable
                    ...(input.freeTrial === false ? { customize: { freeTrial: null } } : {}),
                    discounts: input.reward ? [{ rewardId: input.reward }] : undefined,
                    entityId: input.entityId,
                    featureQuantities: input.options?.map((option) => {
                        return { featureId: option.featureId, quantity: option.quantity };
                    }),
                    planId: input.planId,
                    successUrl: input.successUrl,
                }),
            );
            const url = readString(result, "paymentUrl") ?? readString(result, "checkoutUrl") ?? readString(result, "url") ?? "";

            return { raw: result, url };
        },

        entities: {
            /** Create a per-seat / per-workspace sub-customer under a reference. */
            create: async (referenceId: string, input: CreateEntityInput): Promise<AutumnEntity> => {
                const created = await client.entities.create({ customerId: referenceId, entityId: input.id, featureId: input.featureId, name: input.name });

                return entityFrom(asRecord(created));
            },

            /** Remove an entity — frees its seat/allowance. */
            delete: async (referenceId: string, entityId: string): Promise<void> => {
                await client.entities.delete({ customerId: referenceId, entityId });
            },

            /** Fetch one entity and its balances. */
            get: async (referenceId: string, entityId: string): Promise<AutumnEntity> => {
                const entity = await client.entities.get({ customerId: referenceId, entityId });

                return entityFrom(asRecord(entity));
            },
        },

        events: {
            /** Bucketed usage aggregation for a reference's feature(s) over a range. */
            aggregate: async (referenceId: string, input: EventsAggregateInput): Promise<UsageEventPoint[]> => {
                const result = await client.events.aggregate({ customerId: referenceId, featureId: toFeatureId(input.featureId), range: input.range });

                return pointsFrom(asRecord(result));
            },

            /** Raw usage events for a reference's feature(s). */
            list: async (referenceId: string, input: EventsListInput): Promise<UsageEventPoint[]> => {
                const result = await client.events.list({ customerId: referenceId, featureId: toFeatureId(input.featureId) });

                return pointsFrom(asRecord(result));
            },
        },

        plans: {
            /** The configured plan catalog. */
            list: async (): Promise<Record<string, unknown>[]> => {
                const result = asRecord(await client.plans.list());
                const list = result.list ?? result.data ?? result.plans;

                return Array.isArray(list) ? list.map((entry) => asRecord(entry)) : [];
            },
        },

        referrals: {
            /** Mint (or fetch) a referral code for a reference in a referral program. */
            createCode: async (referenceId: string, programId: string): Promise<{ code: string; raw: Record<string, unknown> }> => {
                const result = asRecord(await client.referrals.createCode({ customerId: referenceId, programId }));

                return { code: readString(result, "code") ?? "", raw: result };
            },

            /** Redeem a referral code on behalf of a reference. */
            redeemCode: async (referenceId: string, code: string): Promise<Record<string, unknown>> =>
                asRecord(await client.referrals.redeemCode({ code, customerId: referenceId })),
        },
    };
};

export type {
    AutumnCheckoutInput,
    AutumnEntity,
    AutumnFeatures,
    AutumnFeaturesClientLike,
    AutumnFeaturesOptions,
    CreateEntityInput,
    EventsAggregateInput,
    EventsListInput,
    PrepaidOption,
    UsageEventPoint,
};
