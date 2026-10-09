/**
 * `lunora alerts` — protect a self-hosted Cloudflare account from a runaway bill.
 *
 * `status` (default) reads last month's usage and the notification policies;
 * `setup` creates or updates a Usage Based Billing notification per product,
 * well above normal; `test` reports what Cloudflare has delivered. Budget alerts
 * (an account-wide USD threshold) have no API, so every subcommand says so and
 * points at the dashboard rather than pretending to check one.
 */
import { DEFAULT_TARGET, readProjectTarget } from "@lunora/codegen";
import type { WranglerConfig } from "@lunora/config/cloudflare";
import { findWranglerFile, readWranglerJsonc } from "@lunora/config/cloudflare";

import type { CloudflareEnvironment } from "../../util/cloudflare-credentials";
import { resolveCloudflareCredentials } from "../../util/cloudflare-credentials";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { EXIT_CODE } from "../../util/exit-code";
import type { Logger } from "../../util/logger";
import type { CommandResult, OutputFormat } from "../../util/output-format";
import { tuiConfirm } from "../../util/tui-prompts";
import type { CloudflareClient } from "./api";
import { CloudflareApiError, createCloudflareClient, EXIT_CODE_BY_KIND, PERMISSION } from "./api";
import type { DeliveryReport } from "./deliveries";
import { reportDeliveries } from "./deliveries";
import type { AlertsOptions } from "./index";
import type { AlertPlan, PlannedAlert, Policy } from "./plan";
import { DEFAULT_MULTIPLIER, planAlerts } from "./plan";
import type { ProductDiscovery } from "./products";
import { BILLING_ALERT_TYPE, discoverProducts, matchProduct } from "./products";
import type { MetricUsage, UsagePeriod } from "./usage";
import { METRICS, previousMonth, readUsage } from "./usage";

type AlertsSubcommand = "setup" | "status" | "test";

/** Where budget alerts live — documented as dashboard-only, with no API to create or read them. */
const BUDGET_ALERT_NOTE =
    "Budget alert (account-wide USD threshold): Cloudflare documents no API to create or read one, so this cannot be checked. " +
    "Create it in the dashboard: Manage Account > Billing > Billable Usage > Create budget alert.";

/** Where a usage alert the API could not create is made by hand. */
const DASHBOARD_USAGE_ALERT = "Create it in the dashboard instead: Alerts > Overview > Create an Alert, alert type Usage Based Billing.";

interface AlertsCommandOptions {
    /** Injectable confirmer (tests); defaults to the TUI prompt on a TTY. */
    confirm?: (message: string) => Promise<boolean>;
    cwd: string;
    dryRun?: boolean;
    emails?: string[];
    environment?: CloudflareEnvironment;
    fetch?: typeof globalThis.fetch;
    /** The resolved `--format`; `json` never prompts. */
    format?: OutputFormat;
    logger: Logger;
    multiplier?: string;
    /** "Now", for the usage month (tests). */
    now?: Date;
    subcommand: AlertsSubcommand;
    webhooks?: string[];
    yes?: boolean;
}

interface SetupInput {
    emails: string[];
    multiplier: number;
    webhooks: string[];
}

interface MetricStatus {
    alerts: { id?: string; limit?: unknown; name?: string }[];
    id: string;
    label: string;
    product?: string;
    usage: MetricUsage;
}

interface AlertsData {
    accountId: string;
    applied?: { action: PlannedAlert["action"]; metric: string; policyId?: string }[];
    budgetAlert: { checkable: false; dashboardPath: string };
    deliveries?: DeliveryReport;
    eligible: boolean | undefined;
    metrics?: MetricStatus[];
    period: UsagePeriod;
    plan?: AlertPlan;
    products: ProductDiscovery["products"];
}

type AlertsResult = CommandResult<AlertsData>;

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

/** The `account_id` in the project's wrangler config, when it has a readable one. */
const wranglerAccountId = (cwd: string): unknown => {
    const path = findWranglerFile(cwd);

    return path === undefined ? undefined : readWranglerJsonc<WranglerConfig>(path).parsed?.account_id;
};

/** The client, or the failure that stops the command before any call. */
const connect = (options: AlertsCommandOptions): CloudflareClient | AlertsResult => {
    const target = readProjectTarget(options.cwd) ?? DEFAULT_TARGET;

    if (target !== "cloudflare") {
        return fail(options.logger, EXIT_CODE.USAGE, `lunora alerts manages Cloudflare usage notifications; this project targets "${target}".`);
    }

    const { accountId, token } = resolveCloudflareCredentials(options.environment ?? process.env, wranglerAccountId(options.cwd));

    if (token === undefined) {
        return fail(
            options.logger,
            EXIT_CODE.AUTH,
            `CLOUDFLARE_API_TOKEN is not set. lunora alerts calls the Cloudflare API with an API token (a wrangler login session is not reused); ` +
                `create one with the "${PERMISSION.notifications}" and "${PERMISSION.analytics}" permissions.`,
        );
    }

    if (accountId === undefined) {
        return fail(options.logger, EXIT_CODE.USAGE, "No Cloudflare account: set CLOUDFLARE_ACCOUNT_ID or `account_id` in wrangler.jsonc.");
    }

    return createCloudflareClient({ accountId, token, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
};

interface AccountState {
    discovery: ProductDiscovery;
    period: UsagePeriod;
    policies: Policy[];
    usage: MetricUsage[];
}

/** Policies, eligible alert types and usage, read in parallel. A policy-list failure is fatal; the others degrade. */
const readAccount = async (client: CloudflareClient, options: AlertsCommandOptions): Promise<AccountState> => {
    const period = previousMonth(options.now ?? new Date());
    const { logger } = options;
    const [policies, available, usage] = await Promise.all([
        client.notifications("Listing notification policies", "GET", "/alerting/v3/policies"),
        client.notifications("Listing the alert types this account is eligible for", "GET", "/alerting/v3/available_alerts").then(
            (value) => {
                return { ok: true as const, value };
            },
            (error: unknown) => {
                return { error, ok: false as const };
            },
        ),
        readUsage(client, period).catch((error: unknown): MetricUsage[] => {
            const reason = error instanceof Error ? error.message : String(error);

            logger.warn(`Usage could not be read: ${reason}`);

            return METRICS.map(({ id, label }) => {
                return { id, label, reason, status: "unavailable" };
            });
        }),
    ]);

    if (!available.ok) {
        logger.warn(
            `Could not read which alert types the account is eligible for: ${available.error instanceof Error ? available.error.message : String(available.error)}`,
        );
    }

    const policyList = Array.isArray(policies) ? (policies as Policy[]) : [];

    return { discovery: discoverProducts(available.ok ? available.value : undefined, available.ok, policyList), period, policies: policyList, usage };
};

const formatNumber = (value: number): string => value.toLocaleString("en-US", { maximumFractionDigits: 0 });

const formatUsage = (usage: MetricUsage): string => {
    if (usage.status !== "ok") {
        return `unavailable (${usage.reason})`;
    }

    return usage.unit === "microseconds" ? `${formatNumber(usage.value)} µs` : formatNumber(usage.value);
};

const describeCoverage = (metric: MetricStatus): string => {
    if (metric.product === undefined) {
        return "alert: unknown (no product identifier discovered)";
    }

    if (metric.alerts.length === 0) {
        return "alert: none";
    }

    return `alert: ${metric.alerts.map((entry) => `"${entry.name ?? entry.id ?? "?"}" (limit ${JSON.stringify(entry.limit)})`).join(", ")}`;
};

const baseData = (client: CloudflareClient, state: AccountState): AlertsData => {
    return {
        accountId: client.accountId,
        budgetAlert: { checkable: false, dashboardPath: "Manage Account > Billing > Billable Usage" },
        eligible: state.discovery.eligible,
        period: state.period,
        products: state.discovery.products,
    };
};

const logEligibility = (logger: Logger, eligible: boolean | undefined): void => {
    if (eligible === false) {
        logger.warn(
            "This account is not eligible for Usage Based Billing notifications (they are offered to Pay-as-you-go accounts; most Enterprise contracts are not supported).",
        );
    }
};

const runStatus = (client: CloudflareClient, state: AccountState, logger: Logger): AlertsResult => {
    const billing = state.policies.filter((policy) => policy.alert_type === BILLING_ALERT_TYPE);
    const metrics: MetricStatus[] = state.usage.map((usage) => {
        const match = matchProduct(usage.id, state.discovery.products);
        const product = match.status === "matched" ? match.product.id : undefined;
        const alerts =
            product === undefined
                ? []
                : billing.filter((policy) => Array.isArray(policy.filters?.["product"]) && (policy.filters["product"] as unknown[]).includes(product));

        return {
            alerts: alerts.map((policy) => {
                return { id: policy.id, limit: policy.filters?.["limit"], name: policy.name };
            }),
            id: usage.id,
            label: usage.label,
            ...(product === undefined ? {} : { product }),
            usage,
        };
    });

    logger.info(`Cloudflare account ${client.accountId} — usage ${state.period.startDate} to ${state.period.endDate}`);

    for (const metric of metrics) {
        logger.info(`  ${metric.label}: ${formatUsage(metric.usage)} — ${describeCoverage(metric)}`);
    }

    logger.info(`Usage Based Billing notifications on the account: ${String(billing.length)}.`);
    logEligibility(logger, state.discovery.eligible);
    logger.info(BUDGET_ALERT_NOTE);

    return { code: EXIT_CODE.SUCCESS, data: { ...baseData(client, state), metrics } };
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/u;

/** Validate setup's flags before any call. */
const readSetupInput = (options: AlertsCommandOptions): SetupInput | { error: string } => {
    const emails = (options.emails ?? [])
        .flatMap((entry) => entry.split(","))
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    const webhooks = (options.webhooks ?? []).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
    const multiplier = options.multiplier === undefined ? DEFAULT_MULTIPLIER : Number(options.multiplier);

    if (emails.length === 0 && webhooks.length === 0) {
        return { error: "alerts setup needs somewhere to send the alerts: pass --email <address> and/or --webhook <destination-id>." };
    }

    const invalid = emails.find((entry) => !EMAIL_PATTERN.test(entry));

    if (invalid !== undefined) {
        return { error: `--email "${invalid}" is not an email address.` };
    }

    if (!Number.isFinite(multiplier) || multiplier < 1) {
        return { error: `--multiplier must be a number of at least 1 (got "${options.multiplier ?? ""}").` };
    }

    return { emails, multiplier, webhooks };
};

const describeAlert = (alert: PlannedAlert): string => {
    const basis = alert.basis === "history" ? `last month ${formatNumber(alert.lastMonth ?? 0)}` : "floor: included monthly allowance";

    return `${alert.action.padEnd(9)} ${alert.body.name} — product ${alert.product}, limit ${formatNumber(alert.threshold)} (${basis})`;
};

/** Ask before writing: --yes, an injected confirmer, or the TTY prompt. `undefined` means go ahead. */
const confirmApply = async (options: AlertsCommandOptions, changes: number): Promise<AlertsResult | undefined> => {
    if (options.yes === true) {
        return undefined;
    }

    // `--format json` owns stdout for its one document, so a prompt there is as impossible as on a pipe.
    if (options.confirm === undefined && (!process.stdin.isTTY || options.format === "json")) {
        return fail(options.logger, EXIT_CODE.USAGE, "alerts setup: refusing to change notification policies without confirmation — re-run with --yes.");
    }

    const confirmed = await (options.confirm ?? tuiConfirm)(`Apply ${String(changes)} notification policy change(s)?`);

    if (!confirmed) {
        options.logger.info("alerts setup: aborted");

        return { code: EXIT_CODE.CANCELLED, error: "alerts setup: aborted at the confirmation prompt" };
    }

    return undefined;
};

/** Every `--webhook` must name a destination on the account; the failure for the first that does not. */
const checkWebhooks = async (
    client: CloudflareClient,
    webhooks: ReadonlyArray<string>,
    logger: Logger,
    data: AlertsData,
): Promise<AlertsResult | undefined> => {
    const outcomes = await Promise.all(
        webhooks.map(async (id) =>
            client.notifications(`Reading webhook destination ${id}`, "GET", `/alerting/v3/destinations/webhooks/${encodeURIComponent(id)}`).then(
                () => undefined,
                (error: unknown) => {
                    return { error, id };
                },
            ),
        ),
    );
    const failed = outcomes.find((outcome) => outcome !== undefined);

    if (failed === undefined) {
        return undefined;
    }

    if (failed.error instanceof CloudflareApiError && failed.error.kind === "not-found") {
        return fail(logger, EXIT_CODE.USAGE, `--webhook ${failed.id}: no such webhook destination on account ${client.accountId}.`, data);
    }

    return failFromError(logger, failed.error, data);
};

/** Stop before planning when the account cannot take a usage alert, or names no product. */
const checkDiscovery = (state: AccountState, logger: Logger, data: AlertsData): AlertsResult | undefined => {
    if (state.discovery.eligible === false) {
        logEligibility(logger, false);
        logger.info(BUDGET_ALERT_NOTE);

        return fail(logger, EXIT_CODE.PERMISSION, "alerts setup: the account cannot create Usage Based Billing notifications.", data);
    }

    if (state.discovery.products.length === 0) {
        logger.info(BUDGET_ALERT_NOTE);

        return fail(
            logger,
            EXIT_CODE.FAILURE,
            "alerts setup: Cloudflare did not reveal which product identifiers a Usage Based Billing notification accepts, so no policy was created " +
                `(guessing one would make an alert that never fires). ${DASHBOARD_USAGE_ALERT}`,
            data,
        );
    }

    return undefined;
};

const logPlan = (plan: AlertPlan, multiplier: number, period: UsagePeriod, logger: Logger): void => {
    logger.info(`Usage alerts at ${String(multiplier)}× last month (${period.startDate} to ${period.endDate}), never below the included allowance:`);

    for (const alert of plan.alerts) {
        logger.info(`  ${describeAlert(alert)}`);
    }

    for (const skip of plan.skipped) {
        logger.info(`  skipped   ${METRICS.find((metric) => metric.id === skip.metric)?.label ?? skip.metric} — ${skip.reason}`);
    }

    if (plan.alerts.length > 0) {
        logger.info("Limits are sent as plain counts (milliseconds for CPU): Cloudflare does not document the unit of a usage alert's limit.");
    }

    if (plan.skipped.some((skip) => skip.kind !== "covered")) {
        logger.info(`For the skipped products: ${DASHBOARD_USAGE_ALERT}`);
    }

    logger.info(BUDGET_ALERT_NOTE);
};

/** Create or update one policy; resolves to its id. */
const applyAlert = async (client: CloudflareClient, alert: PlannedAlert): Promise<string | undefined> => {
    const result =
        alert.action === "create"
            ? await client.notifications(`Creating "${alert.body.name}"`, "POST", "/alerting/v3/policies", alert.body)
            : await client.notifications(
                  `Updating "${alert.body.name}"`,
                  "PUT",
                  `/alerting/v3/policies/${encodeURIComponent(alert.policyId ?? "")}`,
                  alert.body,
              );

    return typeof result === "object" && result !== null && "id" in result && typeof result.id === "string" ? result.id : alert.policyId;
};

/** Apply the changes one at a time, stopping at the first refusal so the report says exactly what landed. */
const applyChanges = async (client: CloudflareClient, changes: ReadonlyArray<PlannedAlert>, logger: Logger, data: AlertsData): Promise<AlertsResult> => {
    const applied: NonNullable<AlertsData["applied"]> = [];

    for (const alert of changes) {
        try {
            // eslint-disable-next-line no-await-in-loop -- sequential on purpose: a refusal must stop the rest and leave an exact record of what landed
            const policyId = await applyAlert(client, alert);

            applied.push({ action: alert.action, metric: alert.metric, ...(policyId === undefined ? {} : { policyId }) });
            logger.success(`${alert.action === "create" ? "Created" : "Updated"} "${alert.body.name}".`);
        } catch (error) {
            return failFromError(logger, error, { ...data, applied });
        }
    }

    return { code: EXIT_CODE.SUCCESS, data: { ...data, applied } };
};

const runSetup = async (client: CloudflareClient, state: AccountState, options: AlertsCommandOptions, input: SetupInput): Promise<AlertsResult> => {
    const { logger } = options;
    const data = baseData(client, state);
    const stopped = (await checkWebhooks(client, input.webhooks, logger, data)) ?? checkDiscovery(state, logger, data);

    if (stopped !== undefined) {
        return stopped;
    }

    const plan = planAlerts({ ...input, policies: state.policies, products: state.discovery.products, usage: state.usage });

    data.plan = plan;
    logPlan(plan, input.multiplier, state.period, logger);

    if (plan.alerts.length === 0 && !plan.skipped.some((skip) => skip.kind === "covered")) {
        return fail(logger, EXIT_CODE.FAILURE, "alerts setup: no discovered product could be tied to a metric, so no policy was created.", data);
    }

    const changes = plan.alerts.filter((alert) => alert.action !== "unchanged");

    if (options.dryRun === true || changes.length === 0) {
        logger.info(options.dryRun === true ? "Dry run: nothing was changed." : "Every alert is already up to date.");

        return { code: EXIT_CODE.SUCCESS, data };
    }

    const refused = await confirmApply(options, changes.length);

    return refused === undefined ? applyChanges(client, changes, logger, data) : { ...refused, data };
};

const runAlertsCommand = async (options: AlertsCommandOptions): Promise<AlertsResult> => {
    const input = options.subcommand === "setup" ? readSetupInput(options) : undefined;

    if (input !== undefined && "error" in input) {
        return fail(options.logger, EXIT_CODE.USAGE, input.error);
    }

    const client = connect(options);

    if (!("graphql" in client)) {
        return client;
    }

    try {
        const state = await readAccount(client, options);

        if (options.subcommand === "status") {
            return runStatus(client, state, options.logger);
        }

        if (options.subcommand === "test") {
            const deliveries = await reportDeliveries(client, state.policies, options.webhooks ?? [], options.logger);

            return { code: EXIT_CODE.SUCCESS, data: { ...baseData(client, state), deliveries } };
        }

        return await runSetup(client, state, options, input ?? { emails: [], multiplier: DEFAULT_MULTIPLIER, webhooks: [] });
    } catch (error) {
        return failFromError(options.logger, error);
    }
};

const isSubcommand = (value: string): value is AlertsSubcommand => value === "status" || value === "setup" || value === "test";

/** `lunora alerts [status|setup|test]` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<AlertsOptions> = defineHandler<AlertsOptions, AlertsData>(async ({ argument, cwd, format, logger, options }) => {
    const sub = argument[0] ?? "status";

    if (!isSubcommand(sub)) {
        return fail(logger, EXIT_CODE.USAGE, `alerts: unknown subcommand "${sub}" — expected status | setup | test`);
    }

    return runAlertsCommand({
        cwd,
        dryRun: options.dryRun === true,
        format,
        logger,
        subcommand: sub,
        yes: options.yes === true,
        ...(options.email === undefined ? {} : { emails: options.email }),
        ...(options.webhook === undefined ? {} : { webhooks: options.webhook }),
        ...(options.multiplier === undefined ? {} : { multiplier: options.multiplier }),
    });
});

export type { AlertsCommandOptions, AlertsData, AlertsSubcommand };
export { BUDGET_ALERT_NOTE, execute, runAlertsCommand };
