/**
 * The Notifications API calls behind Cloudflare usage alerts on a connected
 * account (`lunora/cloudflare-alerts.ts`): read what the account offers and
 * holds, write the Lunora-managed policies and read back what Cloudflare
 * stored, and remove them. The account's own API, like its cost overview
 * (`./costs.ts`) — so the REST port is reached from here, not from the
 * functions.
 */
import { LunoraError } from "@lunora/server";

import type { BillingProduct, NotificationPolicy, NotificationsClient, NotificationsFailure } from "../cloudflare/notifications";
import { CloudflareNotificationsError, notificationsClient } from "../cloudflare/notifications";
import type { AccountAccess } from "./store";
import type { PolicyWrite, ProductSource } from "./usage-alerts";
import { discoverProducts, isManagedPolicy, planPolicyWrites } from "./usage-alerts";

/** What reading an account's notifications found, or why it could not. */
export type AlertsRead =
    { kind: NotificationsFailure; message: string; ok: false } | { listed: BillingProduct[] | null; ok: true; policies: NotificationPolicy[] };

/** What Cloudflare holds for one managed policy after a write: read back, not assumed. */
export interface StoredPolicy {
    destinations: number;
    enabled: boolean;
    limit: null | string;
    policyId: string;
    recipients: string[];
}

/** One product's outcome. */
export interface AlertWriteResult {
    action: "created" | "failed" | "updated";
    duplicates: number;
    keptDestinations: number;
    keptRecipients: string[];
    kind: NotificationsFailure | null;
    message: null | string;
    productId: string;
    /** What Cloudflare stored for the product's managed policies, read back after the write; empty when the read failed. */
    stored: StoredPolicy[];
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
const writeOne = async (client: NotificationsClient, write: PolicyWrite): Promise<CloudflareNotificationsError | null> => {
    try {
        await (write.policyId === undefined ? client.createPolicy(write.body) : client.updatePolicy(write.policyId, write.body));

        return null;
    } catch (error) {
        if (error instanceof CloudflareNotificationsError) {
            return error;
        }

        throw error;
    }
};

const storedOf = (policy: NotificationPolicy): StoredPolicy => {
    const limits = policy.filters["limit"] ?? [];

    return {
        destinations: Object.entries(policy.mechanisms)
            .filter(([kind]) => kind !== "email")
            .reduce((sum, [, entries]) => sum + entries.length, 0),
        enabled: policy.enabled,
        limit: limits.length === 1 ? (limits[0] ?? null) : null,
        policyId: policy.id,
        recipients: (policy.mechanisms["email"] ?? []).map((entry) => entry.id),
    };
};

/** The managed policies of each product, as Cloudflare now holds them; an empty map when the read-back fails. */
const readBack = async (client: NotificationsClient): Promise<Map<string, StoredPolicy[]>> => {
    const stored = new Map<string, StoredPolicy[]>();

    try {
        const policies = await client.listPolicies();

        for (const policy of policies.filter((entry) => isManagedPolicy(entry))) {
            for (const product of policy.filters["product"] ?? []) {
                stored.set(product, [...(stored.get(product) ?? []), storedOf(policy)]);
            }
        }
    } catch (error) {
        if (!(error instanceof CloudflareNotificationsError)) {
            throw error;
        }
    }

    return stored;
};

/** The products a setup may name: what the account lists or stores, and the published ids. */
export const knownProducts = (read: Extract<AlertsRead, { ok: true }>): { products: BillingProduct[]; source: ProductSource } =>
    discoverProducts(read.listed, read.policies);

/**
 * Write the managed policies of each requested product, one at a time, then
 * read back what Cloudflare stored. Only products the account lists, already
 * stores, or Cloudflare publishes are accepted.
 * @throws {LunoraError} `BAD_REQUEST` naming any other product, before anything is written.
 */
export const writeAccountAlerts = async (
    access: AccountAccess,
    fetch: typeof globalThis.fetch,
    products: ReadonlyArray<{ id: string; limit: number }>,
    recipients: ReadonlyArray<string>,
): Promise<AlertWriteResult[]> => {
    const client = clientFor(access, fetch);
    const read = await readAccountAlerts(access, fetch);
    const empty = { duplicates: 0, keptDestinations: 0, keptRecipients: [], stored: [] };

    if (!read.ok) {
        return products.map((product) => {
            return { ...empty, action: "failed", kind: read.kind, message: read.message, productId: product.id };
        });
    }

    const byId = new Map(knownProducts(read).products.map((product) => [product.id, product]));
    const unknown = products.filter((product) => !byId.has(product.id)).map((product) => product.id);

    if (unknown.length > 0) {
        throw new LunoraError("BAD_REQUEST", `${unknown.join(", ")} is not a Usage Based Billing product Cloudflare lists or publishes`);
    }

    const plans = planPolicyWrites(
        products.map((product) => {
            return { limit: product.limit, product: byId.get(product.id) as BillingProduct };
        }),
        read.policies,
        recipients,
    );
    const outcomes: Omit<AlertWriteResult, "stored">[] = [];
    let blocked: CloudflareNotificationsError | null = null;

    for (const plan of plans) {
        let failure: CloudflareNotificationsError | null = blocked;

        for (const write of plan.writes) {
            // A refused token or an ineligible account refuses every write alike, so the first refusal stops the rest.
            // eslint-disable-next-line no-await-in-loop -- one write at a time, so a refusal stops the rest
            failure ??= await writeOne(client, write);
        }

        if (failure !== null && (failure.kind === "missing-scope" || failure.kind === "not-eligible")) {
            blocked = failure;
        }

        const { duplicates, keptDestinations, keptRecipients, productId } = plan;
        const written = plan.writes[0]?.policyId === undefined ? "created" : "updated";

        outcomes.push({
            action: failure === null ? written : "failed",
            duplicates,
            keptDestinations,
            keptRecipients,
            kind: failure?.kind ?? null,
            message: failure?.message ?? null,
            productId,
        });
    }

    const stored = await readBack(client);

    return outcomes.map((outcome) => {
        return { ...outcome, stored: stored.get(outcome.productId) ?? [] };
    });
};

/** What removing the managed policies did. */
export interface AlertRemoval {
    failed: { message: string; policyId: string }[];
    removed: string[];
}

/**
 * Delete every Lunora-managed policy on the account — the customer's own are
 * never touched.
 * @throws {LunoraError} when the policies cannot be listed: nothing is deleted on a partial view.
 */
export const removeAccountAlerts = async (access: AccountAccess, fetch: typeof globalThis.fetch): Promise<AlertRemoval> => {
    const client = clientFor(access, fetch);
    const read = await readAccountAlerts(access, fetch);

    if (!read.ok) {
        throw new LunoraError("BAD_REQUEST", read.message);
    }

    const removal: AlertRemoval = { failed: [], removed: [] };

    for (const policy of read.policies.filter((entry) => isManagedPolicy(entry))) {
        try {
            // eslint-disable-next-line no-await-in-loop -- one delete at a time keeps a refusal readable
            await client.deletePolicy(policy.id);
            removal.removed.push(policy.name);
        } catch (error) {
            if (!(error instanceof CloudflareNotificationsError)) {
                throw error;
            }

            removal.failed.push({ message: error.message, policyId: policy.id });
        }
    }

    return removal;
};
