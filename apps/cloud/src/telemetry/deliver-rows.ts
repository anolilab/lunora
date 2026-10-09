/**
 * Send fired `alerts` rows and stamp each one `delivered` or `failed`.
 *
 * Shared by every sweep that delivers (the drain, uptime, metric, anomaly).
 * An `email` row addressed to {@link ORG_ADMINS_DESTINATION} is resolved here,
 * per row, from the organization it belongs to: the mutation that raised it
 * could not read the auth plane, and membership may have changed since.
 */
import type { ControlPlaneStore } from "../d1-store";
import type { ControlPlaneDatabase } from "../store";
import type { AlertDelivery } from "./alerts";
import { ORG_ADMINS_DESTINATION } from "./recipients";

/** How rows are sent and "owners & admins" resolved; the sweeps pass the real mailer and auth plane. */
export interface DeliverRowsDeps {
    adminEmails: (organizationId: string) => Promise<string[]>;
    deliver: (delivery: AlertDelivery, recipients?: ReadonlyArray<string>) => Promise<void>;
}

/** The owners' and admins' addresses for one `alerts` row; empty when the row or its organization cannot be read. */
const recipientsOf = async (database: ControlPlaneDatabase, delivery: AlertDelivery, deps: DeliverRowsDeps): Promise<string[]> => {
    const row = (await (database as ControlPlaneStore).get(delivery.id, "alerts").catch(() => null)) as null | { organizationId?: string };

    return row?.organizationId === undefined ? [] : deps.adminEmails(row.organizationId).catch(() => []);
};

export const deliverAlertRows = async (
    database: ControlPlaneDatabase,
    deliveries: ReadonlyArray<AlertDelivery>,
    now: number,
    deps: DeliverRowsDeps,
): Promise<void> => {
    await Promise.all(
        deliveries.map(async (delivery) => {
            const recipients =
                delivery.channel === "email" && delivery.destination === ORG_ADMINS_DESTINATION ? await recipientsOf(database, delivery, deps) : undefined;
            const delivered = await deps.deliver(delivery, recipients).then(
                () => true,
                () => false,
            );

            await database
                .patch(delivery.id, { ...(delivered ? { deliveredAt: now } : {}), status: delivered ? "delivered" : "failed", updatedAt: now }, "alerts")
                .catch(() => undefined);
        }),
    );
};
