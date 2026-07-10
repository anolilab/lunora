/**
 * Defensive accessors for parsed-but-untyped webhook payloads (provider events arrive as
 * `unknown` after JSON parsing). Shared by the provider adapters — never returns `any`.
 */

export const asRecord = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});

export const readString = (object: Record<string, unknown>, key: string): string | undefined => (typeof object[key] === "string" ? object[key] : undefined);

export const readNumber = (object: Record<string, unknown>, key: string): number | undefined => (typeof object[key] === "number" ? object[key] : undefined);

export const readBoolean = (object: Record<string, unknown>, key: string): boolean | undefined => (typeof object[key] === "boolean" ? object[key] : undefined);

/** First defined string among the given keys — tolerates snake_case vs. camelCase SDK/webhook generations. */
export const readAny = (object: Record<string, unknown>, ...keys: ReadonlyArray<string>): string | undefined => {
    for (const key of keys) {
        const value = readString(object, key);

        if (value !== undefined) {
            return value;
        }
    }

    return undefined;
};

/** First defined number among the given keys. */
export const readAnyNumber = (object: Record<string, unknown>, ...keys: ReadonlyArray<string>): number | undefined => {
    for (const key of keys) {
        const value = readNumber(object, key);

        if (value !== undefined) {
            return value;
        }
    }

    return undefined;
};

/** Read the framework-controlled `referenceId` string an adapter pins into an object's nested `metadata` on checkout. */
export const referenceFromMetadata = (object: Record<string, unknown>): string | undefined => readString(asRecord(object.metadata), "referenceId");

/** Parse a `Date`-parseable string field (e.g. ISO-8601) into epoch milliseconds; `undefined` when absent or unparseable. */
export const parseTimestamp = (value: null | string | undefined): number | undefined => {
    const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;

    return Number.isNaN(parsed) ? undefined : parsed;
};
