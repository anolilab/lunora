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

    return typeof value;
};

export const formatPath = (path: ValidationPath): string => {
    if (path.length === 0) {
        return "<root>";
    }

    return path
        .map((segment, index) => {
            if (typeof segment === "number") {
                return `[${segment}]`;
            }

            return index === 0 ? segment : `.${segment}`;
        })
        .join("");
};
