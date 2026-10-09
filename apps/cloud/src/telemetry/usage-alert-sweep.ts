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
 * enabled usage rule, only the meters those rules name, only the current month
 * (and the previous one in a new month's first hours), and the deployments
 * only when a rule names a project. Every ledger read drains its pages through
 * the `by_org_period_kind` index, and one that stops at the drain's page cap is
 * reported (`incomplete`), never summed as if it were the whole month.
 */
import type { ControlPlaneDatabase } from "../store";
import { drainTable } from "../store";
import type { AlertChannel, AlertDelivery } from "./alerts";
import { USAGE_TARGETS } from "./alerts";
import type { UsageAlertMeter, UsageLedgerRow } from "./usage-alerts";
import { evaluatedPeriods, isUsageAlertMeter, PREVIOUS_MONTH_GRACE_MS, renderUsageAlert, usageAlertDecision, usageTotal } from "./usage-alerts";

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
    /** Rules a month's ledger read stopped short for (the drain's page cap), below the threshold so far: undecided, not "below". */
    incomplete: { organizationId: string; periodStart: number; ruleId: string }[];
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

/** One meter's rows of one month, and whether the read reached the end. */
interface LedgerRead {
    complete: boolean;
    rows: UsageLedgerRow[];
}

/** One organization's reads: its usage rules' ledger rows per (meter, month), its deployments' projects, and its latches. */
interface OrganizationReads {
    ledger: ReadonlyMap<string, LedgerRead>;
    organizationId: string;
    projects: ReadonlyMap<string, string>;
    stateOf: Map<string, RuleStateRow>;
}

/** One meter's rows of one month, through the `by_org_period_kind` index, saying whether the drain reached the end. */
const readLedger = async (
    database: ControlPlaneDatabase,
    where: { kind: UsageAlertMeter; organizationId: string; periodStart: number },
): Promise<LedgerRead> => {
    let complete = true;
    const rows = await drainTable<UsageLedgerRow>(database, "platformUsage", { where }, () => {
        complete = false;
    });

    return { complete, rows };
};

const ledgerKey = (meter: UsageAlertMeter, periodStart: number): string => `${meter}@${String(periodStart)}`;

/**
 * Read what an organization's usage rules need: only their meters, only the
 * months evaluated (through the `by_org_period_kind` index), and the
 * deployments only when a rule names a project.
 */
const readOrganization = async (
    database: ControlPlaneDatabase,
    organizationId: string,
    rules: ReadonlyArray<UsageRule>,
    periods: ReadonlyArray<number>,
): Promise<OrganizationReads> => {
    const keys = [...new Set(rules.map((rule) => rule.meter))].flatMap((meter) =>
        periods.map((periodStart) => {
            return { meter, periodStart };
        }),
    );
    const [ledger, projects, states] = await Promise.all([
        Promise.all(keys.map(async ({ meter, periodStart }) => readLedger(database, { kind: meter, organizationId, periodStart }))),
        rules.some((rule) => rule.projectId != null) ? projectsOf(database, organizationId) : Promise.resolve(new Map<string, string>()),
        drainTable<RuleStateRow>(database, "alertRuleState", { where: { organizationId } }),
    ]);

    return {
        ledger: new Map(keys.map((key, index) => [ledgerKey(key.meter, key.periodStart), ledger[index] ?? { complete: true, rows: [] }])),
        organizationId,
        projects,
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

/** What evaluating one rule for one month did. */
type MonthOutcome = { delivery: AlertDelivery } | { incomplete: true } | undefined;

/**
 * Evaluate one rule for one month: latch it, and fire it when it crossed. A
 * read that stopped at the page cap is a lower bound: enough to fire on, never
 * to decide the rule is below its threshold, so that is reported instead.
 */
const evaluateMonth = async (
    database: ControlPlaneDatabase,
    rule: UsageRule,
    reads: OrganizationReads,
    month: { now: number; periodStart: number },
): Promise<MonthOutcome> => {
    const read = reads.ledger.get(ledgerKey(rule.meter, month.periodStart)) ?? { complete: true, rows: [] };
    const monthToDate = usageTotal(read.rows, rule.projectId, (deploymentId) => reads.projects.get(deploymentId));
    const state = reads.stateOf.get(rule._id);
    const decision = usageAlertDecision({
        firedPeriod: state?.firedPeriod,
        firing: state?.firing === true,
        monthToDate,
        periodStart: month.periodStart,
        threshold: rule.threshold,
    });

    if (decision !== "fire" && !read.complete && monthToDate < rule.threshold) {
        return { incomplete: true };
    }

    if (decision === "hold") {
        return undefined;
    }

    const fires = decision === "fire";
    const latch = {
        firedPeriod: fires ? month.periodStart : (state?.firedPeriod ?? null),
        firing: fires,
        lastEvaluatedAt: month.now,
        lastValue: monthToDate,
        updatedAt: month.now,
    };

    // The latch first: a crash after it loses one notification, never sends one twice for a month.
    if (state === undefined) {
        const id = (await database.insert("alertRuleState", {
            createdAt: month.now,
            organizationId: reads.organizationId,
            ruleId: rule._id,
            ...latch,
        })) as string;

        reads.stateOf.set(rule._id, { _id: id, ...latch, ruleId: rule._id });
    } else {
        await database.patch(state._id, latch, "alertRuleState");
        reads.stateOf.set(rule._id, { ...state, ...latch });
    }

    return fires ? { delivery: await fireUsageRule(database, rule, { monthToDate, now: month.now, periodStart: month.periodStart }) } : undefined;
};

/** Evaluate one organization's usage rules for each evaluated month, oldest first, so a late previous month fires before the latch moves on. */
const sweepOrganization = async (
    database: ControlPlaneDatabase,
    organizationId: string,
    rules: ReadonlyArray<UsageRule>,
    options: { now: number; periods: ReadonlyArray<number> },
): Promise<Pick<UsageAlertSweepResult, "deliveries" | "incomplete">> => {
    const reads = await readOrganization(database, organizationId, rules, options.periods);
    const deliveries: AlertDelivery[] = [];
    const incomplete: UsageAlertSweepResult["incomplete"] = [];

    /* eslint-disable no-await-in-loop -- a rule's months in order: each moves the latch the next reads */
    for (const rule of rules) {
        for (const periodStart of options.periods) {
            const outcome = await evaluateMonth(database, rule, reads, { now: options.now, periodStart });

            if (outcome !== undefined && "delivery" in outcome) {
                deliveries.push(outcome.delivery);
            } else if (outcome !== undefined) {
                incomplete.push({ organizationId, periodStart, ruleId: rule._id });
            }
        }
    }
    /* eslint-enable no-await-in-loop */

    return { deliveries, incomplete };
};

/**
 * Evaluate every enabled usage rule against its organization's usage of the
 * current month, and of the previous one during the new month's first
 * {@link PREVIOUS_MONTH_GRACE_MS} (its last rows arrive after it ends), and
 * fire the ones that crossed. Returns the fired alerts for the edge to
 * deliver, and the rules a truncated read left undecided.
 */
export const runUsageAlertSweep = async (database: ControlPlaneDatabase, options: { now: number }): Promise<UsageAlertSweepResult> => {
    const periods = evaluatedPeriods(options.now);
    const rulesByOrg = new Map<string, UsageRule[]>();

    for (const row of await drainTable<UsageRuleRow>(database, "alertRules")) {
        if (row.enabled && USAGE_TARGETS.has(row.target as "usage_threshold") && isUsageAlertMeter(row.meter)) {
            rulesByOrg.set(row.organizationId, [...(rulesByOrg.get(row.organizationId) ?? []), { ...row, meter: row.meter }]);
        }
    }

    const deliveries: AlertDelivery[] = [];
    const incomplete: UsageAlertSweepResult["incomplete"] = [];

    for (const [organizationId, rules] of rulesByOrg) {
        // eslint-disable-next-line no-await-in-loop -- bounded reads per org with a usage rule, serialized like the other alert sweeps
        const outcome = await sweepOrganization(database, organizationId, rules, { now: options.now, periods });

        deliveries.push(...outcome.deliveries);
        incomplete.push(...outcome.incomplete);
    }

    return { deliveries, evaluatedOrgs: rulesByOrg.size, fired: deliveries.length, incomplete };
};
