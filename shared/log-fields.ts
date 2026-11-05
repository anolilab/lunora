/**
 * Shared, bundler-inlined helpers for the structured `fields` a
 * `ctx.log.<level>(message, fields)` / `ctx.log.with(fields)` call carries.
 *
 * Inlined (like {@link file://./otlp.ts}) so `@lunora/do`, `@lunora/runtime`,
 * `@lunora/config`, and `@lunora/studio` — which sit on different tiers with no
 * acceptable runtime dependency edge between them — share ONE implementation of
 * field rendering/normalization instead of the byte-identical copies they would
 * otherwise hand-mirror. Keep this genuinely zero-dependency (only built-ins) so
 * inlining into each `dist` stays sound.
 */

/** Structured, filterable key/value fields attached to a `ctx.log` line. */
export type LogFields = Record<string, unknown>;

/**
 * Serialize one field value to a string: strings pass through verbatim;
 * everything else is JSON-encoded, with a `String()` fallback so a value that
 * `JSON.stringify` rejects — a `bigint`, a circular object, a function — still
 * yields a string instead of throwing.
 */
export const stringifyFieldValue = (value: unknown): string => {
    if (typeof value === "string") {
        return value;
    }

    // `JSON.stringify(new Error("x"))` is `"{}"` — an Error has no own
    // enumerable properties — so render it the way `console` does. This is the
    // display form; a log line's fields keep the whole Error (see `coerceFieldValue`).
    if (value instanceof Error) {
        return String(value);
    }

    try {
        // `JSON.stringify` returns `undefined` for a function/symbol and throws
        // on a bigint / circular reference — cover both.
        return (JSON.stringify(value) as string | undefined) ?? String(value);
    } catch {
        return String(value);
    }
};

/**
 * A logged `Error` as a normalized field value carries it, once parsed back from
 * its JSON string by {@link parseLoggedError}: the Error's own enumerable fields
 * plus `name`, `message`, `stack`, `cause` (an Error in the same shape, or the raw
 * value) and an `AggregateError`'s `errors`.
 */
export interface LoggedError {
    [key: string]: unknown;
    cause?: unknown;
    errors?: unknown[];
    message: string;
    name: string;
    stack?: string;
}

/**
 * How a field value writes an `Error`. `"full"` keeps the stack and `cause` chain
 * as a {@link LoggedError}: the form for a log line. `"headline"` keeps only
 * `Name: message`: the form for span and metric attributes, which ship to
 * third-party collectors by default and whose values are aggregation keys, so a
 * stack there is both an internals leak and unbounded cardinality.
 */
export type ErrorEncoding = "full" | "headline";

/** `cause` / `errors` levels kept below a logged Error. A deeper Error keeps only its name and message. */
const MAX_ERROR_DEPTH = 4;

/** Members of an `AggregateError`'s `errors` that are kept. */
const MAX_AGGREGATE_ERRORS = 10;

/**
 * Longest JSON a logged Error is allowed before its stacks are cut. Redaction
 * cuts every string at 4 KiB (`shared/credential-redaction.ts`), and a cut JSON
 * string no longer parses, so the terminal and Studio could not show the error
 * at all. The headroom absorbs masking, which can lengthen a short secret.
 */
const MAX_ERROR_JSON_LENGTH = 3584;

/** Stack lines kept per Error once the full stacks do not fit {@link MAX_ERROR_JSON_LENGTH}. */
const SHORT_STACK_LINES = 4;

/** Which stacks a logged Error keeps, from the fullest to none, tried in order until its JSON fits. */
const STACK_MODES = ["all", "root", "short", "none"] as const;

type StackMode = (typeof STACK_MODES)[number];

/** Nesting levels {@link containsError} looks through. An Error deeper than this is written as `JSON.stringify` writes it. */
const MAX_ERROR_SCAN_DEPTH = 8;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
    if (!isRecord(value)) {
        return false;
    }

    const proto: unknown = Object.getPrototypeOf(value);

    return proto === Object.prototype || proto === null;
};

/**
 * Whether `value` is or holds an `Error` in its plain objects and arrays. Asked
 * before serializing, so a field without one keeps `JSON.stringify`'s fast path,
 * which a replacer turns off for the whole value.
 */
const containsError = (value: unknown, depth = 0): boolean => {
    if (value instanceof Error) {
        return true;
    }

    if (depth >= MAX_ERROR_SCAN_DEPTH) {
        return false;
    }

    if (Array.isArray(value)) {
        return value.some((item) => containsError(item, depth + 1));
    }

    return isPlainRecord(value) && Object.values(value).some((child) => containsError(child, depth + 1));
};

/** A value `JSON.stringify` can write: itself, a bigint's digits, or `undefined` (left out) for one it throws on, such as a cycle. */
const jsonSafe = (value: unknown): unknown => {
    if (typeof value === "bigint") {
        return String(value);
    }

    if (typeof value !== "object" || value === null) {
        return value;
    }

    try {
        JSON.stringify(value);

        return value;
    } catch {
        return undefined;
    }
};

const stackFor = (stack: string | undefined, mode: StackMode, depth: number): string | undefined => {
    if (stack === undefined || mode === "none" || (mode === "root" && depth > 0)) {
        return undefined;
    }

    return mode === "short"
        ? stack
              .split("\n")
              .slice(0, SHORT_STACK_LINES + 1)
              .join("\n")
        : stack;
};

/**
 * One {@link LoggedError} level. An Error met a second time (a `cause` cycle) or
 * deeper than {@link MAX_ERROR_DEPTH} keeps only its name and message, so the walk
 * always ends.
 */
const loggedErrorAt = (error: Error, mode: StackMode, child: (value: unknown) => unknown, depth: number, seen: WeakSet<Error>): LoggedError => {
    if (seen.has(error) || depth > MAX_ERROR_DEPTH) {
        return { message: error.message, name: error.name };
    }

    seen.add(error);

    const nested = (value: unknown): unknown => (value instanceof Error ? loggedErrorAt(value, mode, child, depth + 1, seen) : child(value));
    const record: LoggedError = { message: error.message, name: error.name };

    for (const [key, value] of Object.entries(error)) {
        if (key !== "message" && key !== "name") {
            record[key] = child(value);
        }
    }

    const stack = stackFor(error.stack, mode, depth);

    if (stack !== undefined) {
        record.stack = stack;
    }

    if (error.cause !== undefined) {
        record.cause = nested(error.cause);
    }

    if (error instanceof AggregateError && Array.isArray(error.errors)) {
        record.errors = error.errors.slice(0, MAX_AGGREGATE_ERRORS).map((member) => nested(member));
    }

    return record;
};

/** Length of `value`'s JSON, or `0` when it has none to measure (`JSON.stringify` throws). */
const jsonLength = (value: unknown): number => {
    try {
        return JSON.stringify(value).length;
    } catch {
        return 0;
    }
};

/**
 * An `Error` as a plain {@link LoggedError}: `name`, `message`, its own enumerable
 * fields, `stack`, the `cause` chain and up to ten `errors` of an
 * `AggregateError`, nested Errors in the same shape. `JSON.stringify` writes an
 * Error as `{}`, because all of those but the own fields are non-enumerable.
 *
 * Bounded on the object itself, so every caller gets the same caps: a cycle and
 * anything deeper than four levels keep only name and message, and when the JSON
 * would pass {@link MAX_ERROR_JSON_LENGTH} the stacks below the top Error are
 * dropped, then every stack is cut to a few lines, then dropped. JSON still over
 * the limit after that (a long message, large own fields) is left for redaction
 * to cut.
 *
 * `child` converts an own-field value, and a `cause` or `errors` member that is
 * not an Error. The default keeps what `JSON.stringify` can write and leaves out
 * what it would throw on.
 */
export const toLoggedError = (error: Error, child: (value: unknown) => unknown = jsonSafe): LoggedError => {
    let logged = loggedErrorAt(error, "all", child, 0, new WeakSet<Error>());

    for (const mode of STACK_MODES.slice(1)) {
        if (jsonLength(logged) <= MAX_ERROR_JSON_LENGTH) {
            break;
        }

        logged = loggedErrorAt(error, mode, child, 0, new WeakSet<Error>());
    }

    return logged;
};

const fullErrorReplacer = (_key: string, value: unknown): unknown => (value instanceof Error ? toLoggedError(value) : value);

const headlineErrorReplacer = (_key: string, value: unknown): unknown => (value instanceof Error ? String(value) : value);

/**
 * Coerce a field value to a JSON-safe, OTLP-`AnyValue`-encodable primitive:
 * booleans / numbers / strings pass through (a non-finite number is left for the
 * OTLP encoder to stringify); everything else is JSON-encoded, with a `String()`
 * fallback for a value `JSON.stringify` rejects. An `Error`, at the top or nested
 * in plain objects and arrays, is written per `errors` (see {@link ErrorEncoding}):
 * the JSON of its {@link toLoggedError} for `"full"`, `Name: message` for
 * `"headline"`. This is what makes a normalized fields bag safe to
 * `JSON.stringify` wholesale.
 */
export const coerceFieldValue = (value: unknown, errors: ErrorEncoding = "headline"): boolean | number | string => {
    if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
        return value;
    }

    // `stringifyFieldValue` writes a top-level Error as its `Name: message` string.
    if (!containsError(value) || (errors === "headline" && value instanceof Error)) {
        return stringifyFieldValue(value);
    }

    try {
        return (JSON.stringify(value, errors === "full" ? fullErrorReplacer : headlineErrorReplacer) as string | undefined) ?? String(value);
    } catch {
        return String(value);
    }
};

/**
 * A `cause` or `errors` member written by {@link toLoggedError}: anything with a
 * string `name` and `message`, since a cycle-cut or too-deep Error is written as
 * a bare `{ name, message }`.
 */
const nestedError = (value: unknown): LoggedError | undefined =>
    isRecord(value) && typeof value.name === "string" && typeof value.message === "string" ? (value as LoggedError) : undefined;

/**
 * The {@link LoggedError} a normalized field value holds, or `undefined` for any
 * other value. Stricter than a nested member: a `stack`, `cause` or `errors` must
 * be present too, so a plain `{ name, message }` the caller logged stays ordinary
 * JSON. A string that does not parse (redaction cut it) is not an error either;
 * renderers show it as it is.
 */
export const parseLoggedError = (value: unknown): LoggedError | undefined => {
    let parsed: unknown = value;

    if (typeof value === "string") {
        if (!value.startsWith("{") || !value.endsWith("}")) {
            return undefined;
        }

        try {
            parsed = JSON.parse(value);
        } catch {
            return undefined;
        }
    }

    const error = nestedError(parsed);

    return error !== undefined && (typeof error.stack === "string" || error.cause !== undefined || Array.isArray(error.errors)) ? error : undefined;
};

/** `Name: message`, the one-line form of a logged Error. */
const errorHeadline = (error: LoggedError): string => (error.message === "" ? error.name : `${error.name}: ${error.message}`);

/** A stack's first line that is only an error name: V8's header for an Error with an empty message. */
const BARE_NAME_HEADER = /^[\w$.]+$/u;

/**
 * The stack's lines below its header, trimmed. V8 opens a stack with the
 * `Name: message` the Error had when it was built, which can differ from the
 * current `name` (a subclass that sets `this.name` after `super()`), so the header
 * is found by the message rather than rebuilt; a stack with no header (another
 * engine's `fn@file:line` frames) is kept whole.
 */
const stackFrames = (error: LoggedError): string[] => {
    if (typeof error.stack !== "string") {
        return [];
    }

    let rest = error.stack;
    const at = error.message === "" ? -1 : rest.indexOf(error.message);
    const before = at === -1 ? "" : rest.slice(0, at);

    if (at > 0 && before.endsWith(": ") && !before.includes("\n")) {
        rest = rest.slice(at + error.message.length);
    } else if (error.message === "" && BARE_NAME_HEADER.test(rest.split("\n", 1)[0] ?? "")) {
        rest = rest.slice((rest.split("\n", 1)[0] ?? "").length);
    }

    return rest
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
};

/** The chain below one Error: its headline, its stack frames, then each `errors` member and the `cause`, each level two spaces further in. */
const errorChain = (error: LoggedError, indent: string): string[] => {
    const nested = `${indent}  `;
    const lines = [errorHeadline(error), ...stackFrames(error).map((frame) => `${nested}${frame}`)];
    const member = (label: string, value: unknown): string => {
        const inner = nestedError(value);

        return `${indent}${label}: ${inner === undefined ? stringifyFieldValue(value) : errorChain(inner, nested).join("\n")}`;
    };

    if (Array.isArray(error.errors)) {
        error.errors.forEach((value, index) => {
            lines.push(member(`errors[${String(index)}]`, value));
        });
    }

    if (error.cause !== undefined) {
        lines.push(member("caused by", error.cause));
    }

    return lines;
};

/**
 * The multi-line detail of a fields bag's logged Errors: per field, `key:` and
 * the headline, the stack frames below it, then each `errors` member and the
 * `cause` chain, each level indented two spaces further. Every line starts with
 * `indent`. Used by the dev terminal and the Studio Logs panel.
 */
export const formatLoggedErrorFields = (errors: ReadonlyArray<readonly [string, LoggedError]>, indent = ""): string =>
    errors.map(([key, error]) => `${indent}${key}: ${errorChain(error, `${indent}  `).join("\n")}`).join("\n");

/**
 * Set an own, enumerable field. Assignment would treat a `__proto__` key as the prototype and
 * drop the field, so the field is defined instead.
 */
const setField = (target: LogFields, key: string, value: unknown): void => {
    Object.defineProperty(target, key, { configurable: true, enumerable: true, value, writable: true });
};

/**
 * Normalize a (possibly merged) fields bag into the canonical shape every log
 * surface stores and ships: a **fresh** object (so a caller mutating the logged
 * object afterwards can't alter a buffered/queued copy), every value coerced to
 * a JSON-safe primitive (so the in-memory buffer's `getLogs` `JSON.stringify`
 * can never throw on a `bigint`/circular value; an `Error` is written per
 * `errors`, see {@link coerceFieldValue}), or `undefined` for an
 * absent/empty bag (so an empty `{}` doesn't ride every destination). Bound
 * `.with(...)` fields are merged under the per-call fields (per-call wins).
 */
export const normalizeLogFields = (perCall: LogFields | undefined, bound?: LogFields, errors: ErrorEncoding = "headline"): LogFields | undefined => {
    if (perCall === undefined && bound === undefined) {
        return undefined;
    }

    const merged: LogFields = {};

    if (bound !== undefined) {
        for (const [key, value] of Object.entries(bound)) {
            setField(merged, key, coerceFieldValue(value, errors));
        }
    }

    if (perCall !== undefined) {
        for (const [key, value] of Object.entries(perCall)) {
            setField(merged, key, coerceFieldValue(value, errors));
        }
    }

    return Object.keys(merged).length === 0 ? undefined : merged;
};

/**
 * Read a fields bag for display, parsing each value once: `text` is the compact,
 * space-joined `key=value` pairs for a terminal or log row (`""` when there are
 * none, or the value isn't a plain object), with a logged Error shown as its
 * `Name: message` headline; `errors` holds those logged Errors, keyed by field
 * name, for {@link formatLoggedErrorFields}.
 */
export const readLogFields = (fields: unknown): { errors: [string, LoggedError][]; text: string } => {
    if (!isRecord(fields)) {
        return { errors: [], text: "" };
    }

    const errors: [string, LoggedError][] = [];
    const pairs: string[] = [];

    for (const [key, value] of Object.entries(fields)) {
        const error = parseLoggedError(value);

        if (error === undefined) {
            pairs.push(`${key}=${stringifyFieldValue(value)}`);
        } else {
            errors.push([key, error]);
            pairs.push(`${key}=${errorHeadline(error)}`);
        }
    }

    return { errors, text: pairs.join(" ") };
};

/** The `text` of {@link readLogFields}: a fields bag as `key=value` pairs. Used where the logged Errors' detail is not shown. */
export const formatLogFields = (fields: unknown): string => readLogFields(fields).text;
