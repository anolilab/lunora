import { LunoraError } from "@lunora/errors";

/** Max characters of a stringified primitive surfaced in `received`. */
const MAX_DESCRIBED_LENGTH = 80;

const truncate = (text: string): string => (text.length > MAX_DESCRIBED_LENGTH ? `${text.slice(0, MAX_DESCRIBED_LENGTH)}…` : text);

/**
 * Describe a non-null object value: plain objects (literal / null-prototype)
 * stay as bare `"object"`; named instances (Date, Map, custom classes) surface
 * their constructor name.
 *
 * The constructor is read off the PROTOTYPE, never the value itself: a parsed
 * request body `{"constructor":{"name":"…"}}` carries `constructor` as an own
 * data property, which is client text, not a class — echoing it made every
 * public arg a reflection point and the only `received` with no length cap.
 * A genuine name is capped like the primitive branches. Reading the prototype
 * or `name` can still trigger a hostile getter (or proxy trap) that throws;
 * this is the error/diagnostic path, so any such throw is swallowed and the
 * bare descriptor returned rather than masking the real validation error.
 */
const describeObject = (value: object): string => {
    try {
        const prototype = Object.getPrototypeOf(value) as { constructor?: { name?: unknown } } | null;
        const constructorName = prototype?.constructor?.name;

        if (typeof constructorName === "string" && constructorName !== "" && constructorName !== "Object") {
            return `object ${truncate(constructorName)}`;
        }
    } catch {
        return "object";
    }

    return "object";
};

export type ValidationPath = ReadonlyArray<number | string>;

/**
 * Thrown by `validator.parse` (or returned inside `safeParse`) when input does
 * not match the validator's shape. `path` walks from the root to the offending
 * value, e.g. `["users", 0, "email"]`.
 *
 * A `LunoraError` subclass: carries `code: "VALIDATION_ERROR"` and `status: 400`
 * so the runtime/DO transport mappers surface it structurally (a request that
 * fails validation is a 400), while keeping the `name: "ValidationError"` and the
 * `path`/`expected`/`received` diagnostics.
 */
export class ValidationError extends LunoraError {
    public readonly path: ValidationPath;

    public readonly expected: string;

    public readonly received: string;

    public constructor(message: string, options: { expected: string; path: ValidationPath; received: string }) {
        super("VALIDATION_ERROR", message, { name: "ValidationError" });
        this.path = options.path;
        this.expected = options.expected;
        this.received = options.received;
    }
}

/**
 * Render a short, diagnostic description of a runtime value for the `received`
 * field of a {@link ValidationError}. Primitives carry their concrete (length-
 * capped) literal so messages distinguish `string "7"` from `number 7`;
 * non-plain objects carry their constructor name (e.g. `Date`) so a class
 * instance is not flattened to a bare `"object"`.
 *
 * Pass `{ literal: false }` to suppress the concrete primitive literal and
 * return only the type tag (`"string"`, `"number"`, `"bigint"`, …). This is used
 * on `.check()` refinement failures — where the value already passed its type
 * check — so a secret-bearing field (password, token) never surfaces its value
 * in the `ValidationError.message`/`received` that goes to the wire and logs.
 */
export const describeValue = (value: unknown, options?: { literal?: boolean }): string => {
    const literal = options?.literal ?? true;

    if (value === null) {
        return "null";
    }

    if (Array.isArray(value)) {
        return "array";
    }

    if (value instanceof ArrayBuffer) {
        return "ArrayBuffer";
    }

    if (typeof value === "string") {
        return literal ? `string ${truncate(JSON.stringify(value))}` : "string";
    }

    if (typeof value === "number" || typeof value === "boolean") {
        return literal ? `${typeof value} ${String(value)}` : typeof value;
    }

    if (typeof value === "bigint") {
        return literal ? `bigint ${value.toString()}n` : "bigint";
    }

    if (typeof value === "object") {
        return describeObject(value);
    }

    return typeof value;
};

export const formatPath = (path: ValidationPath): string => {
    if (path.length === 0) {
        return "<root>";
    }

    return path
        .map((segment, index) => {
            if (typeof segment === "number") {
                return `[${String(segment)}]`;
            }

            return index === 0 ? segment : `.${segment}`;
        })
        .join("");
};
