/**
 * The Notifications API calls behind Cloudflare usage alerts on a connected
 * account (`lunora/cloudflare-alerts.ts`): read what the account offers and
 * holds, and write the Lunora-managed policies. The account's own API, like
 * its cost overview (`./costs.ts`) — so the REST port is reached from here, not
 * from the functions.
 */
import { LunoraError } from "@lunora/server";

import type { BillingProduct, NotificationPolicy, NotificationsClient, NotificationsFailure } from "../cloudflare/notifications";
import { CloudflareNotificationsError, notificationsClient } from "../cloudflare/notifications";
import type { AccountAccess } from "./store";
import type { PolicyWrite } from "./usage-alerts";
import { discoverProducts, planPolicyWrites } from "./usage-alerts";

/** What reading an account's notifications found, or why it could not. */
export type AlertsRead =
    { kind: NotificationsFailure; message: string; ok: false } | { listed: BillingProduct[] | null; ok: true; policies: NotificationPolicy[] };

/** One product's outcome. */
export interface AlertWriteResult {
    action: "created" | "failed" | "updated";
    kind: NotificationsFailure | null;
    message: null | string;
    productId: string;
}

const clientFor = (access: AccountAccess, fetch: typeof globalThis.fetch): NotificationsClient => notificationsClient({ ...access, fetch });

/** The products the account's Usage Based Billing alert lists, and its policies. Never throws for a Cloudflare failure. */
export const readAccountAlerts = async (access: AccountAccess, fetch: typeof globalThis.fetch): Promise<AlertsRead> => {
    const client = clientFor(access, fetch);

    try {
        const [listed, policies] = await Promise.all([client.billingProducts(), client.listPolicies()]);

        return { listed, ok: true, policies };
    } catch (error) {
        if (error instanceof CloudflareNotificationsError) {
            return { kind: error.kind, message: error.message, ok: false };
        }

        throw error;
    }
};

/** Perform one write. A Cloudflare refusal is an outcome, not a throw. */
const writeOne = async (client: NotificationsClient, write: PolicyWrite): Promise<AlertWriteResult | CloudflareNotificationsError> => {
    try {
        if (write.policyId === undefined) {
            await client.createPolicy(write.body);

            return { action: "created", kind: null, message: null, productId: write.productId };
        }

        await client.updatePolicy(write.policyId, write.body);

        return { action: "updated", kind: null, message: null, productId: write.productId };
    } catch (error) {
        if (error instanceof CloudflareNotificationsError) {
            return error;
        }

        throw error;
    }
};

const failed = (productId: string, error: CloudflareNotificationsError): AlertWriteResult => {
    return { action: "failed", kind: error.kind, message: error.message, productId };
};

/**
 * Write one managed policy per requested product, one at a time. Only product
 * ids the account lists (or already stores on a policy) are accepted.
 * @throws {LunoraError} `BAD_REQUEST` naming any product Cloudflare does not list, before anything is written.
 */
export const writeAccountAlerts = async (
    access: AccountAccess,
    fetch: typeof globalThis.fetch,
    products: ReadonlyArray<{ id: string; limit: number }>,
    recipients: ReadonlyArray<string>,
): Promise<AlertWriteResult[]> => {
    const client = clientFor(access, fetch);
    const read = await readAccountAlerts(access, fetch);

    if (!read.ok) {
        const error = new CloudflareNotificationsError(read.kind, read.message, null);

        return products.map((product) => failed(product.id, error));
    }

    const byId = new Map(discoverProducts(read.listed, read.policies).map((product) => [product.id, product]));
    const unknown = products.filter((product) => !byId.has(product.id)).map((product) => product.id);

    if (unknown.length > 0) {
        throw new LunoraError("BAD_REQUEST", `Cloudflare does not list ${unknown.join(", ")} as a Usage Based Billing product on this account`);
    }

    const writes = planPolicyWrites(
        products.map((product) => {
            return { limit: product.limit, product: byId.get(product.id) as BillingProduct };
        }),
        read.policies,
        recipients,
    );
    const results: AlertWriteResult[] = [];
    let blocked: CloudflareNotificationsError | null = null;

    for (const write of writes) {
        // A refused token or an ineligible account refuses every write alike, so the first refusal stops the rest.
        // eslint-disable-next-line no-await-in-loop -- one write at a time, so a refusal stops the rest
        const outcome: AlertWriteResult | CloudflareNotificationsError = blocked ?? (await writeOne(client, write));

        if (outcome instanceof CloudflareNotificationsError) {
            blocked = outcome.kind === "missing-scope" || outcome.kind === "not-eligible" ? outcome : blocked;
            results.push(failed(write.productId, outcome));
        } else {
            results.push(outcome);
        }
    }

    return results;
};
