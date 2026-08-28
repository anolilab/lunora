import type { TableIR } from "../ir";

/**
 * Signature columns that identify the `@lunora/payment` store's two panel-read
 * tables by their *shape*, not their (generic) names. An app declares these
 * tables inline in its `lunora/schema.ts` (codegen can't resolve `@lunora/payment`'s
 * cross-package `...paymentTables` spread), mirroring the canonical columns the
 * store reads/writes — so any real payment store carries these columns, while an
 * unrelated newsletter `subscriptions` table or a domain `events` table does not.
 *
 * `providerSubscriptionId` + `state` are the subscription store's discriminators;
 * `providerEventId` + `processedAt` are the webhook-log's. This is the "real
 * payment signal" the panel gates on — the old bare-name probe (`subscriptions`
 * AND `events` present) false-positived on those generic names.
 */
const PAYMENT_SUBSCRIPTION_COLUMNS = ["providerSubscriptionId", "state"] as const;
const PAYMENT_EVENTS_COLUMNS = ["providerEventId", "processedAt"] as const;

const tableHasColumns = (table: TableIR, columns: ReadonlyArray<string>): boolean => columns.every((column) => column in table.shape);

/**
 * `true` when the schema declares the `@lunora/payment` store's `subscriptions`
 * and `events` tables — matched by their {@link PAYMENT_SUBSCRIPTION_COLUMNS} /
 * {@link PAYMENT_EVENTS_COLUMNS} signature columns rather than their names alone,
 * so it fires on a genuine payment store (which mirrors the canonical columns —
 * back-compatible with older schemas) and not on a coincidentally-named table.
 */
const hasPaymentStoreTables = (tables: ReadonlyArray<TableIR>): boolean => {
    const subscriptions = tables.find((table) => table.name === "subscriptions");
    const events = tables.find((table) => table.name === "events");

    return (
        subscriptions !== undefined &&
        events !== undefined &&
        tableHasColumns(subscriptions, PAYMENT_SUBSCRIPTION_COLUMNS) &&
        tableHasColumns(events, PAYMENT_EVENTS_COLUMNS)
    );
};

export default hasPaymentStoreTables;
