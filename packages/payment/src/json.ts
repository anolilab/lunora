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

/**
 * Epoch milliseconds from the first of `keys` holding a usable time: a `Date` (SDK responses parsed
 * by zod), an epoch-ms number, or a `Date`-parseable string (ISO-8601 in raw webhook bodies). Reading
 * all three here keeps an adapter's SDK path and webhook path from diverging. `undefined` when none parses.
 */
export const readEpochMs = (object: Record<string, unknown>, ...keys: ReadonlyArray<string>): number | undefined => {
    for (const key of keys) {
        const value = object[key];
        let ms = Number.NaN;

        if (value instanceof Date) {
            ms = value.getTime();
        } else if (typeof value === "number") {
            ms = value;
        } else if (typeof value === "string") {
            ms = Date.parse(value);
        }

        if (Number.isFinite(ms)) {
            return ms;
        }
    }

    return undefined;
};

/** Unix seconds (Stripe's unit for every timestamp) to epoch milliseconds. */
export const secondsToMs = (seconds: number | undefined): number | undefined => (seconds === undefined ? undefined : seconds * 1000);
