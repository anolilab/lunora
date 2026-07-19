/**
 * Build a payment facade from a Lunora function context.
 *
 * This is what codegen wires `ctx.payments` to: the store rides the request's `ctx.db` (the app's
 * ShardDO), and authorization defaults to "the caller may only act on their own `userId`" — apps
 * keyed on org/workspace references pass a custom `authorize`. Adapters carry secrets, so the
 * adapter is supplied by the caller (typically from a `config.payment(env)` thunk).
 */
import type { PaymentAdapter } from "./adapter";
import type { AuthorizeReference, LunoraPayment } from "./create-payment";
import { createPayment } from "./create-payment";
import type { PaymentDatabase, PaymentRow } from "./database-store";
import { createDatabasePaymentStore } from "./database-store";
import type { EntitlementsConfig } from "./entitlements";
import type { PaymentObserver } from "./observability";

/**
 * Structural subset of Lunora's `ctx.db` (the `findFirst`/`findMany(tableName, { where })` form).
 * @experimental
 */
export interface LunoraDatabaseLike {
    delete: (id: string) => Promise<void>;
    findFirst: (table: string, args?: { where?: Record<string, unknown> }) => Promise<Record<string, unknown> | null>;
    findMany: (table: string, args?: { where?: Record<string, unknown> }) => Promise<{ page: Record<string, unknown>[] }>;
    insert: (table: string, document: Record<string, unknown>) => Promise<string>;
    patch: (id: string, patch: Record<string, unknown>) => Promise<void>;
}

/**
 * Structural subset of a Lunora function context used to build payments.
 * @experimental
 */
export interface PaymentContextLike {
    auth?: { userId?: null | string };
    db: LunoraDatabaseLike;
}

/**
 * `PaymentsFromContextOptions` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
export interface PaymentsFromContextOptions {
    readonly adapter: PaymentAdapter;
    /** Override the default "caller owns the referenceId" authorization. */
    readonly authorize?: AuthorizeReference;
    /** Plan → features/limits map, forwarded to the facade. Required to use `ctx.payments.check`. */
    readonly entitlements?: EntitlementsConfig;
    /** Optional telemetry sink, forwarded to the facade. */
    readonly observability?: PaymentObserver;
}

/**
 * Adapt a Lunora `ctx.db` to the {@link PaymentDatabase} port the store writes through.
 * @experimental
 */
export const lunoraDatabaseToPaymentDatabase = (database: LunoraDatabaseLike): PaymentDatabase => {
    return {
        delete: async (id) => database.delete(id),
        findFirst: async (table, where) => (await database.findFirst(table, { where })) as PaymentRow | null,
        findMany: async (table, where) => {
            const result = await database.findMany(table, { where });

            return result.page as PaymentRow[];
        },
        insert: async (table, document) => database.insert(table, document),
        patch: async (id, patch) => database.patch(id, patch),
    };
};

/**
 * `paymentsFromContext` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
export const paymentsFromContext = (context: PaymentContextLike, options: PaymentsFromContextOptions): LunoraPayment => {
    // Normalize any falsy identity (null/undefined/empty string) to `undefined` so a falsy-but-present
    // principal can never match an empty/orphan `referenceId`.
    const userId = context.auth?.userId ?? undefined;

    return createPayment({
        adapter: options.adapter,
        // The default authorizer fails closed on an empty/whitespace reference: a missing identity or a
        // blank reference (e.g. webhook-orphaned rows with `referenceId: ""`) is never authorized.
        authorize: options.authorize ?? ((referenceId) => referenceId.trim() !== "" && userId !== undefined && referenceId === userId),
        entitlements: options.entitlements,
        observability: options.observability,
        store: createDatabasePaymentStore(lunoraDatabaseToPaymentDatabase(context.db)),
    });
};
