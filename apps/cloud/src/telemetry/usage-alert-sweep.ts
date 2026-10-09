/**
 * The hourly usage-alert sweep: compare each enabled `usage_threshold` rule's
 * month-to-date usage (`platformUsage`, the current UTC month) with its
 * threshold, and fire it once per month through the same `alerts` rows and
 * delivery as every other rule (`./usage-alerts` has the decisions).
 *
 * It rides the hourly tick beside the usage readback, which runs in parallel,
 * so it sees the ledger as the previous tick left it: with the readback's own
 * lag (closed hours, 15 minutes), a crossing alerts within about two hours.
 *
 * Reads are bounded by the rules people wrote: only organizations with an
 * enabled usage rule, only the meters those rules name, only the current month,
 * and the deployments only when a rule names a project. Every read drains all
 * pages; a month of a busy organization's ledger is more than one page.
 */
import { periodStartOf } from "../billing/spend";
import type { ControlPlaneDatabase } from "../store";
import { drainTable } from "../store";
import type { AlertChannel, AlertDelivery } from "./alerts";
import { USAGE_TARGETS } from "./alerts";
import type { UsageAlertMeter, UsageLedgerRow } from "./usage-alerts";
import { isUsageAlertMeter, renderUsageAlert, usageAlertDecision, usageTotal } from "./usage-alerts";

/** An `alertRules` row as this sweep reads it. `.global()` rows answer SQL NULL for unset columns. */
interface UsageRuleRow {
    _id: string;
    channel: AlertChannel;
    destination: string;
    enabled: boolean;
    meter?: null | string;
    name: string;
    organizationId: string;
    projectId?: null | string;
    target: string;
    threshold: number;
}

/** A usage rule the sweep evaluates: an enabled `usage_threshold` row with a meter it can read. */
type UsageRule = UsageRuleRow & { meter: UsageAlertMeter };

/** An `alertRuleState` row. */
interface RuleStateRow {
    _id: string;
    firedPeriod?: null | number;
    firing: boolean;
    ruleId: string;
}

export interface UsageAlertSweepResult {
    /** Alerts fired this pass, for the edge to deliver. */
    deliveries: AlertDelivery[];
    /** Organizations with an enabled usage rule, whose usage was read. */
    evaluatedOrgs: number;
    fired: number;
}

/** Each deployment's project, for the rules that name one. */
const projectsOf = async (database: ControlPlaneDatabase, organizationId: string): Promise<Map<string, string>> => {
    const deployments = await drainTable<{ _id: string; projectId: string }>(database, "deployments", { where: { organizationId } });

    return new Map(deployments.map((row) => [row._id, row.projectId]));
};

/** The rule's project, by name, for the notification; `undefined` for an org-wide rule or one whose project is gone. */
const projectName = async (database: ControlPlaneDatabase, organizationId: string, projectId: null | string | undefined): Promise<string | undefined> => {
    if (projectId == null) {
        return undefined;
    }

    const projects = await drainTable<{ _id: string; name?: null | string }>(database, "projects", { where: { organizationId } });

    return projects.find((project) => project._id === projectId)?.name ?? undefined;
};

/** One organization's month: its usage rules' ledger rows, deployments' projects and latches. */
interface OrganizationMonth {
    organizationId: string;
    periodStart: number;
    projects: ReadonlyMap<string, string>;
    rowsOf: ReadonlyMap<UsageAlertMeter, UsageLedgerRow[]>;
    stateOf: ReadonlyMap<string, RuleStateRow>;
}

/** Read what an organization's usage rules need for this month: only their meters, and the deployments only when a rule names a project. */
const readMonth = async (
    database: ControlPlaneDatabase,
    organizationId: string,
    rules: ReadonlyArray<UsageRule>,
    periodStart: number,
): Promise<OrganizationMonth> => {
    const meters = [...new Set(rules.map((rule) => rule.meter))];
    const [ledger, projects, states] = await Promise.all([
        Promise.all(meters.map(async (kind) => drainTable<UsageLedgerRow>(database, "platformUsage", { where: { kind, organizationId, periodStart } }))),
        rules.some((rule) => rule.projectId != null) ? projectsOf(database, organizationId) : Promise.resolve(new Map<string, string>()),
        drainTable<RuleStateRow>(database, "alertRuleState", { where: { organizationId } }),
    ]);

    return {
        organizationId,
        periodStart,
        projects,
        rowsOf: new Map(meters.map((meter, index) => [meter, ledger[index] ?? []])),
        stateOf: new Map(states.map((row) => [row.ruleId, row])),
    };
};

/** Insert the `alerts` row of a rule that fired, and say what to deliver. */
const fireUsageRule = async (
    database: ControlPlaneDatabase,
    rule: UsageRule,
    source: { monthToDate: number; now: number; periodStart: number },
): Promise<AlertDelivery> => {
    const project = await projectName(database, rule.organizationId, rule.projectId);
    const rendered = renderUsageAlert(rule, {
        monthToDate: source.monthToDate,
        periodStart: source.periodStart,
        ...(project === undefined ? {} : { project }),
    });
    const id = (await database.insert("alerts", {
        body: rendered.body,
        channel: rule.channel,
        createdAt: source.now,
        destination: rule.destination,
        // Names the meter, scope and month, so the alert list groups a rule's months apart.
        hash: `usage:${rule.meter}:${rule.projectId ?? "*"}:${String(source.periodStart)}`,
        organizationId: rule.organizationId,
        ruleId: rule._id,
        status: "firing",
        subject: rendered.subject,
        target: "usage_threshold",
        updatedAt: source.now,
    })) as string;

    return { body: rendered.body, channel: rule.channel, destination: rule.destination, id, subject: rendered.subject };
};

/** Evaluate one rule against its organization's month: latch it, and fire it when it crossed. */
const evaluateUsageRule = async (
    database: ControlPlaneDatabase,
    rule: UsageRule,
    month: OrganizationMonth,
    now: number,
): Promise<AlertDelivery | undefined> => {
    const monthToDate = usageTotal(month.rowsOf.get(rule.meter) ?? [], rule.projectId, (deploymentId) => month.projects.get(deploymentId));
    const state = month.stateOf.get(rule._id);
    const decision = usageAlertDecision({ firedPeriod: state?.firedPeriod, monthToDate, periodStart: month.periodStart, threshold: rule.threshold });

    if (decision === "hold") {
        return undefined;
    }

    const fires = decision === "fire";
    const latch = { firedPeriod: fires ? month.periodStart : null, firing: fires, lastEvaluatedAt: now, lastValue: monthToDate, updatedAt: now };

    // The latch first: a crash after it loses one notification, never sends one twice a month.
    await (state === undefined
        ? database.insert("alertRuleState", { createdAt: now, organizationId: month.organizationId, ruleId: rule._id, ...latch })
        : database.patch(state._id, latch, "alertRuleState"));

    return fires ? fireUsageRule(database, rule, { monthToDate, now, periodStart: month.periodStart }) : undefined;
};

/**
 * Evaluate every enabled usage rule against its organization's month-to-date
 * usage and fire the ones that crossed this month. Returns the fired alerts
 * for the edge to deliver.
 */
export const runUsageAlertSweep = async (database: ControlPlaneDatabase, options: { now: number }): Promise<UsageAlertSweepResult> => {
    const periodStart = periodStartOf(options.now);
    const rulesByOrg = new Map<string, UsageRule[]>();

    for (const row of await drainTable<UsageRuleRow>(database, "alertRules")) {
        if (row.enabled && USAGE_TARGETS.has(row.target as "usage_threshold") && isUsageAlertMeter(row.meter)) {
            rulesByOrg.set(row.organizationId, [...(rulesByOrg.get(row.organizationId) ?? []), { ...row, meter: row.meter }]);
        }
    }

    const deliveries: AlertDelivery[] = [];

    /* eslint-disable no-await-in-loop -- bounded reads per org with a usage rule, serialized like the other alert sweeps */
    for (const [organizationId, rules] of rulesByOrg) {
        const month = await readMonth(database, organizationId, rules, periodStart);

        for (const rule of rules) {
            const delivery = await evaluateUsageRule(database, rule, month, options.now);

            if (delivery !== undefined) {
                deliveries.push(delivery);
            }
        }
    }
    /* eslint-enable no-await-in-loop */

    return { deliveries, evaluatedOrgs: rulesByOrg.size, fired: deliveries.length };
};
