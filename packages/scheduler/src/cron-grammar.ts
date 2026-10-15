/**
 * Dependency-free cron well-formedness check for the Worker-reachable path.
 *
 * `cron-parser` (and its `luxon` dependency, ~350 KB of CommonJS) is the
 * authority at build time via `@lunora/scheduler/validate`; this checker only
 * rejects clearly malformed expressions so that module never ships in a Worker.
 * It accepts the 5-field (minute…dow) and 6-field (seconds-leading) forms, the
 * `@yearly|@annually|@monthly|@weekly|@daily|@hourly` macros, `*`, `?`, lists,
 * ranges, steps, month/weekday names, and the `L` / `n#k` operators.
 */

const MACROS = new Set(["@annually", "@daily", "@hourly", "@monthly", "@weekly", "@yearly"]);

const MONTH_NAMES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const WEEKDAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

interface FieldSpec {
    readonly allowL?: boolean;
    readonly allowNth?: boolean;
    readonly max: number;
    readonly min: number;
    /** Value added to a name's index to get its number. */
    readonly nameBase?: number;
    readonly names?: ReadonlyArray<string>;
}

const SECOND_OR_MINUTE: FieldSpec = { max: 59, min: 0 };
const HOUR: FieldSpec = { max: 23, min: 0 };
const DAY_OF_MONTH: FieldSpec = { allowL: true, max: 31, min: 1 };
const MONTH: FieldSpec = { max: 12, min: 1, nameBase: 1, names: MONTH_NAMES };
const DAY_OF_WEEK: FieldSpec = { allowL: true, allowNth: true, max: 7, min: 0, nameBase: 0, names: WEEKDAY_NAMES };

const FIVE_FIELDS: ReadonlyArray<FieldSpec> = [SECOND_OR_MINUTE, HOUR, DAY_OF_MONTH, MONTH, DAY_OF_WEEK];
const SIX_FIELDS: ReadonlyArray<FieldSpec> = [SECOND_OR_MINUTE, ...FIVE_FIELDS];

const FIELD_SPLIT_PATTERN = /\s+/u;
const NUMBER_PATTERN = /^\d{1,3}$/u;
const STEP_PATTERN = /^[1-9]\d{0,2}$/u;
const NTH_PATTERN = /^(\d{1,3})#([1-5])$/u;
const LAST_PATTERN = /^(\d{1,3})L$/u;

/** Resolves a bare value (number or name) to its number, or `undefined` when out of range / unknown. */
const resolveValue = (token: string, spec: FieldSpec): number | undefined => {
    if (NUMBER_PATTERN.test(token)) {
        const value = Number(token);

        return value >= spec.min && value <= spec.max ? value : undefined;
    }

    const index = spec.names?.indexOf(token.toUpperCase()) ?? -1;

    return index === -1 ? undefined : index + (spec.nameBase ?? 0);
};

const isValidAtom = (token: string, spec: FieldSpec): boolean => {
    if (resolveValue(token, spec) !== undefined) {
        return true;
    }

    // Bare `L` (last day of month) is a day-of-month operator only.
    if (token === "L") {
        return spec.allowL === true && spec.allowNth !== true;
    }

    const last = LAST_PATTERN.exec(token);

    if (spec.allowL === true && last !== null) {
        return resolveValue(last[1] as string, spec) !== undefined;
    }

    const nth = NTH_PATTERN.exec(token);

    return spec.allowNth === true && nth !== null && resolveValue(nth[1] as string, spec) !== undefined;
};

const isValidItem = (item: string, spec: FieldSpec): boolean => {
    if (item === "?") {
        return true;
    }

    const [base = "", step, ...rest] = item.split("/");

    if (rest.length > 0 || (step !== undefined && !STEP_PATTERN.test(step))) {
        return false;
    }

    if (base === "*") {
        return true;
    }

    const [from = "", to, ...extra] = base.split("-");

    if (extra.length > 0) {
        return false;
    }

    if (to === undefined) {
        return isValidAtom(from, spec);
    }

    const start = resolveValue(from, spec);
    const end = resolveValue(to, spec);

    return start !== undefined && end !== undefined && start <= end;
};

const isValidField = (field: string, spec: FieldSpec): boolean => field.split(",").every((item) => isValidItem(item, spec));

/** True when `expression` is a well-formed 5- or 6-field cron expression or a supported `@macro`. */
const isWellFormedCron = (expression: string): boolean => {
    if (typeof expression !== "string") {
        return false;
    }

    const trimmed = expression.trim();

    if (MACROS.has(trimmed)) {
        return true;
    }

    const fields = trimmed.split(FIELD_SPLIT_PATTERN);
    const specs = fields.length === 6 ? SIX_FIELDS : FIVE_FIELDS;

    return (fields.length === 5 || fields.length === 6) && fields.every((field, index) => isValidField(field, specs[index] as FieldSpec));
};

export default isWellFormedCron;
