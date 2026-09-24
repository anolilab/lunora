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
    // Narrow `null | string | undefined` to `string | undefined` — this only folds `null` into
    // `undefined`. It does NOT normalize an empty string: `"" ?? undefined` is `""`. What stops a
    // blank principal from matching an empty/orphan `referenceId` is the `referenceId.trim() !== ""`
    // clause in the default authorizer below, so do not drop that clause on the strength of this line.
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
