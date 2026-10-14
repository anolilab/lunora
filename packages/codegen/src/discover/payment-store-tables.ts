import type { TableIR } from "../ir";

/**
 * Signature columns of the `@lunora/payment` store's two panel-read tables,
 * merged into the app by `.extend(paymentExtension)` as `payment_subscriptions`
 * and `payment_events`. Checked alongside the names so an app table that merely
 * shares a name does not show the panel.
 *
 * `providerSubscriptionId` + `state` are the subscription store's discriminators;
 * `providerEventId` + `processedAt` are the webhook-log's.
 */
const PAYMENT_SUBSCRIPTION_COLUMNS = ["providerSubscriptionId", "state"] as const;
const PAYMENT_EVENTS_COLUMNS = ["providerEventId", "processedAt"] as const;

const tableHasColumns = (table: TableIR, columns: ReadonlyArray<string>): boolean => columns.every((column) => column in table.shape);

/**
 * `true` when the schema merges the `@lunora/payment` store's
 * `payment_subscriptions` and `payment_events` tables, carrying their
 * {@link PAYMENT_SUBSCRIPTION_COLUMNS} / {@link PAYMENT_EVENTS_COLUMNS}.
 */
const hasPaymentStoreTables = (tables: ReadonlyArray<TableIR>): boolean => {
    const subscriptions = tables.find((table) => table.name === "payment_subscriptions");
    const events = tables.find((table) => table.name === "payment_events");

    return (
        subscriptions !== undefined &&
        events !== undefined &&
        tableHasColumns(subscriptions, PAYMENT_SUBSCRIPTION_COLUMNS) &&
        tableHasColumns(events, PAYMENT_EVENTS_COLUMNS)
    );
};

export default hasPaymentStoreTables;
