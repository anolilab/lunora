/**
 * `lunora cloudflare alerts` / `lunora cloudflare alerts status` — last month's usage per product and
 * what, if anything, alerts on it.
 */
import type { Logger } from "../../../util/logger";
import type { CloudflareClient } from "./api";
import type { AccountState, AlertsResult, MetricStatus } from "./outcome";
import { baseData, BUDGET_ALERT_NOTE, formatNumber, logEligibility, success } from "./outcome";
import type { Policy } from "./plan";
import { LIMIT_UNIT_CAVEAT } from "./plan";
import { BILLING_ALERT_TYPE, matchProduct } from "./products";
import type { MetricUsage } from "./usage";

const formatUsage = (usage: MetricUsage): string => {
    if (usage.status !== "ok") {
        return `unavailable (${usage.reason})`;
    }

    return usage.unit === "microseconds" ? `${formatNumber(usage.value)} µs` : formatNumber(usage.value);
};

const coverageOf = (product: string | undefined, noProduct: boolean, alerts: MetricStatus["alerts"]): MetricStatus["coverage"] => {
    if (noProduct) {
        return "no-product";
    }

    if (product === undefined) {
        return "unknown";
    }

    if (alerts.some((alert) => alert.enabled)) {
        return "active";
    }

    return alerts.length > 0 ? "disabled-only" : "none";
};

const describeAlerts = (alerts: MetricStatus["alerts"]): string =>
    alerts
        .map((alert) => `"${alert.name ?? alert.id ?? "?"}" (limit ${JSON.stringify(alert.limit)})${alert.enabled ? "" : " — disabled, not protecting you"}`)
        .join(", ");

const DESCRIPTIONS: Record<MetricStatus["coverage"], (metric: MetricStatus) => string> = {
    active: (metric) => `alert: ${describeAlerts(metric.alerts)}`,
    "disabled-only": (metric) => `alert: none active; ${describeAlerts(metric.alerts)}`,
    "no-product": () => "alert: none possible — Cloudflare has no usage alert for this; the budget alert is its guard",
    none: () => "alert: none",
    unknown: () => "alert: unknown (several offered products could mean this)",
};

const metricStatus = (usage: MetricUsage, state: AccountState, billing: ReadonlyArray<Policy>): MetricStatus => {
    const match = matchProduct(usage.id, state.discovery.products);
    const product = match.status === "matched" ? match.product : undefined;
    const alerts = (
        product === undefined
            ? []
            : billing.filter((policy) => Array.isArray(policy.filters?.["product"]) && (policy.filters["product"] as unknown[]).includes(product.id))
    ).map((policy) => {
        return { enabled: policy.enabled === true, id: policy.id, limit: policy.filters?.["limit"], name: policy.name };
    });

    return {
        alerts,
        coverage: coverageOf(product?.id, match.status === "no-product", alerts),
        id: usage.id,
        label: usage.label,
        ...(product === undefined ? {} : { product: product.id, productSource: product.source }),
        usage,
    };
};

const runStatus = (client: CloudflareClient, state: AccountState, logger: Logger): AlertsResult => {
    const billing = state.policies.filter((policy) => policy.alert_type === BILLING_ALERT_TYPE);
    const metrics = state.usage.map((usage) => metricStatus(usage, state, billing));

    logger.info(`Cloudflare account ${client.accountId} — usage ${state.period.startDate} to ${state.period.endDate}`);

    for (const metric of metrics) {
        logger.info(`  ${metric.label}: ${formatUsage(metric.usage)} — ${DESCRIPTIONS[metric.coverage](metric)}`);
    }

    logger.info(
        `Usage Based Billing notifications on the account: ${String(billing.length)} (${String(billing.filter((policy) => policy.enabled === true).length)} enabled).`,
    );
    logger.info(LIMIT_UNIT_CAVEAT);
    logEligibility(logger, state.discovery.eligible);
    logger.info(BUDGET_ALERT_NOTE);

    return success({ ...baseData(client, state), metrics });
};

export default runStatus;
