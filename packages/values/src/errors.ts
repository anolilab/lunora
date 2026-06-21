/** Max characters of a stringified primitive surfaced in `received`. */
const MAX_DESCRIBED_LENGTH = 80;

const truncate = (text: string): string => (text.length > MAX_DESCRIBED_LENGTH ? `${text.slice(0, MAX_DESCRIBED_LENGTH)}…` : text);

export type ValidationPath = ReadonlyArray<number | string>;

/**
 * Thrown by `validator.parse` (or returned inside `safeParse`) when input does
 * not match the validator's shape. `path` walks from the root to the offending
 * value, e.g. `["users", 0, "email"]`.
 */
export class ValidationError extends Error {
    public readonly path: ValidationPath;

    public readonly expected: string;

    public readonly received: string;

    public constructor(message: string, options: { expected: string; path: ValidationPath; received: string }) {
        super(message);
        this.name = "ValidationError";
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
 */
export const describeValue = (value: unknown): string => {
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
        return `string ${truncate(JSON.stringify(value))}`;
    }

    if (typeof value === "number" || typeof value === "boolean") {
        return `${typeof value} ${String(value)}`;
    }

    if (typeof value === "bigint") {
        return `bigint ${value.toString()}n`;
    }

    if (typeof value === "object") {
        // Plain objects (literal / null-prototype) stay as bare "object"; named
        // instances (Date, Map, custom classes) surface their constructor.
        // Reading `constructor`/`name` can trigger a hostile user getter that
        // throws; this is the error/diagnostic path, so swallow any such throw
        // and fall back to the bare descriptor rather than masking the real
        // validation error with an unrelated exception.
        try {
            const { constructor } = value as { constructor?: { name?: string } };
            const constructorName = constructor?.name;

            if (constructorName !== undefined && constructorName !== "Object") {
                return `object ${constructorName}`;
            }
        } catch {
            return "object";
        }

        return "object";
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
