/**
 * A connected Cloudflare account's real spend (the Cloudflare costs tab): its
 * Billable Usage API, read with the account's own token — the same connection
 * the `cloudflare-workers` target deploys with, when it was granted Billing
 * Read (the `billing` permission group). Distinct from the control
 * plane's ESTIMATE (`src/billing/spend.ts`).
 *
 * Fails OPEN to a status: a token without the permission, an absent master
 * key, a refused token or any read failure each answers its own status with no
 * view, so the tab never errors and the token never surfaces.
 */
import type { CloudflareCostView } from "../cloudflare/billable-usage";
import { fetchBillableUsage, normalizeBillableUsage } from "../cloudflare/billable-usage";
import { CloudflareTokenError } from "../cloudflare/fetch";
import type { CloudflareAccountRow } from "./store";
import { holds, unsealAccount } from "./store";

/** How a cost read resolved — the studio renders a distinct state per status. */
export type AccountCostsStatus = "error" | "no-permission" | "ok" | "unauthorized" | "unconfigured";

/** A cost read: its status, and the normalized view when it is `ok`. */
export interface AccountCosts {
    status: AccountCostsStatus;
    view: CloudflareCostView | null;
}

/** Read `row`'s billable usage for its most recent charge period. Never throws. */
export const readAccountCosts = async (
    row: Pick<CloudflareAccountRow, "accountId" | "ciphertext" | "iv" | "permissions">,
    options: { encryptionKey?: string; fetch?: typeof globalThis.fetch },
): Promise<AccountCosts> => {
    if (!holds(row, "billing")) {
        return { status: "no-permission", view: null };
    }

    if (!options.encryptionKey) {
        // Master key not provisioned on this cell → the token cannot be unsealed.
        return { status: "unconfigured", view: null };
    }

    let access: Awaited<ReturnType<typeof unsealAccount>>;

    try {
        access = await unsealAccount(row, options.encryptionKey);
    } catch {
        // Malformed key or corrupt ciphertext — a server-side misconfiguration, not the caller's.
        return { status: "error", view: null };
    }

    try {
        const rows = await fetchBillableUsage({ ...access, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });

        return { status: "ok", view: normalizeBillableUsage(rows) };
    } catch (error) {
        return { status: error instanceof CloudflareTokenError ? "unauthorized" : "error", view: null };
    }
};
