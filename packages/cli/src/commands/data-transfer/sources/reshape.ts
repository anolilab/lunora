/**
 * Column reshapes shared by the Supabase and Firebase readers.
 *
 * The rule the whole file exists to enforce: **a reshape that would lose
 * information errors, naming the column.** A dump is the last copy of the data
 * an operator has, and a migration that silently rounds a `numeric(20,4)` money
 * column or truncates an `int8` id is worse than one that refuses to run — the
 * refusal is fixable, the rounding is discovered in production months later.
 *
 * A column with no declared reshape is copied through untouched.
 */
import { LunoraError } from "@lunora/errors";

/**
 * The reshapes a mapping file may name. Deliberately a closed set: every entry
 * has a defined lossless target, so "what does this do to my data" is answerable
 * from this list rather than from the implementation.
 */
const RESHAPE_KINDS = [
    /** Postgres `timestamptz`/`timestamp` → epoch milliseconds. */
    "timestamp-ms",
    /** Postgres `timestamptz`/`timestamp` → ISO-8601 string. */
    "timestamp-iso",
    /** `json`/`jsonb` text → the parsed value. */
    "json",
    /** Postgres `bytea` hex (`\\x…`) → a base64 string. */
    "bytea-base64",
    /** `int8`/`bigint` → kept as a string, because the value may exceed `Number.MAX_SAFE_INTEGER`. */
    "int8-string",
    /** `int2`/`int4`/`float4`/`float8`/`numeric` → a JS number, erroring when the value cannot round-trip. */
    "number",
    /** `bool` → a JS boolean. */
    "boolean",
    /** Postgres array literal (`{a,b}`) → a string array. */
    "text-array",
] as const;

type ReshapeKind = (typeof RESHAPE_KINDS)[number];

const isReshapeKind = (value: unknown): value is ReshapeKind => RESHAPE_KINDS.includes(value as ReshapeKind);

/** Postgres `bytea` in its default `hex` output format. */
const BYTEA_HEX_RE = /^\\x([\dA-Fa-f]*)$/;

/** A base-10 integer, optionally signed — what `int8` looks like on the wire. */
const INT8_RE = /^[+-]?\d+$/;

const BARE_HOUR_OFFSET_RE = /[+-]\d{2}$/;
/** A trailing `Z` or a `±hh:mm` offset — i.e. the instant is already pinned. */
const HAS_ZONE_RE = /(?:Z|[+-]\d{2}:\d{2})$/i;
const LEADING_PLUS_RE = /^\+/;
const EXPONENT_RE = /e/i;
const EXPONENT_SPLIT_RE = /e/i;

/**
 * Write an exponent-notation number out in plain decimal, so two notations of
 * the same value compare equal.
 */
const expandExponent = (raw: string): string => {
    const [mantissa = "0", exponentPart = "0"] = raw.split(EXPONENT_SPLIT_RE);
    const exponent = Number(exponentPart);
    const negative = mantissa.startsWith("-");
    const [whole = "0", fraction = ""] = (negative ? mantissa.slice(1) : mantissa).replace(LEADING_PLUS_RE, "").split(".");
    const digits = `${whole}${fraction}`;
    const pointAt = whole.length + exponent;
    let body: string;

    if (pointAt <= 0) {
        body = `0.${"0".repeat(-pointAt)}${digits}`;
    } else if (pointAt >= digits.length) {
        body = `${digits}${"0".repeat(pointAt - digits.length)}`;
    } else {
        body = `${digits.slice(0, pointAt)}.${digits.slice(pointAt)}`;
    }

    return negative ? `-${body}` : body;
};
const LEADING_ZEROS_RE = /^0+(?=\d)/;

/**
 * Canonical decimal form, so "1.10", "+1.1" and "1.1" compare equal while a
 * value whose digits a double cannot hold does not.
 *
 * This is how the round-trip check stays honest: comparing `Number(raw)` against
 * itself always succeeds (a double's shortest representation re-parses to that
 * same double), so the comparison has to be against the ORIGINAL digits.
 */
const normalizeDecimal = (raw: string): string => {
    // Expand exponent notation first. `String(0.0000001)` is "1e-7" and
    // `String(1e21)` is "1e+21", while Postgres emits `float8` in exponent form
    // too — so without this the comparison is between two different notations
    // and rejects exactly-representable values with a "more precision than a JS
    // number holds" message that is simply wrong.
    const expanded = EXPONENT_RE.test(raw.trim()) ? expandExponent(raw.trim()) : raw.trim();
    const trimmed = expanded.replace(LEADING_PLUS_RE, "");
    const negative = trimmed.startsWith("-");
    const [integerPart = "0", fractionPart = ""] = (negative ? trimmed.slice(1) : trimmed).split(".");
    const integerDigits = integerPart.replace(LEADING_ZEROS_RE, "");
    // Trailing zeros are stripped by scanning rather than by a regex: `/0+$/` on
    // attacker-shaped input is a backtracking hazard, and a scan cannot be.
    let fractionEnd = fractionPart.length;

    while (fractionEnd > 0 && fractionPart[fractionEnd - 1] === "0") {
        fractionEnd -= 1;
    }

    const fractionDigits = fractionPart.slice(0, fractionEnd);
    const body = fractionDigits.length > 0 ? `${integerDigits}.${fractionDigits}` : integerDigits;

    return negative && Number(body) !== 0 ? `-${body}` : body;
};

const fail = (column: string, kind: ReshapeKind, raw: string, why: string): never => {
    throw new LunoraError("INTERNAL", `column \`${column}\`: cannot reshape ${JSON.stringify(raw)} as \`${kind}\` — ${why}`);
};

/**
 * Parse a timestamp the way Postgres writes it, rejecting anything `Date` cannot
 * represent rather than emitting `NaN`.
 */
const toEpochMs = (column: string, kind: ReshapeKind, raw: string): number => {
    // Postgres writes `2024-01-02 03:04:05.678+00`; `Date` wants the `T`, and a
    // bare `+00` offset is not ISO-8601 either.
    const iso = raw.includes("T") ? raw : raw.replace(" ", "T");
    const withOffset = BARE_HOUR_OFFSET_RE.test(iso) ? `${iso}:00` : iso;

    // An offset-less date-TIME is local time per the ES spec, while an
    // offset-less date-only form is UTC. That split means a `timestamp without
    // time zone` column imports to a different instant on a CET laptop than on a
    // UTC CI box — the same dump, silently different data. Pinning to UTC makes
    // the result depend on the dump alone.
    const withZone = HAS_ZONE_RE.test(withOffset) ? withOffset : `${withOffset}Z`;
    const parsed = Date.parse(withZone);

    if (Number.isNaN(parsed)) {
        fail(column, kind, raw, "not a date Postgres or ISO-8601 syntax can express");
    }

    return parsed;
};

/**
 * Decode a Postgres array literal. Only the flat, quoted-element form is
 * supported; anything nested errors rather than being half-parsed.
 */
const toTextArray = (column: string, raw: string): (null | string)[] => {
    if (!raw.startsWith("{") || !raw.endsWith("}")) {
        fail(column, "text-array", raw, "not a Postgres array literal (expected `{…}`)");
    }

    const body = raw.slice(1, -1);

    if (body.length === 0) {
        return [];
    }

    if (body.includes("{")) {
        fail(column, "text-array", raw, "nested arrays are not supported — map the column to `json` instead");
    }

    const out: (null | string)[] = [];
    let current = "";
    let quoted = false;
    let wasQuoted = false;
    let escaped = false;

    // An UNQUOTED `NULL` element is a SQL NULL; a quoted `"NULL"` is the literal
    // text. Postgres distinguishes them and so must this, or every nullable
    // array column gains the string "NULL" where it had nothing.
    const push = (): void => {
        // eslint-disable-next-line unicorn/no-null -- the whole point of the branch
        out.push(!wasQuoted && current === "NULL" ? null : current);
        current = "";
        wasQuoted = false;
    };

    for (const character of body) {
        if (escaped) {
            current += character;
            escaped = false;
        } else if (character === "\\") {
            escaped = true;
        } else if (character === '"') {
            quoted = !quoted;
            wasQuoted = true;
        } else if (character === "," && !quoted) {
            push();
        } else {
            current += character;
        }
    }

    push();

    return out;
};

/**
 * Apply one declared reshape to one raw cell.
 *
 * `null` short-circuits: a NULL column is null in every target shape, and
 * reshaping it would only invent a value.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- one branch per reshape kind; the switch IS the function
const applyReshape = (column: string, kind: ReshapeKind, raw: string | null): unknown => {
    if (raw === null) {
        // eslint-disable-next-line unicorn/no-null -- a SQL NULL is `null` on the wire; `undefined` would drop the column entirely
        return null;
    }

    switch (kind) {
        case "boolean": {
            if (["1", "t", "TRUE", "true"].includes(raw)) {
                return true;
            }

            if (["0", "f", "FALSE", "false"].includes(raw)) {
                return false;
            }

            return fail(column, kind, raw, "not a Postgres boolean literal");
        }

        case "bytea-base64": {
            const hex = BYTEA_HEX_RE.exec(raw);

            if (hex === null) {
                return fail(column, kind, raw, "not `bytea` hex output (expected a leading `\\x`) — set `bytea_output = 'hex'` before dumping");
            }

            const digits = hex[1] as string;

            // `Buffer.from(…, "hex")` drops a trailing half-byte without
            // complaining, so a truncated dump would become a shorter blob.
            if (digits.length % 2 !== 0) {
                return fail(column, kind, raw, "has an odd number of hex digits, so the dump is truncated — re-export the column");
            }

            return Buffer.from(digits, "hex").toString("base64");
        }

        case "int8-string": {
            if (!INT8_RE.test(raw)) {
                return fail(column, kind, raw, "not an integer");
            }

            // Deliberately stays a string: an `int8` beyond 2^53 cannot survive a
            // JS number, and this reshape exists precisely to keep it whole.
            return raw;
        }

        case "json": {
            try {
                return JSON.parse(raw);
            } catch (error: unknown) {
                return fail(column, kind, raw, `invalid JSON — ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        case "number": {
            const parsed = Number(raw);

            if (raw.trim().length === 0 || !Number.isFinite(parsed)) {
                return fail(column, kind, raw, "not a finite number");
            }

            // The lossy case the plan's STOP condition names: an integer past the
            // safe range silently changes value once it is a JS number, and a
            // decimal that does not round-trip has lost digits.
            if (INT8_RE.test(raw)) {
                if (!Number.isSafeInteger(parsed)) {
                    return fail(column, kind, raw, "exceeds Number.MAX_SAFE_INTEGER — map this column to `int8-string` to keep it lossless");
                }
            } else if (normalizeDecimal(String(parsed)) !== normalizeDecimal(raw)) {
                return fail(column, kind, raw, "has more precision than a JS number holds — map this column to `int8-string` or `json` to keep it lossless");
            }

            return parsed;
        }

        case "text-array": {
            return toTextArray(column, raw);
        }

        case "timestamp-iso": {
            return new Date(toEpochMs(column, kind, raw)).toISOString();
        }

        case "timestamp-ms": {
            return toEpochMs(column, kind, raw);
        }

        default: {
            return raw;
        }
    }
};

export type { ReshapeKind };
export { applyReshape, isReshapeKind, RESHAPE_KINDS };
