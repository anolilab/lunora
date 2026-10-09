import type { ReturnOf } from "@lunora/client";

import type { api } from "../../lunora/_generated/api.js";
import { magnitudeMismatch, normalizeRecipients, thresholdError } from "../cloudflare-accounts/usage-alerts";
import { formatNumber } from "./format";

/** What `cloudflareAlerts.overview` answers for one connected account. */
export type UsageAlertsOverview = ReturnOf<typeof api.cloudflare_alerts.overview>;

export type UsageAlertProduct = UsageAlertsOverview["products"][number];

export type UsageAlertsResult = ReturnOf<typeof api.cloudflare_alerts.apply>["results"][number];

const DIGIT_GROUPING = /[\s,_]/gu;

/** Where to edit a token's permissions in Cloudflare's dashboard. */
const TOKEN_HINT = "Edit the token in Cloudflare (My Profile → API Tokens, or the account's own API Tokens) and add Notifications: Edit.";

/** The line shown for each state that is not `ready`. */
export const STATE_COPY: Readonly<Record<Exclude<UsageAlertsOverview["state"], "ready">, string>> = {
    "missing-scope": `The connected token cannot read this account's notifications. ${TOKEN_HINT} The token keeps working here once Cloudflare saves the change.`,
    "not-eligible":
        "Cloudflare does not offer Usage Based Billing notifications on this account. They are for Pay-as-you-go accounts; most Enterprise contracts are not supported.",
    unavailable: "Cloudflare's Notifications API could not be reached. Try again shortly.",
    unconfigured: "This cell has no encryption key configured, so the account's token cannot be read.",
};

/** What a failed write means, per failure kind. */
export const FAILURE_COPY: Readonly<Record<NonNullable<UsageAlertsResult["kind"]>, string>> = {
    "missing-scope": `Cloudflare refused the write. Usually the token lacks Notifications: Edit — ${TOKEN_HINT} An account not on Pay-as-you-go is refused the same way.`,
    "not-eligible": "Cloudflare does not offer this alert on the account's plan (Pay-as-you-go accounts only).",
    transient: "Cloudflare could not be reached; try again.",
    validation: "Cloudflare rejected the alert.",
};

/**
 * Said once above the products: Cloudflare does not document the unit of a
 * Usage Based Billing threshold, so nothing here can claim one.
 */
export const UNIT_NOTE =
    "Cloudflare does not document the unit of these thresholds or the window they count over. Proposals assume the product's own billing unit (requests) over a billing period; after saving, what Cloudflare stored is shown below each product. Check one against the Cloudflare dashboard before relying on it.";

/** Said when Cloudflare listed no products for the account. */
export const PUBLISHED_NOTE = "Cloudflare did not list this alert's products for the account, so the ids Cloudflare publishes for it are offered instead.";

/** What Cloudflare has no per-product alert for. */
export const COVERAGE_GAP_NOTE =
    "Cloudflare has no Usage Based Billing alert for D1 or Workers CPU time. Only the account-wide budget alert below covers them.";

/** A product's proposal, as one line. */
export const describeProposal = (product: Pick<UsageAlertProduct, "basis" | "lastMonth">): string => {
    switch (product.basis) {
        case "floor": {
            return `Plan's included amount — 3× last month (${formatNumber(product.lastMonth ?? 0)}) is below it`;
        }
        case "history": {
            return `3× last month (${formatNumber(product.lastMonth ?? 0)})`;
        }
        case "no-data": {
            return "Lunora Cloud read back no usage for last month (no Account Analytics permission, connected mid-month, readback lag, or not a usage it counts). Suggested: the plan's included amount — check it before ticking.";
        }
        default: {
            return "Unit unverified and no Lunora Cloud usage to compare — enter a threshold yourself, in the unit the Cloudflare dashboard shows.";
        }
    }
};

/** Whether an ENABLED policy the customer made already covers the product (then it is left alone by default). */
export const coveredByOwnPolicy = (product: Pick<UsageAlertProduct, "covered">): boolean => product.covered.some((policy) => policy.enabled && !policy.managed);

/** Whether the customer switched the product's managed policy off in Cloudflare. */
export const managedDisabled = (product: Pick<UsageAlertProduct, "covered">): boolean => product.covered.some((policy) => policy.managed && !policy.enabled);

/**
 * Products ticked when the form opens: a history- or floor-based proposal,
 * no enabled policy of the customer's own, and no managed policy the customer
 * switched off. A suggestion without data is never ticked for them.
 */
export const initialSelection = (products: ReadonlyArray<UsageAlertProduct>): string[] =>
    products
        .filter((product) => (product.basis === "history" || product.basis === "floor") && !coveredByOwnPolicy(product) && !managedDisabled(product))
        .map((product) => product.id);

/** Each product's threshold as the form edits it: the managed policy's current one, or the proposal. */
export const initialLimits = (products: ReadonlyArray<UsageAlertProduct>): Record<string, string> =>
    Object.fromEntries(
        products.map((product) => [
            product.id,
            product.covered.find((policy) => policy.managed)?.limit ?? (product.proposedLimit === null ? "" : String(product.proposedLimit)),
        ]),
    );

/** A warning when a typed threshold is orders of magnitude from the customer's own policy for the product. */
export const limitWarning = (product: Pick<UsageAlertProduct, "covered">, typed: string): null | string => {
    const limit = Number(typed.replaceAll(DIGIT_GROUPING, ""));

    if (!Number.isFinite(limit) || limit <= 0) {
        return null;
    }

    const other = magnitudeMismatch(limit, product.covered);

    return other === null ? null : `Your own policy for this product uses ${other} — 100× or more apart, so one of the two may be in another unit.`;
};

const SEPARATORS = /[\n,;]+/u;

/** Recipient entries typed one per line, or separated by commas — `Name &lt;address>` included. */
export const parseRecipients = (text: string): string[] =>
    text
        .split(SEPARATORS)
        .map((address) => address.trim())
        .filter((address) => address !== "");

/** The `apply` arguments the form holds, or what to fix first — the same checks the server makes. */
export const applyRequest = (
    selected: ReadonlyArray<string>,
    limits: Readonly<Record<string, string>>,
    recipientsText: string,
): { error: string } | { products: { id: string; limit: number }[]; recipients: string[] } => {
    const recipients = normalizeRecipients(parseRecipients(recipientsText));

    if ("error" in recipients) {
        return { error: `Recipients: ${recipients.error}.` };
    }

    if (selected.length === 0) {
        return { error: "Choose at least one product." };
    }

    const products = selected.map((id) => {
        return { id, limit: Number((limits[id] ?? "").replaceAll(DIGIT_GROUPING, "")) };
    });
    const invalid = products.find((product) => thresholdError(product.limit) !== null);

    if (invalid !== undefined) {
        return { error: `${invalid.id}: ${thresholdError(invalid.limit) ?? ""}.` };
    }

    return { products, recipients: recipients.addresses };
};

/** One line summarizing a setup's outcome. */
export const summarizeResults = (results: ReadonlyArray<UsageAlertsResult>): string => {
    const count = (action: UsageAlertsResult["action"]): number => results.filter((result) => result.action === action).length;
    const parts = [
        count("created") > 0 ? `${String(count("created"))} created` : null,
        count("updated") > 0 ? `${String(count("updated"))} updated` : null,
        count("failed") > 0 ? `${String(count("failed"))} failed` : null,
    ].filter((part): part is string => part !== null);

    return parts.length > 0 ? `Cloudflare alerts: ${parts.join(", ")}.` : "Nothing to do.";
};

/** What changed beyond the threshold, per product — the kept addresses and destinations, duplicates found. */
export const describeChanges = (result: Pick<UsageAlertsResult, "duplicates" | "keptDestinations" | "keptRecipients">): string[] =>
    [
        result.keptRecipients.length > 0 ? `kept addresses already on it: ${result.keptRecipients.join(", ")}` : null,
        result.keptDestinations > 0 ? `kept ${String(result.keptDestinations)} webhook/PagerDuty destination(s)` : null,
        result.duplicates > 0 ? `found and updated ${String(result.duplicates)} duplicate managed policy(ies)` : null,
    ].filter((line): line is string => line !== null);

/** What Cloudflare stored for a product after a write, as one line per managed policy. */
export const describeStored = (result: Pick<UsageAlertsResult, "stored">): string[] =>
    result.stored.map(
        (policy) =>
            `Cloudflare stored: threshold ${policy.limit ?? "(none)"}, ${policy.enabled ? "enabled" : "disabled"}, ${String(policy.recipients.length)} address(es)${policy.destinations > 0 ? `, ${String(policy.destinations)} other destination(s)` : ""}`,
    );
