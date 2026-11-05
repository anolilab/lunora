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
 * Longest JSON a field holding a logged Error is allowed before its stacks are cut. Redaction cuts every string at
 * 4 KiB (`shared/credential-redaction.ts`), and a cut JSON string no longer parses, so the terminal and Studio could
 * not show the error at all. The headroom absorbs masking, which can lengthen a short secret.
 */
const MAX_ERROR_JSON_LENGTH = 3584;

/** Stack lines kept per Error once the full stacks do not fit {@link MAX_ERROR_JSON_LENGTH}. */
const SHORT_STACK_LINES = 4;

/** A message's length once nothing else is left to cut (the `"minimal"` mode). */
const MINIMAL_MESSAGE_LENGTH = 512;

/**
 * What the Errors of a field keep, from the fullest to the least, tried in order until the field's JSON fits:
 * every stack, the top Error's only, a few lines each, none, then (`"minimal"`) no own fields and a cut message.
 */
const STACK_MODES = ["all", "root", "short", "none", "minimal"] as const;

type StackMode = (typeof STACK_MODES)[number];

/** Nesting levels of plain objects and arrays looked through for an `Error`. Deeper values are written as `JSON.stringify` writes them. */
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
 * before serializing, so a field without one keeps `JSON.stringify`'s fast path.
 * Each container is looked at once, so a value full of references to itself
 * costs one pass, not one per path to it. Reads the value, so it can throw (a
 * getter); callers ask inside their fallback.
 */
const containsError = (value: unknown, depth = 0, visited = new WeakSet<object>()): boolean => {
    if (value instanceof Error) {
        return true;
    }

    if (typeof value !== "object" || value === null || depth >= MAX_ERROR_SCAN_DEPTH || visited.has(value)) {
        return false;
    }

    visited.add(value);

    if (Array.isArray(value)) {
        return value.some((item) => containsError(item, depth + 1, visited));
    }

    return isPlainRecord(value) && Object.values(value).some((child) => containsError(child, depth + 1, visited));
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

/** A dropped stack is `""`, not absent: {@link parseLoggedError} needs a `stack` to know a lone Error for one. */
const stackFor = (stack: string | undefined, mode: StackMode, depth: number): string | undefined => {
    if (stack === undefined) {
        return undefined;
    }

    if (mode === "none" || mode === "minimal" || (mode === "root" && depth > 0)) {
        return "";
    }

    return mode === "short"
        ? stack
              .split("\n")
              .slice(0, SHORT_STACK_LINES + 1)
              .join("\n")
        : stack;
};

/** One encoding pass over a field value. */
interface Encoding {
    /** Converts an Error's own-field value, and a `cause` or `errors` member that is not an Error; the default encodes it like any value. */
    child?: (value: unknown) => unknown;
    errors: ErrorEncoding;
    /** Applied to each logged Error's record, so its own fields can be masked by their keys. */
    mask: (record: LoggedError) => unknown;
    /** Finished encodings, so a value met again under another key is reused rather than walked again. */
    memo: WeakMap<object, unknown>;
    mode: StackMode;
    /** The objects on the current path: meeting one again is a cycle. */
    path: Set<object>;
}

const newEncoding = (errors: ErrorEncoding, mode: StackMode, mask: (record: LoggedError) => unknown, child?: (value: unknown) => unknown): Encoding => {
    return { ...(child === undefined ? {} : { child }), errors, mask, memo: new WeakMap(), mode, path: new Set() };
};

/** Encode `value` once per object: a cycle is left out, a shared reference reuses its first encoding. */
const once = (value: object, encoding: Encoding, encode: () => unknown): unknown => {
    if (encoding.path.has(value)) {
        return undefined;
    }

    if (encoding.memo.has(value)) {
        return encoding.memo.get(value);
    }

    encoding.path.add(value);

    try {
        const encoded = encode();

        encoding.memo.set(value, encoded);

        return encoded;
    } finally {
        encoding.path.delete(value);
    }
};

/**
 * Set an own, enumerable field. Assignment would treat a `__proto__` key as the prototype and
 * drop the field, so the field is defined instead.
 */
const setField = (target: LogFields, key: string, value: unknown): void => {
    Object.defineProperty(target, key, { configurable: true, enumerable: true, value, writable: true });
};

/**
 * One {@link LoggedError} level. An Error on its own path (a `cause` cycle) or
 * deeper than {@link MAX_ERROR_DEPTH} keeps only its name and message, so the walk
 * always ends; the same Error met again elsewhere (twice in an `AggregateError`)
 * is written in full both times.
 */
const loggedErrorAt = (error: Error, encoding: Encoding, depth: number): unknown => {
    if (encoding.path.has(error) || depth > MAX_ERROR_DEPTH) {
        return { message: error.message, name: error.name };
    }

    return once(error, encoding, () => {
        // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion: a nested value re-enters `encodeTree`
        const nested = (value: unknown): unknown =>
            value instanceof Error
                ? loggedErrorAt(value, encoding, depth + 1)
                : (encoding.child ?? ((plain: unknown) => encodeTree(plain, encoding, 0, depth + 1)))(value);
        const minimal = encoding.mode === "minimal";
        const message = minimal && error.message.length > MINIMAL_MESSAGE_LENGTH ? `${error.message.slice(0, MINIMAL_MESSAGE_LENGTH)}…` : error.message;
        const record: LoggedError = { message, name: error.name };

        if (!minimal) {
            for (const [key, value] of Object.entries(error)) {
                if (key !== "message" && key !== "name") {
                    setField(record, key, nested(value));
                }
            }
        }

        const stack = stackFor(error.stack, encoding.mode, depth);

        if (stack !== undefined) {
            record.stack = stack;
        }

        if (error.cause !== undefined) {
            record.cause = nested(error.cause);
        }

        if (error instanceof AggregateError && Array.isArray(error.errors)) {
            record.errors = error.errors.slice(0, MAX_AGGREGATE_ERRORS).map((member) => nested(member));
        }

        return encoding.mask(record);
    });
};

/**
 * `value` as a JSON-safe tree: each Error written per the encoding, plain objects
 * and arrays rebuilt, a bigint as its digits, and anything else as
 * `JSON.stringify` would write it. Errors are replaced before any `JSON.stringify`
 * runs, so an Error's own `toJSON` cannot hide it from the encoding.
 */
const encodeTree = (value: unknown, encoding: Encoding, depth: number, errorDepth: number): unknown => {
    if (value instanceof Error) {
        return encoding.errors === "full" ? loggedErrorAt(value, encoding, errorDepth) : String(value);
    }

    if (typeof value !== "object" || value === null || depth >= MAX_ERROR_SCAN_DEPTH || !(Array.isArray(value) || isPlainRecord(value))) {
        return jsonSafe(value);
    }

    return once(value, encoding, () =>
        Array.isArray(value)
            ? value.map((item) => encodeTree(item, encoding, depth + 1, errorDepth))
            : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, encodeTree(child, encoding, depth + 1, errorDepth)])),
    );
};

/** Length of `value`'s JSON, or `Infinity` when `JSON.stringify` throws: a record that cannot be written does not fit. */
const jsonLength = (value: unknown): number => {
    try {
        return JSON.stringify(value).length;
    } catch {
        return Number.POSITIVE_INFINITY;
    }
};

const unmasked = (record: LoggedError): LoggedError => record;

/**
 * An `Error` as a plain {@link LoggedError}: `name`, `message`, its own enumerable
 * fields, `stack`, the `cause` chain and up to ten `errors` of an
 * `AggregateError`, nested Errors in the same shape. `JSON.stringify` writes an
 * Error as `{}`, because all of those but the own fields are non-enumerable.
 *
 * Bounded on the object itself, so every caller gets the same caps: a cycle and
 * anything deeper than four levels keep only name and message, and when the JSON
 * would pass {@link MAX_ERROR_JSON_LENGTH} the stacks below the top Error are
 * dropped, then every stack is cut to a few lines, then dropped, then the own
 * fields go and the messages are cut.
 *
 * `child` converts an own-field value, and a `cause` or `errors` member that is
 * not an Error. The default keeps what `JSON.stringify` can write and leaves out
 * what it would throw on.
 */
export const toLoggedError = (error: Error, child: (value: unknown) => unknown = jsonSafe): LoggedError => {
    let logged: unknown;

    for (const mode of STACK_MODES) {
        logged = loggedErrorAt(error, newEncoding("full", mode, unmasked, child), 0);

        if (jsonLength(logged) <= MAX_ERROR_JSON_LENGTH) {
            break;
        }
    }

    return logged as LoggedError;
};

/**
 * A field value holding an Error, as JSON. `"headline"` writes each Error as its
 * `Name: message`. `"full"` writes each as a {@link LoggedError}, stepping through
 * {@link STACK_MODES} until the whole field (every Error in it, and what sits
 * beside them) fits {@link MAX_ERROR_JSON_LENGTH}.
 */
const encodeErrorField = (value: unknown, errors: ErrorEncoding, mask: (record: LoggedError) => unknown): string | undefined => {
    if (errors === "headline") {
        return JSON.stringify(encodeTree(value, newEncoding("headline", "none", mask), 0, 0)) as string | undefined;
    }

    let json: string | undefined;

    for (const mode of STACK_MODES) {
        json = JSON.stringify(encodeTree(value, newEncoding("full", mode, mask), 0, 0)) as string | undefined;

        if (json === undefined || json.length <= MAX_ERROR_JSON_LENGTH) {
            break;
        }
    }

    return json;
};

/**
 * Coerce a field value to a JSON-safe, OTLP-`AnyValue`-encodable primitive:
 * booleans / numbers / strings pass through (a non-finite number is left for the
 * OTLP encoder to stringify); everything else is JSON-encoded, with a `String()`
 * fallback for a value that cannot be read or written (a throwing getter, a
 * bigint the encoder does not reach). An `Error`, at the top or nested in plain
 * objects and arrays, is written per `errors` (see {@link ErrorEncoding}): the
 * JSON of its {@link LoggedError} for `"full"`, `Name: message` for
 * `"headline"`. `mask` sees each logged Error's record before it is written, so a
 * credential among its own fields can be masked by key. This is what makes a
 * normalized fields bag safe to `JSON.stringify` wholesale.
 */
export const coerceFieldValue = (
    value: unknown,
    errors: ErrorEncoding = "headline",
    mask: (record: LoggedError) => unknown = unmasked,
): boolean | number | string => {
    if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
        return value;
    }

    try {
        // `stringifyFieldValue` writes a top-level Error as its `Name: message` string.
        if (!containsError(value) || (errors === "headline" && value instanceof Error)) {
            return stringifyFieldValue(value);
        }

        return encodeErrorField(value, errors, mask) ?? String(value);
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

/**
 * The chain below one Error: its headline, its stack frames, then each `errors` member and the `cause`, each level two
 * spaces further in. Capped like the encoding ({@link MAX_ERROR_DEPTH} levels, {@link MAX_AGGREGATE_ERRORS} members):
 * a field is any JSON string a caller logged, and a chain deep enough would overflow the stack of whatever renders it.
 */
const errorChain = (error: LoggedError, indent: string, depth = 0): string[] => {
    const nested = `${indent}  `;
    const lines = [errorHeadline(error), ...stackFrames(error).map((frame) => `${nested}${frame}`)];
    const member = (label: string, value: unknown): string => {
        const inner = nestedError(value);

        if (inner === undefined) {
            return `${indent}${label}: ${stringifyFieldValue(value)}`;
        }

        return `${indent}${label}: ${depth >= MAX_ERROR_DEPTH ? errorHeadline(inner) : errorChain(inner, nested, depth + 1).join("\n")}`;
    };

    if (Array.isArray(error.errors)) {
        error.errors.slice(0, MAX_AGGREGATE_ERRORS).forEach((value, index) => {
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
 * Normalize a (possibly merged) fields bag into the canonical shape every log
 * surface stores and ships: a **fresh** object (so a caller mutating the logged
 * object afterwards can't alter a buffered/queued copy), every value coerced to
 * a JSON-safe primitive (so the in-memory buffer's `getLogs` `JSON.stringify`
 * can never throw on a `bigint`/circular value; an `Error` is written per
 * `errors`, and its record passed through `mask`, see {@link coerceFieldValue}), or `undefined` for an
 * absent/empty bag (so an empty `{}` doesn't ride every destination). Bound
 * `.with(...)` fields are merged under the per-call fields (per-call wins).
 */
export const normalizeLogFields = (
    perCall: LogFields | undefined,
    bound?: LogFields,
    errors: ErrorEncoding = "headline",
    mask: (record: LoggedError) => unknown = unmasked,
): LogFields | undefined => {
    if (perCall === undefined && bound === undefined) {
        return undefined;
    }

    const merged: LogFields = {};

    if (bound !== undefined) {
        for (const [key, value] of Object.entries(bound)) {
            setField(merged, key, coerceFieldValue(value, errors, mask));
        }
    }

    if (perCall !== undefined) {
        for (const [key, value] of Object.entries(perCall)) {
            setField(merged, key, coerceFieldValue(value, errors, mask));
        }
    }

    return Object.keys(merged).length === 0 ? undefined : merged;
};

/** Logged Errors listed from inside one field, at most; the rest of the field still shows as its text. */
const MAX_NESTED_LOGGED_ERRORS = 10;

/** A field value parsed when it is a serialized object or array, as it is when it is not a string, else `undefined`. */
const parsedJson = (value: unknown): unknown => {
    if (typeof value !== "string") {
        return value;
    }

    if (!(value.startsWith("{") && value.endsWith("}")) && !(value.startsWith("[") && value.endsWith("]"))) {
        return undefined;
    }

    try {
        return JSON.parse(value);
    } catch {
        return undefined;
    }
};

/**
 * Collect the logged Errors inside a field's parsed value (`{ attempt: { err } }`, an array of them), each under its
 * path below the field. Bounded like the encoding: {@link MAX_ERROR_SCAN_DEPTH} levels, {@link MAX_NESTED_LOGGED_ERRORS} Errors.
 */
const collectNestedErrors = (value: unknown, path: string, depth: number, found: [string, LoggedError][]): void => {
    if (found.length >= MAX_NESTED_LOGGED_ERRORS || depth >= MAX_ERROR_SCAN_DEPTH || typeof value !== "object" || value === null) {
        return;
    }

    const error = parseLoggedError(value);

    if (error !== undefined) {
        found.push([path, error]);

        return;
    }

    if (Array.isArray(value)) {
        value.forEach((item, index) => {
            collectNestedErrors(item, `${path}[${String(index)}]`, depth + 1, found);
        });

        return;
    }

    for (const [key, child] of Object.entries(value)) {
        collectNestedErrors(child, `${path}.${key}`, depth + 1, found);
    }
};

/**
 * Read a fields bag for display, parsing each value once: `text` is the compact,
 * space-joined `key=value` pairs for a terminal or log row (`""` when there are
 * none, or the value isn't a plain object), with a logged Error shown as its
 * `Name: message` headline; `errors` holds those logged Errors, keyed by field
 * name (or by their path below it, `attempt.err`, for one nested inside a field),
 * for {@link formatLoggedErrorFields}.
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

            // An Error inside the field (`{ attempt: { err } }`) gets its detail too, under its path; the field reads as its JSON.
            const nested: [string, LoggedError][] = [];

            collectNestedErrors(parsedJson(value), key, 0, nested);
            errors.push(...nested);
        } else {
            errors.push([key, error]);
            pairs.push(`${key}=${errorHeadline(error)}`);
        }
    }

    return { errors, text: pairs.join(" ") };
};

/** The `text` of {@link readLogFields}: a fields bag as `key=value` pairs. Used where the logged Errors' detail is not shown. */
export const formatLogFields = (fields: unknown): string => readLogFields(fields).text;
