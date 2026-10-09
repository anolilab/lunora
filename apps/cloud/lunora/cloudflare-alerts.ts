import { LunoraError } from "@lunora/server";

import { readAccountAlerts, writeAccountAlerts } from "../src/cloudflare-accounts/alerts-api";
import type { AccountAccess, CloudflareAccountRow } from "../src/cloudflare-accounts/store";
import { cloudflareAccountStore, unsealAccount } from "../src/cloudflare-accounts/store";
import type { UsageRow } from "../src/cloudflare-accounts/usage-alerts";
import {
    coverageByProduct,
    dashboardLinks,
    discoverProducts,
    MAX_ALERT_LIMIT,
    MAX_ALERT_PRODUCTS,
    MAX_ALERT_RECIPIENTS,
    normalizeRecipients,
    previousPeriodStart,
    proposeThreshold,
    usageOfPeriod,
} from "../src/cloudflare-accounts/usage-alerts";
import type { Id } from "./_generated/dataModel.js";
import type { ActionCtx as ActionContext } from "./_generated/server.js";
import { action, internalQuery, v } from "./_generated/server.js";
import { assertMember } from "./authz";
import { rateLimit } from "./guards";
import { collectAll } from "./paginate";
import { boundedString, LIMITS } from "./validators";

/**
 * Cloudflare's own usage alerts on a connected `cloudflare-workers` account
 * (owners/admins). A project there bills the customer's card and the platform's
 * spend cap never applies, so this sets up what a careful customer would by
 * hand: Cloudflare Usage Based Billing notifications, one per product, at a
 * threshold well above last month's usage. They are sent by Cloudflare, so they
 * keep working while Lunora Cloud is down.
 *
 * Both functions are **actions**: they call the account's Notifications API
 * with the connection's own token, unsealed in-process for the one call.
 * Account-wide budget alerts have no API, so the studio links to the dashboard
 * for those; this never claims to create or check one.
 */

/** The env keys read off `ctx.env`. */
interface AlertsEnvironment {
    SECRET_ENCRYPTION_KEY?: string;
}

/** How reading the account's alerts resolved. */
type OverviewState = "missing-scope" | "no-products" | "not-eligible" | "ready" | "unavailable" | "unconfigured";

/** One product the account can alert on. Spelled out (not imported) so codegen inlines the shape. */
interface UsageAlertProductView {
    basis: "floor" | "history" | "unmapped";
    covered: { enabled: boolean; limit: null | string; managed: boolean; name: string; policyId: string }[];
    description: string;
    id: string;
    lastMonth: null | number;
    meter: null | string;
    proposedLimit: null | number;
}

/** What {@link overview} answers. */
interface UsageAlertsOverview {
    dashboard: { budgetAlert: string; notifications: string };
    /** The month the proposals are based on (epoch ms, UTC). */
    historyPeriodStart: number;
    /** Cloudflare's own text for a failed read, safe to show. */
    message: null | string;
    products: UsageAlertProductView[];
    state: OverviewState;
}

/** What {@link apply} answers, per product. */
interface UsageAlertsApplied {
    // `kind` inlined (not `NotificationsFailure`) so codegen serializes it without an unresolved reference.
    results: {
        action: "created" | "failed" | "updated";
        kind: "missing-scope" | "not-eligible" | "transient" | "validation" | null;
        message: null | string;
        productId: string;
    }[];
}

const stateOf = (kind: "missing-scope" | "not-eligible" | "transient" | "validation"): OverviewState => {
    if (kind === "missing-scope" || kind === "not-eligible") {
        return kind;
    }

    return "unavailable";
};

/** The connection, checked to belong to `organizationId`, with its token unsealed. */
const unsealed = async (
    context: ActionContext,
    organizationId: Id<"organizations">,
    id: Id<"cloudflareAccounts">,
): Promise<{ access: AccountAccess | null; row: CloudflareAccountRow }> => {
    const row = await cloudflareAccountStore(context.db.cloudflareAccounts).lookup(id);

    if (row?.organizationId !== organizationId) {
        throw new LunoraError("NOT_FOUND", "Cloudflare account not found in this organization");
    }

    const key = ((context.env ?? {}) as AlertsEnvironment).SECRET_ENCRYPTION_KEY;

    return { access: key ? await unsealAccount(row, key) : null, row };
};

/** Last month's usage of the Lunora projects in the account, per meter. */
const lastMonthUsage = async (context: ActionContext, id: Id<"cloudflareAccounts">, periodStart: number): Promise<Partial<Record<string, number>>> => {
    const rows = await collectAll<UsageRow>(async (cursor) => context.db.platformUsage.findMany({ cursor, where: { periodStart, placementRef: id } }));

    return usageOfPeriod(rows, periodStart);
};

/**
 * The user ids of an organization's owners and admins — the default recipients
 * of its Cloudflare usage alerts (owners/admins, under the caller's session).
 * Internal: `POST /v1/cloudflare-accounts/alert-recipients` resolves them to
 * addresses at the edge, where the auth instance that owns the `user` table is
 * bootstrapped; an action runs where it may not be.
 */
export const alertManagers = internalQuery
    .input({ organizationId: v.id("organizations") })
    .query(async ({ ctx: context, args: { organizationId } }): Promise<string[]> => {
        await assertMember(context, organizationId, ["owner", "admin"]);

        const { page } = await context.db.members.findMany({ where: { organizationId } });

        return page.filter((member) => member.role === "owner" || member.role === "admin").map((member) => member.userId);
    });

/**
 * What Cloudflare's Usage Based Billing notifications cover on a connected
 * account, and the thresholds a setup would propose (owners/admins).
 * Never throws for a Cloudflare failure: the state says what went wrong.
 */
export const overview = action
    .use(rateLimit("archive"))
    .input({ id: v.id("cloudflareAccounts"), organizationId: v.id("organizations") })
    .action(async ({ ctx: context, args: { id, organizationId } }): Promise<UsageAlertsOverview> => {
        await assertMember(context, organizationId, ["owner", "admin"]);

        const { access, row } = await unsealed(context, organizationId, id);
        const historyPeriodStart = previousPeriodStart(context.now);
        const base = { dashboard: dashboardLinks(row.accountId), historyPeriodStart, message: null, products: [] };

        if (access === null) {
            return { ...base, state: "unconfigured" };
        }

        const read = await readAccountAlerts(access, context.fetch);

        if (!read.ok) {
            return { ...base, message: read.message, state: stateOf(read.kind) };
        }

        const { listed, policies } = read;
        if (!row.permissions.includes("notifications")) {
            // The token was granted Notifications after it was connected (a token's permissions can be
            // edited in Cloudflare without rotating it); record what this read just proved.
            await context.db.patch(id, { permissions: [...row.permissions, "notifications"] });
        }

        const discovered = discoverProducts(listed, policies);
        const usage = await lastMonthUsage(context, id, historyPeriodStart);
        const coverage = coverageByProduct(policies);
        const products = discovered.map((product): UsageAlertProductView => {
            const proposal = proposeThreshold(product, usage);

            return {
                basis: proposal.basis,
                covered: coverage.get(product.id) ?? [],
                description: product.description,
                id: product.id,
                lastMonth: proposal.lastMonth,
                meter: proposal.meter,
                proposedLimit: proposal.limit,
            };
        });

        let state: OverviewState = "ready";

        if (listed === null && products.length === 0) {
            // Cloudflare does not offer the alert type on this account at all.
            state = "not-eligible";
        } else if (products.length === 0) {
            state = "no-products";
        }

        return { ...base, products, state };
    });

/**
 * Create or update one Lunora-managed Usage Based Billing policy per requested
 * product (owners/admins; audited). Idempotent: a product that already has a
 * managed policy (`MANAGED_POLICY_PREFIX` + product id) is replaced in place,
 * never duplicated; policies the customer made are never touched. Only product
 * ids Cloudflare lists for the account (or already stores on one of its
 * policies) are accepted — never a guessed one.
 */
export const apply = action
    .use(rateLimit("sensitive"))
    .input({
        id: v.id("cloudflareAccounts"),
        organizationId: v.id("organizations"),
        products: v.array(v.object({ id: boundedString(LIMITS.name), limit: v.number() })),
        recipients: v.array(boundedString(LIMITS.email)),
    })
    .action(async ({ ctx: context, args: { id, organizationId, products, recipients } }): Promise<UsageAlertsApplied> => {
        const member = await assertMember(context, organizationId, ["owner", "admin"]);
        const addresses = normalizeRecipients(recipients);

        if (addresses === null) {
            throw new LunoraError("BAD_REQUEST", `recipients must be 1 to ${String(MAX_ALERT_RECIPIENTS)} email addresses`);
        }

        if (products.length === 0 || products.length > MAX_ALERT_PRODUCTS || new Set(products.map((product) => product.id)).size !== products.length) {
            throw new LunoraError("BAD_REQUEST", `choose 1 to ${String(MAX_ALERT_PRODUCTS)} distinct products`);
        }

        if (products.some((product) => !Number.isInteger(product.limit) || product.limit < 1 || product.limit > MAX_ALERT_LIMIT)) {
            throw new LunoraError("BAD_REQUEST", "every threshold must be a whole number of at least 1");
        }

        const { access, row } = await unsealed(context, organizationId, id);

        if (access === null) {
            throw new LunoraError("INTERNAL", "SECRET_ENCRYPTION_KEY is not configured on this cell, so the account's token cannot be read");
        }

        const results = await writeAccountAlerts(access, context.fetch, products, addresses);
        const count = (outcome: "created" | "failed" | "updated"): number => results.filter((result) => result.action === outcome).length;

        await context.db.insert("auditLog", {
            action: "cloudflare_account.usage_alerts",
            actorUserId: member.userId,
            createdAt: context.now,
            organizationId: member.organizationId,
            target: `${row.accountId}: ${String(count("created"))} created, ${String(count("updated"))} updated, ${String(count("failed"))} failed`,
        });

        return { results };
    });
