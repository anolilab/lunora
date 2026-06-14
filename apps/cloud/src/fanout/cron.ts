/**
 * Tenant cron fan-out (CLOUD-PLAN.md §2.4). Cloudflare silently drops
 * `triggers.crons` for Workers uploaded into a Workers-for-Platforms dispatch
 * namespace, so tenant cron jobs never fire on their own. The control plane runs
 * an every-minute trigger and fans ticks out to each tenant whose cron is due,
 * POSTing the tenant runtime's `/_cirrus/scheduled` endpoint through the
 * dispatcher. This module is the pure core: parse + match standard 5-field cron
 * expressions and compute which tenant ticks are due. The I/O (reading live
 * targets, dispatching) is injected so it stays unit-testable.
 */

/** A live tenant deployment that declares cron expressions. */
export interface CronTarget {
    /** The tenant's per-deployment admin token (gates `/_cirrus/scheduled`). */
    adminToken: string;
    /** The tenant's compiled cron expressions. */
    cronSpecs: ReadonlyArray<string>;
    /** Dispatch-namespace script id. */
    scriptName: string;
}

/** One due tick to deliver: run `cron`'s jobs on `scriptName`. */
export interface CronTick {
    adminToken: string;
    cron: string;
    scriptName: string;
}

const WHITESPACE = /\s+/u;

/** Parse one comma-part of a cron field (wildcard, value, range, or step form) into the values it covers. */
const parsePart = (part: string, min: number, max: number, into: Set<number>): void => {
    const slash = part.indexOf("/");
    const range = slash === -1 ? part : part.slice(0, slash);
    const step = slash === -1 ? 1 : Number.parseInt(part.slice(slash + 1), 10);

    if (!Number.isInteger(step) || step < 1) {
        return;
    }

    let start = min;
    let end = max;

    if (range !== "*" && range !== "") {
        const dash = range.indexOf("-");
        const low = Number.parseInt(dash === -1 ? range : range.slice(0, dash), 10);
        const high = dash === -1 ? low : Number.parseInt(range.slice(dash + 1), 10);

        if (!Number.isInteger(low) || !Number.isInteger(high)) {
            return;
        }

        start = low;
        end = high;
    }

    for (let value = start; value <= end; value += step) {
        if (value >= min && value <= max) {
            into.add(value);
        }
    }
};

const parseField = (field: string, min: number, max: number): Set<number> => {
    const values = new Set<number>();

    for (const part of field.split(",")) {
        parsePart(part, min, max, values);
    }

    return values;
};

/**
 * Whether a standard 5-field cron expression (`min hour dom month dow`, UTC) is
 * due at `date`. Day-of-month and day-of-week use the conventional OR semantics:
 * when BOTH are restricted, a match on either fires.
 */
export const cronDue = (expression: string, date: Date): boolean => {
    const fields = expression.trim().split(WHITESPACE);

    if (fields.length !== 5) {
        return false;
    }

    const [minute, hour, dom, month, dow] = fields;
    const minuteOk = parseField(minute, 0, 59).has(date.getUTCMinutes());
    const hourOk = parseField(hour, 0, 23).has(date.getUTCHours());
    const monthOk = parseField(month, 1, 12).has(date.getUTCMonth() + 1);

    if (!minuteOk || !hourOk || !monthOk) {
        return false;
    }

    const domRestricted = dom !== "*";
    const dowRestricted = dow !== "*";
    // cron normalizes Sunday as 0 (and 7); match either.
    const dowValue = date.getUTCDay();
    const domOk = parseField(dom, 1, 31).has(date.getUTCDate());
    const dowSet = parseField(dow, 0, 7);
    const dowOk = dowSet.has(dowValue) || (dowValue === 0 && dowSet.has(7));

    if (domRestricted && dowRestricted) {
        return domOk || dowOk;
    }

    return domOk && dowOk;
};

/** Every (script, cron) tick due at `now` across the given targets. */
export const dueTicks = (targets: ReadonlyArray<CronTarget>, now: Date): CronTick[] => {
    const ticks: CronTick[] = [];

    for (const target of targets) {
        for (const cron of target.cronSpecs) {
            if (cronDue(cron, now)) {
                ticks.push({ adminToken: target.adminToken, cron, scriptName: target.scriptName });
            }
        }
    }

    return ticks;
};

/**
 * Deliver each due tick through the injected `dispatch`. Best-effort: a failed
 * tenant tick is counted and skipped, never aborting the rest of the fan-out.
 */
export const fanOutCron = async (options: {
    dispatch: (tick: CronTick) => Promise<boolean>;
    now: Date;
    targets: ReadonlyArray<CronTarget>;
}): Promise<{ delivered: number; failed: number }> => {
    const ticks = dueTicks(options.targets, options.now);
    const outcomes = await Promise.all(
        ticks.map(async (tick) => {
            try {
                return await options.dispatch(tick);
            } catch {
                return false;
            }
        }),
    );

    const delivered = outcomes.filter(Boolean).length;

    return { delivered, failed: outcomes.length - delivered };
};
