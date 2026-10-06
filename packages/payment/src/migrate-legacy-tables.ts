import type { LunoraDatabaseLike } from "./context";
import { PAYMENT_TABLES } from "./database-store";

/**
 * Each legacy inline table, the `paymentExtension` table it moves to, and the natural unique key
 * that identifies a row in both — what makes a re-run (or a row the store already wrote to the new
 * table) a skip instead of a duplicate.
 */
const LEGACY_TABLES: ReadonlyArray<{ readonly from: string; readonly key: ReadonlyArray<string>; readonly to: string }> = [
    { from: "customers", key: ["provider", "providerCustomerId"], to: PAYMENT_TABLES.customers },
    { from: "events", key: ["provider", "providerEventId"], to: PAYMENT_TABLES.events },
    { from: "paymentSessions", key: ["provider", "providerSessionId"], to: PAYMENT_TABLES.sessions },
    { from: "subscriptions", key: ["provider", "providerSubscriptionId"], to: PAYMENT_TABLES.subscriptions },
    { from: "usageEvents", key: ["provider", "idempotencyKey"], to: PAYMENT_TABLES.usageEvents },
];

const DEFAULT_BATCH_SIZE = 100;

const SYSTEM_FIELDS = new Set(["_creationTime", "_id"]);

const moveRow = async (database: LunoraDatabaseLike, row: Record<string, unknown>, key: ReadonlyArray<string>, to: string): Promise<void> => {
    const document = Object.fromEntries(Object.entries(row).filter(([field]) => !SYSTEM_FIELDS.has(field)));
    const where = Object.fromEntries(key.map((field) => [field, document[field]]));

    if ((await database.findFirst(to, { where })) === null) {
        await database.insert(to, document);
    }

    await database.delete(row["_id"] as string);
};

/**
 * Move rows from the inline payment tables an app declared before `paymentExtension`
 * (`customers`, `events`, `paymentSessions`, `subscriptions`, `usageEvents`) into the extension's
 * `payment_*` tables. Each legacy row is copied (minus `_id` / `_creationTime`) and then deleted;
 * a row whose natural key already exists in the target is not copied again, only deleted.
 *
 * Moves at most `batchSize` rows (default 100) per call, so it fits one mutation. Call it from an
 * `internalMutation` until `remaining` is `false`. It reads the legacy tables, so the app must still
 * declare them inline — delete them from `lunora/schema.ts` only once it reports `remaining: false`.
 *
 * `migrateLegacyPaymentTables` is part of the experimental `@lunora/payment` API and may change without a major version bump.
 * @experimental
 */
const migrateLegacyPaymentTables = async (
    database: LunoraDatabaseLike,
    options: { batchSize?: number } = {},
): Promise<{ moved: number; remaining: boolean }> => {
    let budget = options.batchSize ?? DEFAULT_BATCH_SIZE;
    let moved = 0;

    for (const { from, key, to } of LEGACY_TABLES) {
        if (budget <= 0) {
            break;
        }

        // No cursor: every row read is deleted below, so the next call starts at what is left.
        // eslint-disable-next-line no-await-in-loop -- the budget left for this table is only known once the previous one is done
        const { page } = await database.findMany(from, { limit: budget });

        for (const row of page) {
            // eslint-disable-next-line no-await-in-loop -- serial on purpose: one transaction's writes, each row's key check must see the last insert
            await moveRow(database, row, key, to);
        }

        moved += page.length;
        budget -= page.length;
    }

    if (budget > 0) {
        // Every table returned fewer rows than asked for, so every table is empty.
        return { moved, remaining: false };
    }

    // A spent budget says nothing about what is left; probe rather than make the caller run once more.
    const leftovers = await Promise.all(LEGACY_TABLES.map(async ({ from }) => database.findFirst(from)));

    return { moved, remaining: leftovers.some((row) => row !== null) };
};

export default migrateLegacyPaymentTables;
