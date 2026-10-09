import { LunoraError } from "@lunora/server";

import { knownProducts, readAccountAlerts, removeAccountAlerts, writeAccountAlerts } from "../src/cloudflare-accounts/alerts-api";
import type { AccountAccess, CloudflareAccountRow } from "../src/cloudflare-accounts/store";
import { cloudflareAccountStore, unsealAccount } from "../src/cloudflare-accounts/store";
import type { UsageRow } from "../src/cloudflare-accounts/usage-alerts";
import {
    coverageByProduct,
    dashboardLinks,
    MAX_ALERT_PRODUCTS,
    normalizeRecipients,
    previousPeriodStart,
    proposeThreshold,
    thresholdError,
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
 * The three functions are **actions**: they call the account's Notifications API
 * with the connection's own token, unsealed in-process for the one call.
 * Account-wide budget alerts have no API, so the studio links to the dashboard
 * for those; this never claims to create or check one.
 */

/** The env keys read off `ctx.env`. */
interface AlertsEnvironment {
    SECRET_ENCRYPTION_KEY?: string;
}

/** How reading the account's alerts resolved. */
type OverviewState = "missing-scope" | "not-eligible" | "ready" | "unavailable" | "unconfigured";

/** One product the account can alert on. Spelled out (not imported) so codegen inlines the shape. */
interface UsageAlertProductView {
    basis: "floor" | "history" | "no-data" | "unmapped";
    covered: { enabled: boolean; limit: null | string; managed: boolean; name: string; policyId: string }[];
    description: string;
    id: string;
    lastMonth: null | number;
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
    /** `listed` — Cloudflare listed the account's products; `published` — it listed none, and the ids Cloudflare publishes are offered. */
    productSource: "listed" | "published";
    state: OverviewState;
}

/** What {@link apply} answers, per product. */
interface UsageAlertsApplied {
    // `kind` inlined (not `NotificationsFailure`) so codegen serializes it without an unresolved reference.
    results: {
        action: "created" | "failed" | "updated";
        duplicates: number;
        keptDestinations: number;
        keptRecipients: string[];
        kind: "missing-scope" | "not-eligible" | "transient" | "validation" | null;
        message: null | string;
        productId: string;
        stored: { destinations: number; enabled: boolean; limit: null | string; policyId: string; recipients: string[] }[];
    }[];
}

/** What {@link remove} answers. */
interface UsageAlertsRemoved {
    failed: { message: string; policyId: string }[];
    removed: string[];
}

/** Audit targets are bounded; a long setup is cut, with a marker. */
const MAX_AUDIT_TARGET = 1000;

const auditTarget = (text: string): string => (text.length > MAX_AUDIT_TARGET ? `${text.slice(0, MAX_AUDIT_TARGET - 1)}…` : text);

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
 * Refuse anyone but an owner or admin of the organization (under the caller's
 * session). Internal: `POST /v1/cloudflare-accounts/alert-recipients` runs it
 * before resolving the owners' and admins' addresses at the edge, where the
 * auth plane is reachable (an action's `ctx.env` carries neither the database
 * binding nor the auth secret that `authUserEmails` bootstraps from).
 */
export const assertAlertsManager = internalQuery
    .input({ organizationId: v.id("organizations") })
    .query(async ({ ctx: context, args: { organizationId } }): Promise<null> => {
        await assertMember(context, organizationId, ["owner", "admin"]);

        return null;
    });

/**
 * Record on the connection that its token can read the account's notification
 * policies — what a successful read just proved (a token's permissions can be
 * edited in Cloudflare without rotating it). Re-reads the row first, so a
 * rotation that landed meanwhile is not overwritten; adds only the flag;
 * audited. Only reading is proven: the studio labels it read-verified.
 */
const recordNotificationsRead = async (context: ActionContext, id: Id<"cloudflareAccounts">, actorUserId: string): Promise<void> => {
    const fresh = await cloudflareAccountStore(context.db.cloudflareAccounts).lookup(id);

    if (fresh === null || fresh.permissions.includes("notifications")) {
        return;
    }

    await context.db.patch(id, { permissions: [...fresh.permissions, "notifications"] });
    await context.db.insert("auditLog", {
        action: "cloudflare_account.permission_seen",
        actorUserId,
        createdAt: context.now,
        organizationId: fresh.organizationId,
        target: `${fresh.accountId}: notifications (read)`,
    });
};

/**
 * What Cloudflare's Usage Based Billing notifications cover on a connected
 * account, and the thresholds a setup would propose (owners/admins).
 * Never throws for a Cloudflare failure: the state says what went wrong.
 */
export const overview = action
    .use(rateLimit("archive"))
    .input({ id: v.id("cloudflareAccounts"), organizationId: v.id("organizations") })
    .action(async ({ ctx: context, args: { id, organizationId } }): Promise<UsageAlertsOverview> => {
        const member = await assertMember(context, organizationId, ["owner", "admin"]);
        const { access, row } = await unsealed(context, organizationId, id);
        const historyPeriodStart = previousPeriodStart(context.now);
        const base = { dashboard: dashboardLinks(row.accountId), historyPeriodStart, message: null, productSource: "listed" as const, products: [] };

        if (access === null) {
            return { ...base, state: "unconfigured" };
        }

        const read = await readAccountAlerts(access, context.fetch);

        if (!read.ok) {
            return { ...base, message: read.message, state: stateOf(read.kind) };
        }

        await recordNotificationsRead(context, id, member.userId);

        const { products: discovered, source } = knownProducts(read);
        // Only a full month read back from an account whose token holds Account Analytics is history.
        const metered = row.permissions.includes("analytics") && row.createdAt <= historyPeriodStart;
        const usage = metered ? await lastMonthUsage(context, id, historyPeriodStart) : {};
        const coverage = coverageByProduct(read.policies);
        const products = discovered.map((product): UsageAlertProductView => {
            const proposal = proposeThreshold(product, usage, metered);

            return {
                basis: proposal.basis,
                covered: coverage.get(product.id) ?? [],
                description: product.description,
                id: product.id,
                lastMonth: proposal.lastMonth,
                proposedLimit: proposal.limit,
            };
        });

        // `null`: no category offers the alert type on this account at all.
        return { ...base, products: read.listed === null ? [] : products, productSource: source, state: read.listed === null ? "not-eligible" : "ready" };
    });

/**
 * Create or update the Lunora-managed Usage Based Billing policy of each
 * requested product (owners/admins; audited with products, thresholds and
 * recipients). A product's managed policies (`MANAGED_POLICY_PREFIX` + product
 * id) are updated in place, keeping what the customer changed on them in
 * Cloudflare (`planPolicyWrites`); policies the customer made are never
 * touched. What Cloudflare stored is read back and returned. Only products the
 * account lists or stores, or Cloudflare publishes, are accepted.
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
        const normalized = normalizeRecipients(recipients);

        if ("error" in normalized) {
            throw new LunoraError("BAD_REQUEST", `recipients: ${normalized.error}`);
        }

        if (products.length === 0 || products.length > MAX_ALERT_PRODUCTS || new Set(products.map((product) => product.id)).size !== products.length) {
            throw new LunoraError("BAD_REQUEST", `choose 1 to ${String(MAX_ALERT_PRODUCTS)} distinct products`);
        }

        const refused = products.find((product) => thresholdError(product.limit) !== null);

        if (refused !== undefined) {
            throw new LunoraError("BAD_REQUEST", `${refused.id}: ${thresholdError(refused.limit) ?? ""}`);
        }

        const { access, row } = await unsealed(context, organizationId, id);

        if (access === null) {
            throw new LunoraError("INTERNAL", "SECRET_ENCRYPTION_KEY is not configured on this cell, so the account's token cannot be read");
        }

        const results = await writeAccountAlerts(access, context.fetch, products, normalized.addresses);
        const limits = new Map(products.map((product) => [product.id, product.limit]));

        await context.db.insert("auditLog", {
            action: "cloudflare_account.usage_alerts",
            actorUserId: member.userId,
            createdAt: context.now,
            organizationId: member.organizationId,
            target: auditTarget(
                `${row.accountId}: ${results.map((result) => `${result.productId}=${String(limits.get(result.productId))} ${result.action}`).join(", ")}; to ${normalized.addresses.join(", ")}`,
            ),
        });

        return { results };
    });

/**
 * Delete every Lunora-managed Usage Based Billing policy on a connected account
 * (owners/admins; audited) — what to do before disconnecting it, since the
 * policies live in the customer's account and outlast the connection. The
 * customer's own policies are never touched.
 */
export const remove = action
    .use(rateLimit("sensitive"))
    .input({ id: v.id("cloudflareAccounts"), organizationId: v.id("organizations") })
    .action(async ({ ctx: context, args: { id, organizationId } }): Promise<UsageAlertsRemoved> => {
        const member = await assertMember(context, organizationId, ["owner", "admin"]);
        const { access, row } = await unsealed(context, organizationId, id);

        if (access === null) {
            throw new LunoraError("INTERNAL", "SECRET_ENCRYPTION_KEY is not configured on this cell, so the account's token cannot be read");
        }

        const removal = await removeAccountAlerts(access, context.fetch);

        await context.db.insert("auditLog", {
            action: "cloudflare_account.usage_alerts_remove",
            actorUserId: member.userId,
            createdAt: context.now,
            organizationId: member.organizationId,
            target: auditTarget(`${row.accountId}: removed ${removal.removed.join(", ") || "none"}; ${String(removal.failed.length)} failed`),
        });

        return removal;
    });
