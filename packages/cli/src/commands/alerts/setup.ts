/**
 * `lunora alerts setup` — plan, confirm, write, and read back the usage alerts.
 */
import { EXIT_CODE } from "../../util/exit-code";
import type { Logger } from "../../util/logger";
import type { OutputFormat } from "../../util/output-format";
import { tuiConfirm } from "../../util/tui-prompts";
import type { CloudflareClient } from "./api";
import { CloudflareApiError } from "./api";
import type { AccountState, AlertsData, AlertsResult, StoredPolicy } from "./outcome";
import { baseData, BUDGET_ALERT_NOTE, DASHBOARD_USAGE_ALERT, fail, failFromError, formatNumber, logEligibility } from "./outcome";
import type { AlertPlan, Basis, PlannedAlert } from "./plan";
import { DEFAULT_MULTIPLIER, LIMIT_UNIT_CAVEAT, planAlerts } from "./plan";
import type { MetricId, UsagePeriod } from "./usage";
import { METRICS } from "./usage";

interface SetupOptions {
    allowFloor?: boolean;
    /** Injectable confirmer (tests); defaults to the TUI prompt on a TTY. */
    confirm?: (message: string) => Promise<boolean>;
    dryRun?: boolean;
    emails?: string[];
    format?: OutputFormat;
    logger: Logger;
    multiplier?: string;
    replaceRecipients?: boolean;
    /** Raw `--threshold <metric>=<n>` values. */
    thresholds?: string[];
    webhooks?: string[];
    yes?: boolean;
}

interface SetupInput {
    allowFloor: boolean;
    emails: string[];
    multiplier: number;
    replaceRecipients: boolean;
    thresholds: Partial<Record<MetricId, number>>;
    webhooks: string[];
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/u;

const METRIC_IDS = new Set<string>(METRICS.map((metric) => metric.id));

const isMetricId = (value: string): value is MetricId => METRIC_IDS.has(value);

/** Parse `--threshold <metric>=<n>` values. */
const readThresholds = (raw: ReadonlyArray<string>): Partial<Record<MetricId, number>> | { error: string } => {
    const thresholds: Partial<Record<MetricId, number>> = {};

    for (const entry of raw.flatMap((value) => value.split(","))) {
        const [metric = "", value = ""] = entry.split("=").map((part) => part.trim());
        const limit = Number(value);

        if (!isMetricId(metric)) {
            return { error: `--threshold "${entry}": unknown metric "${metric}" — one of ${[...METRIC_IDS].join(", ")}.` };
        }

        if (!Number.isFinite(limit) || limit <= 0) {
            return { error: `--threshold "${entry}": the limit must be a positive number.` };
        }

        thresholds[metric] = Math.ceil(limit);
    }

    return thresholds;
};

/** Validate setup's flags before any call. */
const readSetupInput = (options: SetupOptions): SetupInput | { error: string } => {
    const emails = (options.emails ?? [])
        .flatMap((entry) => entry.split(","))
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    const webhooks = (options.webhooks ?? []).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
    const multiplier = options.multiplier === undefined ? DEFAULT_MULTIPLIER : Number(options.multiplier);
    const thresholds = readThresholds(options.thresholds ?? []);

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

    if ("error" in thresholds) {
        return thresholds;
    }

    return { allowFloor: options.allowFloor === true, emails, multiplier, replaceRecipients: options.replaceRecipients === true, thresholds, webhooks };
};

const BASIS_LABELS: Record<Basis, (alert: PlannedAlert) => string> = {
    explicit: () => "set with --threshold",
    floor: (alert) => `floor: included monthly allowance; last month ${formatNumber(alert.lastMonth ?? 0)}`,
    "floor-usage-unavailable": () => "floor: usage could not be read, applied with --allow-floor",
    history: (alert) => `last month ${formatNumber(alert.lastMonth ?? 0)}`,
};

const describeRecipients = (recipients: PlannedAlert["recipients"]): string => {
    const parts = [...recipients.added.map((target) => `+${target}`), ...recipients.removed.map((target) => `-${target}`)];

    return parts.length === 0 ? "recipients unchanged" : `recipients ${parts.join(" ")}`;
};

const describeAlert = (alert: PlannedAlert): string => {
    const source = alert.productSource === "documented" ? "documented id" : "offered by the account";
    const moved = alert.previousProduct === undefined ? "" : `, product was ${alert.previousProduct.join(", ") || "none"}`;

    return (
        `${alert.action.padEnd(9)} ${alert.body.name} — product ${alert.product} (${source}${moved}), limit ${formatNumber(alert.threshold)} ` +
        `(${BASIS_LABELS[alert.basis](alert)}); ${describeRecipients(alert.recipients)}`
    );
};

const labelOf = (metric: MetricId): string => METRICS.find((definition) => definition.id === metric)?.label ?? metric;

const logPlan = (plan: AlertPlan, multiplier: number, period: UsagePeriod, logger: Logger): void => {
    logger.info(`Usage alerts at ${String(multiplier)}× last month (${period.startDate} to ${period.endDate}), never below the included allowance:`);

    for (const alert of plan.alerts) {
        logger.info(`  ${describeAlert(alert)}`);
    }

    for (const skip of plan.skipped) {
        logger.info(`  skipped   ${labelOf(skip.metric)} — ${skip.reason}`);

        if (skip.warning !== undefined) {
            logger.warn(`${labelOf(skip.metric)}: the existing alert ${skip.warning}.`);
        }
    }

    for (const orphan of plan.orphans) {
        logger.warn(`"${orphan.name ?? "?"}" (${orphan.id ?? "?"}) is named like a lunora alert but matches no metric; it was left alone.`);
    }

    for (const duplicate of plan.duplicates) {
        logger.warn(`"${duplicate.name ?? "?"}" exists more than once; ${duplicate.id ?? "?"} was left alone — delete the extra one in the dashboard.`);
    }

    if (plan.skipped.some((skip) => skip.kind === "unit-unverified" || skip.kind === "ambiguous")) {
        logger.info(`To set the skipped ones by hand: ${DASHBOARD_USAGE_ALERT}.`);
    }

    logger.info(LIMIT_UNIT_CAVEAT);
    logger.info(BUDGET_ALERT_NOTE);
};

/** Ask before writing: --yes, an injected confirmer, or the TTY prompt. `undefined` means go ahead. */
const confirmApply = async (options: SetupOptions, changes: ReadonlyArray<PlannedAlert>): Promise<AlertsResult | undefined> => {
    if (options.yes === true) {
        return undefined;
    }

    // `--format json` owns stdout for its one document, so a prompt there is as impossible as on a pipe.
    if (options.confirm === undefined && (!process.stdin.isTTY || options.format === "json")) {
        return fail(options.logger, EXIT_CODE.USAGE, "alerts setup: refusing to change notification policies without confirmation — re-run with --yes.");
    }

    const removed = changes.flatMap((alert) => alert.recipients.removed);
    const warning = removed.length === 0 ? "" : ` This REMOVES recipients: ${[...new Set(removed)].join(", ")}.`;
    const confirmed = await (options.confirm ?? tuiConfirm)(`Apply ${String(changes.length)} notification policy change(s)?${warning}`);

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

/** Read each written policy back, so the user sees what Cloudflare stored rather than what was sent. Never fails the run. */
const readBack = async (client: CloudflareClient, written: ReadonlyArray<{ alert: PlannedAlert; id: string }>, logger: Logger): Promise<StoredPolicy[]> => {
    const stored = await Promise.all(
        written.map(async ({ alert, id }) => {
            try {
                const result = (await client.notifications(`Reading back "${alert.body.name}"`, "GET", `/alerting/v3/policies/${encodeURIComponent(id)}`)) as {
                    enabled?: boolean;
                    filters?: Record<string, unknown>;
                    name?: string;
                } | null;
                const entry: StoredPolicy = {
                    enabled: result?.enabled,
                    id,
                    limit: result?.filters?.["limit"],
                    name: result?.name,
                    product: result?.filters?.["product"],
                };

                logger.info(
                    `Cloudflare stored "${entry.name ?? alert.body.name}": product ${JSON.stringify(entry.product)}, limit ${JSON.stringify(entry.limit)}.`,
                );

                if (JSON.stringify(entry.limit) !== JSON.stringify(alert.body.filters.limit)) {
                    logger.warn(
                        `"${alert.body.name}": Cloudflare stored limit ${JSON.stringify(entry.limit)}, not the ${JSON.stringify(alert.body.filters.limit)} sent.`,
                    );
                }

                return entry;
            } catch (error) {
                logger.warn(`Could not read "${alert.body.name}" back: ${error instanceof Error ? error.message : String(error)}`);

                return { id };
            }
        }),
    );

    return stored;
};

/** Apply the changes one at a time, stopping at the first refusal so the report says exactly what landed. */
const applyChanges = async (
    client: CloudflareClient,
    changes: ReadonlyArray<PlannedAlert>,
    logger: Logger,
    data: AlertsData,
): Promise<AlertsResult | AlertsData> => {
    const applied: NonNullable<AlertsData["applied"]> = [];
    const written: { alert: PlannedAlert; id: string }[] = [];

    let refusal: unknown;

    for (const alert of changes) {
        try {
            // eslint-disable-next-line no-await-in-loop -- sequential on purpose: a refusal must stop the rest and leave an exact record of what landed
            const policyId = await applyAlert(client, alert);

            applied.push({ action: alert.action, metric: alert.metric, ...(policyId === undefined ? {} : { policyId }) });

            if (policyId !== undefined) {
                written.push({ alert, id: policyId });
            }

            logger.success(`${alert.action === "create" ? "Created" : "Updated"} "${alert.body.name}".`);
        } catch (error) {
            refusal = error;
            break;
        }
    }

    // What did land is read back either way, so a partial run still shows what Cloudflare stored.
    const result: AlertsData = { ...data, applied, stored: await readBack(client, written, logger) };

    return refusal === undefined ? result : failFromError(logger, refusal, result);
};

/** The run's exit: a metric refused for unreadable usage is a failure even when the rest succeeded. */
const finish = (data: AlertsData, plan: AlertPlan, logger: Logger): AlertsResult => {
    const unreadable = plan.skipped.filter((skip) => skip.kind === "usage-unavailable");

    if (unreadable.length > 0) {
        return fail(
            logger,
            EXIT_CODE.FAILURE,
            `alerts setup: no alert was set for ${unreadable.map((skip) => labelOf(skip.metric)).join(", ")} because last month's usage could not be read — ` +
                "pass --threshold <metric>=<n>, or --allow-floor to accept the floor.",
            data,
        );
    }

    return { code: EXIT_CODE.SUCCESS, data };
};

const runSetup = async (client: CloudflareClient, state: AccountState, options: SetupOptions, input: SetupInput): Promise<AlertsResult> => {
    const { logger } = options;
    const data = baseData(client, state);
    const stopped = await checkWebhooks(client, input.webhooks, logger, data);

    if (stopped !== undefined) {
        return stopped;
    }

    if (state.discovery.eligible === false) {
        logEligibility(logger, false);
        logger.info(BUDGET_ALERT_NOTE);

        return fail(logger, EXIT_CODE.PERMISSION, "alerts setup: the account cannot create Usage Based Billing notifications.", data);
    }

    const plan = planAlerts({ ...input, policies: state.policies, products: state.discovery.products, usage: state.usage });

    data.plan = plan;
    logPlan(plan, input.multiplier, state.period, logger);

    const changes = plan.alerts.filter((alert) => alert.action !== "unchanged");

    if (options.dryRun === true || changes.length === 0) {
        logger.info(options.dryRun === true ? "Dry run: nothing was changed." : "Every alert is already up to date.");

        return finish(data, plan, logger);
    }

    const refused = await confirmApply(options, changes);

    if (refused !== undefined) {
        return { ...refused, data };
    }

    const applied = await applyChanges(client, changes, logger, data);

    return "code" in applied ? applied : finish(applied, plan, logger);
};

export type { SetupInput, SetupOptions };
export { readSetupInput, runSetup };
