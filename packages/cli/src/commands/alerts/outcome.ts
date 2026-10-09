/**
 * What every `lunora alerts` subcommand returns, and the helpers that build it.
 */
import { EXIT_CODE } from "../../util/exit-code";
import type { Logger } from "../../util/logger";
import type { CommandResult } from "../../util/output-format";
import type { CloudflareClient } from "./api";
import { CloudflareApiError, EXIT_CODE_BY_KIND } from "./api";
import type { DeliveryReport } from "./deliveries";
import type { AlertPlan, PlannedAlert, Policy } from "./plan";
import { LIMIT_UNIT_CAVEAT } from "./plan";
import type { ProductDiscovery, ProductOption } from "./products";
import type { MetricUsage, UsagePeriod } from "./usage";

/** Where budget alerts live — documented as dashboard-only, with no API to create or read them. */
const BUDGET_ALERT_NOTE =
    "Budget alert (account-wide USD threshold): Cloudflare documents no API to create or read one, so this cannot be checked. " +
    "Create it in the dashboard: Manage Account > Billing > Billable Usage > Create budget alert.";

/** Where a usage alert the command will not create is made by hand. */
const DASHBOARD_USAGE_ALERT = "Alerts > Overview > Create an Alert, alert type Usage Based Billing";

/** One metric in `status`: its reading and what protects it. */
interface MetricStatus {
    alerts: { enabled: boolean; id?: string; limit?: unknown; name?: string }[];

    /**
     * `active`: an enabled usage alert covers it. `disabled-only`: only disabled
     * ones do, which protect nothing. `no-product`: Cloudflare has no usage alert
     * for it. `unknown`: the product could not be settled.
     */
    coverage: "active" | "disabled-only" | "no-product" | "none" | "unknown";
    id: string;
    label: string;
    product?: string;
    productSource?: ProductOption["source"];
    usage: MetricUsage;
}

/** A written policy as Cloudflare stored it, read back after the write. */
interface StoredPolicy {
    enabled?: boolean;
    id: string;
    limit?: unknown;
    name?: string;
    product?: unknown;
}

interface AlertsData {
    accountId: string;
    applied?: { action: PlannedAlert["action"]; metric: string; policyId?: string }[];
    budgetAlert: { checkable: false; dashboardPath: string };
    deliveries?: DeliveryReport;
    eligible?: boolean;
    /** The `limit` unit is undocumented; every limit this command reads or writes carries that caveat. */
    limitUnitCaveat: string;
    metrics?: MetricStatus[];
    period?: UsagePeriod;
    plan?: AlertPlan;
    products?: ProductDiscovery["products"];
    stored?: StoredPolicy[];
}

type AlertsResult = CommandResult<AlertsData>;

/** What the account looks like, read once per run. */
interface AccountState {
    discovery: ProductDiscovery;
    period: UsagePeriod;
    policies: Policy[];
    usage: MetricUsage[];
}

const fail = (logger: Logger, code: number, message: string, data?: AlertsData): AlertsResult => {
    logger.error(message);

    return { code, error: message, ...(data === undefined ? {} : { data }) };
};

const failFromError = (logger: Logger, error: unknown, data?: AlertsData): AlertsResult => {
    if (error instanceof CloudflareApiError) {
        return fail(logger, EXIT_CODE_BY_KIND[error.kind], error.message, data);
    }

    throw error;
};

const baseData = (client: CloudflareClient, state?: AccountState): AlertsData => {
    return {
        accountId: client.accountId,
        budgetAlert: { checkable: false, dashboardPath: "Manage Account > Billing > Billable Usage" },
        limitUnitCaveat: LIMIT_UNIT_CAVEAT,
        ...(state === undefined ? {} : { eligible: state.discovery.eligible, period: state.period, products: state.discovery.products }),
    };
};

const formatNumber = (value: number): string => value.toLocaleString("en-US", { maximumFractionDigits: 0 });

const logEligibility = (logger: Logger, eligible: boolean | undefined): void => {
    if (eligible === false) {
        logger.warn(
            "This account is not eligible for Usage Based Billing notifications (they are offered to Pay-as-you-go accounts; most Enterprise contracts are not supported).",
        );
    }
};

const success = (data: AlertsData): AlertsResult => {
    return { code: EXIT_CODE.SUCCESS, data };
};

export type { AccountState, AlertsData, AlertsResult, MetricStatus, StoredPolicy };
export { baseData, BUDGET_ALERT_NOTE, DASHBOARD_USAGE_ALERT, fail, failFromError, formatNumber, logEligibility, success };
