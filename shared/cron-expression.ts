/**
 * Well-formedness check for the ONE cron dialect this framework can actually
 * deploy: the standard 5-field Cloudflare Cron Trigger.
 *
 * `@lunora/scheduler` is deliberately more permissive at authoring time — it
 * delegates to `cron-parser`, which also accepts 6-field seconds-leading
 * expressions, the `@daily` macros and the Quartz `L`/`W`/`#`/`?` operators, and
 * only WARNS about the seconds-leading form (see `validate-cron.ts`). That
 * latitude exists for a hand-authored `.cron()` escape hatch whose author knows
 * what they are doing. It is the wrong bar for a MODEL-produced expression,
 * which nobody has read yet: an answer that parses but that `wrangler deploy`
 * rejects is worse than no answer, because the operator finds out at deploy.
 *
 * So this checks the narrower, deployable subset — `*`, `n`, `a-b`, any of those
 * with a `/step`, comma lists, and the 3-letter month/weekday names — and
 * nothing else. Being stricter than the platform is safe here: a rejected answer
 * degrades the affordance, it never produces a wrong schedule.
 *
 * Zero-dependency by construction: `shared/` is inlined into each consumer's
 * bundle, and `cron-parser` is a Node/codegen-time dependency that the Worker
 * runtime path never pulls in.
 */

/** Month names cron accepts, lowercased, mapped to their field value. */
const MONTH_VALUES: Readonly<Record<string, number>> = {
    apr: 4,
    aug: 8,
    dec: 12,
    feb: 2,
    jan: 1,
    jul: 7,
    jun: 6,
    mar: 3,
    may: 5,
    nov: 11,
    oct: 10,
    sep: 9,
};

/** Weekday names cron accepts, lowercased, mapped to their field value. */
const DAY_VALUES: Readonly<Record<string, number>> = { fri: 5, mon: 1, sat: 6, sun: 0, thu: 4, tue: 2, wed: 3 };

/** One cron field's accepted range, plus the names that stand in for numbers. */
interface FieldSpec {
    readonly max: number;
    readonly min: number;
    readonly names?: Readonly<Record<string, number>>;
}

/** The five fields, in order: minute, hour, day-of-month, month, day-of-week. */
const FIELDS: ReadonlyArray<FieldSpec> = [
    { max: 59, min: 0 },
    { max: 23, min: 0 },
    { max: 31, min: 1 },
    { max: 12, min: 1, names: MONTH_VALUES },
    // 7 as well as 0 for Sunday — both are standard, and models emit either.
    { max: 7, min: 0, names: DAY_VALUES },
];

/** How many fields a deployable expression has. */
const FIELD_COUNT = 5;

/** Whitespace between fields. */
const WHITESPACE = /\s+/u;

/** A bare one- or two-digit number. Anchored, no backtracking. */
const SMALL_INTEGER = /^\d{1,2}$/u;

/** Resolve one field token to its numeric value, or `undefined` when it is neither a number nor a known name. */
const valueOf = (token: string | undefined, spec: FieldSpec): number | undefined => {
    if (token === undefined) {
        return undefined;
    }

    const named = spec.names?.[token.toLowerCase()];

    if (named !== undefined) {
        return named;
    }

    return SMALL_INTEGER.test(token) ? Number(token) : undefined;
};

/** True when `value` is present and inside the field's range. */
const inRange = (value: number | undefined, spec: FieldSpec): boolean => value !== undefined && value >= spec.min && value <= spec.max;

/**
 * Validate one comma-separated item: `*`, `n`, `a-b`, each optionally `/step`.
 *
 * A descending range (`fri-mon`) is rejected rather than read as a wrap-around —
 * the platform does not agree with itself about those, and a schedule nobody can
 * predict is exactly what this affordance must not hand an operator.
 */
const validItem = (item: string, spec: FieldSpec): boolean => {
    const [rangePart, stepPart, ...extraSlashes] = item.split("/");

    if (extraSlashes.length > 0 || rangePart === undefined || rangePart === "") {
        return false;
    }

    if (stepPart !== undefined) {
        if (!SMALL_INTEGER.test(stepPart)) {
            return false;
        }

        const step = Number(stepPart);

        if (step < 1 || step > spec.max) {
            return false;
        }
    }

    if (rangePart === "*") {
        return true;
    }

    const [from, to, ...extraDashes] = rangePart.split("-");

    if (extraDashes.length > 0) {
        return false;
    }

    const start = valueOf(from, spec);

    if (!inRange(start, spec)) {
        return false;
    }

    if (to === undefined) {
        return true;
    }

    const end = valueOf(to, spec);

    return inRange(end, spec) && (end as number) >= (start as number);
};

/**
 * True when `expression` is a standard 5-field cron expression Cloudflare Cron
 * Triggers accept. See the module docblock for why this is narrower than
 * `@lunora/scheduler`'s authoring-time check.
 */
const isCronExpression = (expression: string): boolean => {
    const fields = expression.trim().split(WHITESPACE);

    if (fields.length !== FIELD_COUNT) {
        return false;
    }

    return fields.every((field, index) => {
        const spec = FIELDS[index] as FieldSpec;

        return field.split(",").every((item) => validItem(item, spec));
    });
};

export { isCronExpression };
