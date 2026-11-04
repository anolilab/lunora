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
    // display form; a fields bag keeps the whole Error (see `coerceFieldValue`).
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

/** `cause` / `errors` levels kept below a logged Error. A deeper Error keeps only its name and message. */
const MAX_ERROR_DEPTH = 4;

/** Members of an `AggregateError`'s `errors` that are kept. */
const MAX_AGGREGATE_ERRORS = 10;

/**
 * Longest JSON a field value holding an Error is allowed before stacks are cut.
 * Redaction cuts every string at 4 KiB (`shared/credential-redaction.ts`), and a
 * cut JSON string no longer parses, so the terminal and Studio could not show the
 * error at all. The headroom absorbs masking, which can lengthen a short secret.
 */
const MAX_ERROR_JSON_LENGTH = 3584;

/** Stack lines kept per Error once the full stacks do not fit {@link MAX_ERROR_JSON_LENGTH}. */
const SHORT_STACK_LINES = 4;

/** Which stacks a serialization keeps, from the fullest to none, tried in order until the JSON fits. */
type StackMode = "all" | "none" | "root" | "short";

const STACK_MODES: readonly StackMode[] = ["all", "root", "short", "none"];

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
 * `JSON.stringify` writes an `Error` as `{}`: `name`, `message`, `stack`, `cause`
 * and `errors` are all non-enumerable. This replacer writes each Error it meets as
 * a {@link LoggedError}. An Error met a second time (a `cause` cycle) or nested
 * deeper than {@link MAX_ERROR_DEPTH} keeps only its name and message, so the walk
 * always ends. `found` is set when any Error was written.
 */
const errorReplacer = (mode: StackMode, ownFields: boolean, found: { error: boolean }): ((key: string, value: unknown) => unknown) => {
    // Allocated on the first Error: every object field is serialized through this
    // replacer on the Durable Object's only thread, and most hold no Error at all.
    let seen: WeakSet<Error> | undefined;
    let depths: WeakMap<object, number> | undefined;

    return function replace(this: unknown, _key: string, value: unknown): unknown {
        if (typeof value !== "object" || value === null) {
            return value;
        }

        const parentDepth = depths !== undefined && typeof this === "object" && this !== null ? depths.get(this) : undefined;

        if (!(value instanceof Error)) {
            if (parentDepth !== undefined) {
                depths?.set(value, parentDepth);
            }

            return value;
        }

        found.error = true;
        seen ??= new WeakSet<Error>();
        depths ??= new WeakMap<object, number>();

        const depth = parentDepth === undefined ? 0 : parentDepth + 1;

        if (seen.has(value) || depth > MAX_ERROR_DEPTH) {
            return { message: value.message, name: value.name };
        }

        seen.add(value);

        const record: Record<string, unknown> = { ...(ownFields ? value : {}), message: value.message, name: value.name };
        const stack = stackFor(value.stack, mode, depth);

        if (stack !== undefined) {
            record.stack = stack;
        }

        if (value.cause !== undefined) {
            record.cause = value.cause;
        }

        if (value instanceof AggregateError && Array.isArray(value.errors)) {
            const errors = value.errors.slice(0, MAX_AGGREGATE_ERRORS);

            depths.set(errors, depth);
            record.errors = errors;
        }

        depths.set(record, depth);

        return record;
    };
};

/**
 * JSON for a field value that is or contains an `Error`, with each Error written
 * as a {@link LoggedError}. When an Error is present and the result is longer than
 * {@link MAX_ERROR_JSON_LENGTH}, stacks are dropped below the top Error, then cut
 * to a few lines, then dropped; JSON still over the limit after that (a long
 * message, large own fields) is returned as is, and redaction may cut it. Throws
 * like `JSON.stringify` on a cycle that runs through something other than an Error.
 */
const stringifyWithErrors = (value: unknown, ownFields = true): string | undefined => {
    let json: string | undefined;

    for (const mode of STACK_MODES) {
        const found = { error: false };

        json = JSON.stringify(value, errorReplacer(mode, ownFields, found)) as string | undefined;

        if (!found.error || json === undefined || json.length <= MAX_ERROR_JSON_LENGTH) {
            return json;
        }
    }

    return json;
};

/**
 * Coerce a field value to a JSON-safe, OTLP-`AnyValue`-encodable primitive:
 * booleans / numbers / strings pass through (a non-finite number is left for the
 * OTLP encoder to stringify); everything else is JSON-encoded, with a `String()`
 * fallback for a value `JSON.stringify` rejects. An `Error`, at the top or nested,
 * is written as a {@link LoggedError} (see {@link stringifyWithErrors}), so its
 * stack and `cause` chain reach every destination. This is what makes a
 * normalized fields bag safe to `JSON.stringify` wholesale.
 */
export const coerceFieldValue = (value: unknown): boolean | number | string => {
    if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
        return value;
    }

    try {
        return stringifyWithErrors(value) ?? String(value);
    } catch {
        // A cycle may run through an Error's own fields: retry without them, so the
        // stack and cause survive. Anything still unserializable renders the way `console` does.
    }

    if (value instanceof Error) {
        try {
            return stringifyWithErrors(value, false) ?? String(value);
        } catch {
            // A cycle through a `cause` value that is not an Error.
        }
    }

    return String(value);
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The {@link LoggedError} a normalized field value holds, or `undefined` for any
 * other value. Only a JSON object with a string `name` and `message` plus a
 * `stack`, `cause` or `errors` counts, so a plain `{ name, message }` the caller
 * logged stays ordinary JSON. A string that does not parse (redaction cut it)
 * is not an error either; renderers show it as it is.
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

    if (!isRecord(parsed) || typeof parsed.name !== "string" || typeof parsed.message !== "string") {
        return undefined;
    }

    return typeof parsed.stack === "string" || parsed.cause !== undefined || Array.isArray(parsed.errors) ? (parsed as LoggedError) : undefined;
};

/** `Name: message`, the one-line form of a logged Error. */
const errorHeadline = (error: LoggedError): string => (error.message === "" ? error.name : `${error.name}: ${error.message}`);

/** The lines of one Error: its stack (which starts with its headline), or the headline alone. */
const errorLines = (error: LoggedError): string[] => {
    const stack = typeof error.stack === "string" && error.stack !== "" ? error.stack : errorHeadline(error);

    return stack.split("\n").map((line) => line.trimEnd());
};

/**
 * A `cause` or `errors` member written by the serializer. Looser than
 * {@link parseLoggedError}: inside a logged Error, a cycle-cut or too-deep Error is
 * written as a bare `{ name, message }`.
 */
const nestedError = (value: unknown): LoggedError | undefined =>
    isRecord(value) && typeof value.name === "string" && typeof value.message === "string" ? (value as LoggedError) : undefined;

/** The chain below one Error, each level indented two spaces further than its parent. */
const errorChain = (error: LoggedError, indent: string): string[] => {
    const lines = errorLines(error).map((line, index) =>
        index === 0 ? line : `${indent}${line.trimStart().startsWith("at ") ? "  " : ""}${line.trimStart()}`,
    );
    const nested = `${indent}  `;

    if (Array.isArray(error.errors)) {
        error.errors.forEach((member, index) => {
            const inner = nestedError(member);

            lines.push(
                inner === undefined
                    ? `${indent}errors[${String(index)}]: ${stringifyFieldValue(member)}`
                    : `${indent}errors[${String(index)}]: ${errorChain(inner, nested).join("\n")}`,
            );
        });
    }

    if (error.cause !== undefined) {
        const inner = nestedError(error.cause);

        lines.push(
            inner === undefined ? `${indent}caused by: ${stringifyFieldValue(error.cause)}` : `${indent}caused by: ${errorChain(inner, nested).join("\n")}`,
        );
    }

    return lines;
};

/**
 * The multi-line form of a logged Error: its stack, then each `errors` member and
 * the `cause` chain, indented below it. `Name: message` alone when there is no stack.
 */
export const formatLoggedError = (error: LoggedError, indent = "  "): string => errorChain(error, indent).join("\n");

/** The top-level field values of a fields bag that hold a logged Error, keyed by field name. */
export const loggedErrorFields = (fields: unknown): [string, LoggedError][] => {
    if (!isRecord(fields)) {
        return [];
    }

    const found: [string, LoggedError][] = [];

    for (const [key, value] of Object.entries(fields)) {
        const error = parseLoggedError(value);

        if (error !== undefined) {
            found.push([key, error]);
        }
    }

    return found;
};

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
 * can never throw on a `bigint`/circular value; an `Error` becomes the JSON of a
 * {@link LoggedError}, see {@link coerceFieldValue}), or `undefined` for an
 * absent/empty bag (so an empty `{}` doesn't ride every destination). Bound
 * `.with(...)` fields are merged under the per-call fields (per-call wins).
 */
export const normalizeLogFields = (perCall: LogFields | undefined, bound?: LogFields): LogFields | undefined => {
    if (perCall === undefined && bound === undefined) {
        return undefined;
    }

    const merged: LogFields = {};

    if (bound !== undefined) {
        for (const [key, value] of Object.entries(bound)) {
            setField(merged, key, coerceFieldValue(value));
        }
    }

    if (perCall !== undefined) {
        for (const [key, value] of Object.entries(perCall)) {
            setField(merged, key, coerceFieldValue(value));
        }
    }

    return Object.keys(merged).length === 0 ? undefined : merged;
};

/**
 * Render a fields bag as compact, space-joined `key=value` pairs for a terminal
 * or log-row display, or `""` when there are none / the value isn't a plain
 * object. A logged Error renders as its `Name: message` headline here; its stack
 * and `cause` chain are {@link formatLoggedError}'s, shown separately. Used by the dev-terminal formatter (`@lunora/config`) and the Studio
 * Logs panel (`@lunora/studio`).
 */
export const formatLogFields = (fields: unknown): string => {
    if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
        return "";
    }

    return Object.entries(fields)
        .map(([key, value]) => {
            const error = parseLoggedError(value);

            return `${key}=${error === undefined ? stringifyFieldValue(value) : errorHeadline(error)}`;
        })
        .join(" ");
};
