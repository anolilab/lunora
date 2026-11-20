/**
 * Monthly usage alerts — the `usage_threshold` rule: "tell me when this
 * month's Workers requests pass 2M", for any meter the readback writes, against
 * the organization's month-to-date usage in the `platformUsage` ledger.
 *
 * Pure: the sweep (`./usage-alert-sweep`) and the studio's queries
 * (`lunora/alerts.ts`) do the reads; the decisions and the wording live here so
 * both read them the same way.
 *
 * **What counts.** Every ledger row of the meter in the current UTC month,
 * billable or display-only (`billable: false`): a usage alert is about usage,
 * not the invoice, so a connected account's or a box's usage alerts too. A rule
 * with a project counts only the rows of that project's deployments; a row with
 * no deployment (a tenant's own `usage.ingest` without one) counts toward
 * org-wide rules only.
 *
 * **Once a month.** A rule fires the first sweep its month-to-date reaches the
 * threshold, and is latched for that month (`alertRuleState.firedPeriod`). A new
 * month re-arms it: the ledger rows of the new month start from zero. A rule
 * created when the month is already past its threshold fires on the next sweep;
 * that is the answer to "am I past it?" and it is given once.
 */
import type { UsageMeter } from "../billing/spend";
import { periodStartOf } from "../billing/spend";

/**
 * The meters a usage rule may watch: the ones the readback writes, so a rule
 * never waits on a number nothing produces. `lunora/tables/shared.ts`'s
 * `usageAlertMeter` validator spells the same list out for codegen;
 * `__tests__/usage-alerts.test.ts` holds the two together.
 */
export const USAGE_ALERT_METERS = ["requests", "cpuMs", "d1RowsRead", "d1RowsWritten", "doRequests", "doDurationGbS", "doRowsRead", "doRowsWritten"] as const;

/** A meter a usage rule may watch. */
export type UsageAlertMeter = (typeof USAGE_ALERT_METERS)[number] & UsageMeter;

/** Whether a stored value names a meter a usage rule may watch. */
export const isUsageAlertMeter = (value: unknown): value is UsageAlertMeter => (USAGE_ALERT_METERS as ReadonlyArray<unknown>).includes(value);

/** How each meter reads in a rule, a notification and the studio. */
export interface UsageMeterLabel {
    /** The suggestion's floor: never suggested lower, so a quiet month does not make a rule fire on noise. */
    floor: number;
    label: string;
    /** The unit a quantity is written in, plural. */
    unit: string;
}

export const USAGE_METER_LABELS: Readonly<Record<UsageAlertMeter, UsageMeterLabel>> = {
    cpuMs: { floor: 10_000_000, label: "Workers CPU time", unit: "CPU ms" },
    d1RowsRead: { floor: 100_000_000, label: "D1 rows read", unit: "rows" },
    d1RowsWritten: { floor: 1_000_000, label: "D1 rows written", unit: "rows" },
    doDurationGbS: { floor: 100_000, label: "Durable Objects duration", unit: "GB-s" },
    doRequests: { floor: 1_000_000, label: "Durable Objects requests", unit: "requests" },
    doRowsRead: { floor: 100_000_000, label: "Durable Objects rows read", unit: "rows" },
    doRowsWritten: { floor: 1_000_000, label: "Durable Objects rows written", unit: "rows" },
    requests: { floor: 1_000_000, label: "Workers requests", unit: "requests" },
};

/** How far above last month the suggestion sits: well above normal, so a normal month never fires it. */
export const SUGGESTION_MULTIPLIER = 3;

/** A ledger row as the month-to-date sum reads it. `.global()` rows answer SQL NULL for unset columns. */
export interface UsageLedgerRow {
    deploymentId?: null | string;
    quantity: number;
}

/**
 * The month-to-date total of one rule's meter from that meter's ledger rows of
 * the month: all of them for an org-wide rule, only those of the project's
 * deployments (`projectOf`) for a project rule.
 */
export const usageTotal = (
    rows: ReadonlyArray<UsageLedgerRow>,
    projectId: null | string | undefined,
    projectOf: (deploymentId: string) => string | undefined,
): number => {
    let total = 0;

    for (const row of rows) {
        const counts = projectId == null || (row.deploymentId != null && projectOf(row.deploymentId) === projectId);

        if (counts && Number.isFinite(row.quantity) && row.quantity > 0) {
            total += row.quantity;
        }
    }

    return total;
};

/**
 * What a sweep does with one rule for one month (`periodStart`):
 *
 * - `fire` — the month's usage reached the threshold and the rule has fired for no
 *   month this late (`firedPeriod`, the latest month it fired for, is earlier or unset).
 * - `rearm` — the rule is still marked firing for an earlier month; clear the
 *   mark, so the state says it is armed.
 * - `hold` — nothing changes.
 *
 * `firedPeriod` only moves forward, so a month fires at most once however many
 * sweeps re-read it, including the previous month in a new month's grace hours.
 */
export const usageAlertDecision = (input: {
    firedPeriod: null | number | undefined;
    firing: boolean;
    monthToDate: number;
    periodStart: number;
    threshold: number;
}): "fire" | "hold" | "rearm" => {
    const earlier = input.firedPeriod == null || input.firedPeriod < input.periodStart;

    if (earlier && input.monthToDate >= input.threshold) {
        return "fire";
    }

    return earlier && input.firing ? "rearm" : "hold";
};

/** The first instant of the UTC month before the one `at` falls in. */
export const previousPeriodStart = (at: number): number => {
    const date = new Date(periodStartOf(at));

    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1);
};

/**
 * How long into a month the sweep also reads the month before. Rows of a
 * month keep arriving after it ends: the last readback hour is written on the
 * 1st, an hourly family reads a closed hour 15 minutes after it closes, and a
 * source that failed catches up a day per hourly run (`MAX_HOURLY_CATCHUP_MS`).
 * 48 hours cover all three, with a day's outage over the turn of the month to
 * spare. A source down longer than that over the boundary loses the previous
 * month's alert; the Usage tab shows the outage.
 */
export const PREVIOUS_MONTH_GRACE_MS = 48 * 60 * 60 * 1000;

/** The months a sweep at `now` evaluates, oldest first: the previous one in its grace hours, and the current one. */
export const evaluatedPeriods = (now: number): number[] => {
    const current = periodStartOf(now);

    return now - current < PREVIOUS_MONTH_GRACE_MS ? [previousPeriodStart(now), current] : [current];
};

/** A quantity as a person reads it: grouped thousands, at most two decimals. */
export const formatUsageQuantity = (quantity: number): string => quantity.toLocaleString("en-US", { maximumFractionDigits: 2 });

/** The UTC month an instant falls in, as "October 2026". */
const monthName = (at: number): string => new Date(at).toLocaleString("en-US", { month: "long", timeZone: "UTC", year: "numeric" });

/** Render a fired usage alert. The subject leads with what passed what, for a phone's first line. */
export const renderUsageAlert = (
    rule: { meter: UsageAlertMeter; name: string; threshold: number },
    source: { monthToDate: number; periodStart: number; project?: string },
): { body: string; subject: string } => {
    const { label, unit } = USAGE_METER_LABELS[rule.meter];
    const scope = source.project === undefined ? "" : ` for project "${source.project}"`;
    const threshold = `${formatUsageQuantity(rule.threshold)} ${unit}`;

    return {
        body:
            `${label}${scope} on Lunora Cloud reached ${formatUsageQuantity(source.monthToDate)} ${unit} in ${monthName(source.periodStart)} (UTC), ` +
            `past the ${threshold} this rule alerts at. Usage is read back from Cloudflare's analytics every hour, so it can be up to two hours behind. ` +
            `The rule fires once a month and re-arms on the 1st.`,
        subject: `[Lunora] ${rule.name}: ${label} passed ${threshold} this month`,
    };
};

/** What the studio pre-fills a usage rule with. */
export interface UsageThresholdSuggestion {
    /** `history`: {@link SUGGESTION_MULTIPLIER} times last month. `floor`: the meter's floor, because there is no history or it is below it. */
    basis: "floor" | "history";
    /** Last full month's usage; `null` when the ledger has no row of the meter for it. */
    lastMonth: null | number;
    meter: UsageAlertMeter;
    /** The month `lastMonth` is of. */
    periodStart: number;
    suggested: number;
    unit: string;
}

/**
 * A threshold well above normal: {@link SUGGESTION_MULTIPLIER} times last full
 * month, rounded to two significant figures, and never below the meter's floor.
 * `lastMonth` is `null` when there is no history; the floor is then the answer.
 */
export const usageThresholdSuggestion = (meter: UsageAlertMeter, lastMonth: null | number, periodStart: number): UsageThresholdSuggestion => {
    const { floor, unit } = USAGE_METER_LABELS[meter];
    const scaled = lastMonth === null ? 0 : Number((SUGGESTION_MULTIPLIER * lastMonth).toPrecision(2));
    const fromHistory = lastMonth !== null && scaled > floor;

    return { basis: fromHistory ? "history" : "floor", lastMonth, meter, periodStart, suggested: fromHistory ? scaled : floor, unit };
};
