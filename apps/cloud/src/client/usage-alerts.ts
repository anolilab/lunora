import type { ReturnOf } from "@lunora/client";

import type { api } from "../../lunora/_generated/api.js";
import { formatNumber } from "./format";

/** What `cloudflareAlerts.overview` answers for one connected account. */
export type UsageAlertsOverview = ReturnOf<typeof api.cloudflare_alerts.overview>;

export type UsageAlertProduct = UsageAlertsOverview["products"][number];

export type UsageAlertsResult = ReturnOf<typeof api.cloudflare_alerts.apply>["results"][number];

/** Where to edit a token's permissions in Cloudflare's dashboard. */
const TOKEN_HINT = "Edit the token in Cloudflare (My Profile → API Tokens, or the account's own API Tokens) and add Notifications: Edit.";

/** The line shown for each state that is not `ready`. */
export const STATE_COPY: Readonly<Record<Exclude<UsageAlertsOverview["state"], "ready">, string>> = {
    "missing-scope": `The connected token cannot read this account's notifications. ${TOKEN_HINT} The token keeps working here once Cloudflare saves the change.`,
    "no-products":
        "Cloudflare offers Usage Based Billing notifications on this account but did not list which products they can watch, so Lunora Cloud creates none rather than guess. Add them in the Cloudflare dashboard under Notifications → Add → Usage Based Billing.",
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

/** A product's proposal, as one line. */
export const describeProposal = (product: Pick<UsageAlertProduct, "basis" | "lastMonth">): string => {
    if (product.basis === "unmapped") {
        return "No Lunora Cloud usage maps to this product — enter a threshold yourself.";
    }

    if (product.basis === "history") {
        return `3× last month (${formatNumber(product.lastMonth ?? 0)})`;
    }

    return product.lastMonth !== null && product.lastMonth > 0
        ? `Plan's included amount — above 3× last month (${formatNumber(product.lastMonth)})`
        : "No usage last month — the plan's included amount";
};

/** Whether a policy the customer made already covers the product (then it is left alone by default). */
export const coveredByOwnPolicy = (product: Pick<UsageAlertProduct, "covered">): boolean => product.covered.some((policy) => !policy.managed);

/** Products ticked when the form opens: the ones with a proposal and no policy of the customer's own. */
export const initialSelection = (products: ReadonlyArray<UsageAlertProduct>): string[] =>
    products.filter((product) => product.proposedLimit !== null && !coveredByOwnPolicy(product)).map((product) => product.id);

/** Each product's threshold as the form edits it: the proposal, or the managed policy's current one. */
export const initialLimits = (products: ReadonlyArray<UsageAlertProduct>): Record<string, string> =>
    Object.fromEntries(
        products.map((product) => [
            product.id,
            product.covered.find((policy) => policy.managed)?.limit ?? (product.proposedLimit === null ? "" : String(product.proposedLimit)),
        ]),
    );

const SEPARATORS = /[\s,;]+/u;

const DIGIT_GROUPING = /[\s,_]/gu;

/** Recipient addresses typed one per line, or separated by commas. */
export const parseRecipients = (text: string): string[] =>
    text
        .split(SEPARATORS)
        .map((address) => address.trim())
        .filter((address) => address !== "");

/** The `apply` arguments the form holds, or what to fix first. */
export const applyRequest = (
    selected: ReadonlyArray<string>,
    limits: Readonly<Record<string, string>>,
    recipientsText: string,
): { error: string } | { products: { id: string; limit: number }[]; recipients: string[] } => {
    const recipients = parseRecipients(recipientsText);

    if (recipients.length === 0) {
        return { error: "Add at least one email address to send the alerts to." };
    }

    if (selected.length === 0) {
        return { error: "Choose at least one product." };
    }

    const products = selected.map((id) => {
        return { id, limit: Number((limits[id] ?? "").replaceAll(DIGIT_GROUPING, "")) };
    });
    const invalid = products.find((product) => !Number.isInteger(product.limit) || product.limit < 1);

    if (invalid !== undefined) {
        return { error: `Enter a whole-number threshold for ${invalid.id}.` };
    }

    return { products, recipients };
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
