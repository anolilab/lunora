import { BillableUsageAuthError, fetchBillableUsage, normalizeBillableUsage } from "../src/cloudflare/billable-usage";
import { decryptSecret } from "../src/secrets/crypto";
import type { Id } from "./_generated/dataModel.js";
import { action, mutation, query, v } from "./_generated/server.js";
import { assertMember } from "./authz";
import { rateLimit } from "./guards";
import { boundedString, LIMITS } from "./validators";

/**
 * Per-org BYO Cloudflare billing (Billable Usage API). An org connects its *own*
 * Cloudflare account — an account id + an API token scoped to **Billing Read** —
 * so the console can show that account's authoritative Cloudflare spend by
 * product, distinct from the control plane's *estimate* (`src/billing/spend.ts`).
 *
 * The token is a credential, so it follows the tenant-secret path exactly: it is
 * AES-256-GCM encrypted at the edge (`POST /v1/cloudflare-billing` →
 * `src/secrets/crypto.ts`) before it ever reaches {@link store}, so these
 * functions and the D1 row only hold ciphertext + IV. {@link status} (any member)
 * reports whether a connection exists and its account id — never the token.
 * {@link summary} (an **action**, because the read is a `fetch` and the decrypt
 * key + `ctx.fetch` are action-only) decrypts the token at the edge, reads the
 * account's billable usage, and returns a normalized cost view — failing **open**
 * to a status view (never throwing, never leaking the token) so the tab degrades
 * gracefully when the connection is missing, the master key is absent, or the
 * token lacks the Billing Read scope.
 */

/** The env keys {@link summary} reads off `ctx.env` (the validated `lunora/env.ts` contract). */
interface CloudflareBillingEnv {
    SECRET_ENCRYPTION_KEY?: string;
}

/**
 * Whether the org has connected a Cloudflare account, and which one. Members
 * only; never returns the stored token (not even its ciphertext).
 */
export const status = query
    .input({ organizationId: v.id("organizations") })
    .query(async ({ ctx: context, args: { organizationId } }): Promise<{ cloudflareAccountId: null | string; connected: boolean }> => {
        await assertMember(context, organizationId);

        const { page } = await context.db.cloudflareBilling.findMany({ where: { organizationId } });
        const row = page[0];

        return { cloudflareAccountId: row?.cloudflareAccountId ?? null, connected: Boolean(row) };
    });

/**
 * Persist an already-encrypted Billing-Read token + account id (owner/admin).
 * Upserts the org's single connection row. Called by the `/v1/cloudflare-billing`
 * edge route under the caller's session (so this `assertMember` gate applies);
 * the browser never has the master key, so it cannot produce valid ciphertext.
 */
export const store = mutation
    .use(rateLimit("sensitive"))
    .input({
        ciphertext: boundedString(LIMITS.secret),
        cloudflareAccountId: boundedString(LIMITS.id),
        iv: boundedString(LIMITS.id),
        organizationId: v.id("organizations"),
    })
    .mutation(async ({ ctx: context, args: arguments_ }): Promise<Id<"cloudflareBilling">> => {
        await assertMember(context, arguments_.organizationId, ["owner", "admin"]);

        const { page } = await context.db.cloudflareBilling.findMany({ where: { organizationId: arguments_.organizationId } });
        const existing = page[0];
        const { now } = context;

        if (existing) {
            await context.db.patch(existing._id, {
                ciphertext: arguments_.ciphertext,
                cloudflareAccountId: arguments_.cloudflareAccountId,
                iv: arguments_.iv,
                updatedAt: now,
            });

            return existing._id;
        }

        return context.db.insert("cloudflareBilling", {
            ciphertext: arguments_.ciphertext,
            cloudflareAccountId: arguments_.cloudflareAccountId,
            createdAt: now,
            iv: arguments_.iv,
            organizationId: arguments_.organizationId,
            updatedAt: now,
        });
    });

/** Remove the org's Cloudflare billing connection (owner/admin). Idempotent — a no-op when none exists. */
export const disconnect = mutation
    .use(rateLimit("sensitive"))
    .input({ organizationId: v.id("organizations") })
    .mutation(async ({ ctx: context, args: { organizationId } }): Promise<{ removed: boolean }> => {
        await assertMember(context, organizationId, ["owner", "admin"]);

        const { page } = await context.db.cloudflareBilling.findMany({ where: { organizationId } });
        const row = page[0];

        if (!row) {
            return { removed: false };
        }

        await context.db.delete(row._id);

        return { removed: true };
    });

/** How the summary read resolved — the UI renders a distinct state per status. */
type CloudflareCostsStatus = "error" | "not-connected" | "ok" | "unauthorized" | "unconfigured";

/**
 * The normalized cost view as the summary action returns it. Mirrors
 * `src/cloudflare/billable-usage`'s `CloudflareCostView` **locally** (products as
 * an inline object, like `metrics.ts`'s `MetricSeriesView`) so codegen inlines
 * the full shape into `_generated/*` — an imported type name has no import there.
 */
interface CloudflareCostsView {
    currency: string;
    periodEnd: null | string;
    periodStart: null | string;
    products: { costMinor: number; currency: string; product: string; quantity: null | number; unit: null | string }[];
    totalMinor: number;
}

/** The summary action's wire result — a status plus (on "ok") the normalized cost view. */
interface CloudflareCostsResult {
    cloudflareAccountId: null | string;
    status: CloudflareCostsStatus;
    view: CloudflareCostsView | null;
}

/**
 * The org's Cloudflare billable usage for its most recent charge period. Reads
 * the connection, decrypts the token at the edge, and calls the Billable Usage
 * API. Fails **open** to a status view — a missing connection, an absent master
 * key, an unauthorized token, or any read failure each returns its own status
 * with `view: null`, so the tab never errors and the token never surfaces.
 * Members only; rate-limited as a paid round-trip (`archive`).
 */
export const summary = action
    .use(rateLimit("archive"))
    .input({ organizationId: v.id("organizations") })
    .action(async ({ ctx: context, args: { organizationId } }): Promise<CloudflareCostsResult> => {
        await assertMember(context, organizationId);

        const { page } = await context.db.cloudflareBilling.findMany({ where: { organizationId } });
        const row = page[0];

        if (!row) {
            return { cloudflareAccountId: null, status: "not-connected", view: null };
        }

        const environment = (context.env ?? {}) as CloudflareBillingEnv;

        if (!environment.SECRET_ENCRYPTION_KEY) {
            // Master key not provisioned on this cell → we can't decrypt the token.
            return { cloudflareAccountId: row.cloudflareAccountId, status: "unconfigured", view: null };
        }

        let apiToken: string;

        try {
            apiToken = await decryptSecret(environment.SECRET_ENCRYPTION_KEY, { ciphertext: row.ciphertext, iv: row.iv });
        } catch {
            // Malformed key or corrupt ciphertext — a server-side misconfig, not the caller's.
            return { cloudflareAccountId: row.cloudflareAccountId, status: "error", view: null };
        }

        try {
            const rows = await fetchBillableUsage({ accountId: row.cloudflareAccountId, apiToken, fetch: context.fetch });

            return { cloudflareAccountId: row.cloudflareAccountId, status: "ok", view: normalizeBillableUsage(rows) };
        } catch (error) {
            const resolvedStatus: CloudflareCostsStatus = error instanceof BillableUsageAuthError ? "unauthorized" : "error";

            return { cloudflareAccountId: row.cloudflareAccountId, status: resolvedStatus, view: null };
        }
    });
