/**
 * Build a payment facade from a Lunora function context.
 *
 * This is what codegen wires `ctx.payments` to: the store rides the request's `ctx.db` (the app's
 * ShardDO), and authorization defaults to "the caller may only act on their own `userId`" — apps
 * keyed on org/workspace references pass a custom `authorize`, which receives the caller's `userId`
 * and the request's `db` (e.g. to check the caller is an owner/admin of the org being billed).
 * Adapters carry secrets, so the adapter is supplied by the caller (typically from a
 * `config.payment(env)` thunk).
 */
import type { PaymentAdapter } from "./adapter";
import type { LunoraPayment } from "./create-payment";
import { createPayment } from "./create-payment";
import type { PaymentDatabase, PaymentRow } from "./database-store";
import { createDatabasePaymentStore } from "./database-store";
import type { EntitlementsConfig } from "./entitlements";
import type { PaymentObserver } from "./observability";

/**
 * Structural subset of Lunora's `ctx.db` (the `findFirst`/`findMany(tableName, { where })` form).
 *
 * `findMany` models the order/limit/cursor knobs too — {@link PaymentDatabase}
 * pushes them down so a sweep over a large match set reads bounded chunks
 * instead of materialising the lot. `continueCursor` is REQUIRED here (`ctx.db`
 * always returns it): a double that omitted it would page exactly once and then
 * silently report the rest of the table as absent.
 * @experimental
 */
export interface LunoraDatabaseLike {
    delete: (id: string) => Promise<void>;
    findFirst: (table: string, args?: { where?: Record<string, unknown> }) => Promise<Record<string, unknown> | null>;
    findMany: (
        table: string,
        args?: { cursor?: string; limit?: number; orderBy?: Record<string, "asc" | "desc">[]; where?: Record<string, unknown> },
    ) => Promise<{ continueCursor: null | string; page: Record<string, unknown>[] }>;
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
 * Returns whether the caller may act on `referenceId`, given who they are and the request's `db`.
 * Throwing is treated as denial. `userId` is `undefined` for an unauthenticated caller.
 * @experimental
 */
export type AuthorizeContextReference = (
    referenceId: string,
    caller: { readonly db: LunoraDatabaseLike; readonly userId: string | undefined },
) => boolean | Promise<boolean>;

/**
 * `PaymentsFromContextOptions` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
export interface PaymentsFromContextOptions {
    readonly adapter: PaymentAdapter;
    /** Override the default "caller owns the referenceId" authorization. */
    readonly authorize?: AuthorizeContextReference;
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
        findMany: async (table, where, page) => {
            const result = await database.findMany(table, { ...page, where });

            return { cursor: result.continueCursor ?? undefined, rows: result.page as PaymentRow[] };
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
    const userId = context.auth?.userId;
    const { authorize } = options;
    // A blank identity is unauthenticated, for the default rule and an app's alike — otherwise
    // `referenceId === userId` would match every orphaned (`""`) row.
    const caller = { db: context.db, userId: userId?.trim() ? userId : undefined };

    return createPayment({
        adapter: options.adapter,
        authorize: authorize ? (referenceId) => authorize(referenceId, caller) : (referenceId) => caller.userId !== undefined && referenceId === caller.userId,
        entitlements: options.entitlements,
        observability: options.observability,
        store: createDatabasePaymentStore(lunoraDatabaseToPaymentDatabase(context.db)),
    });
};
