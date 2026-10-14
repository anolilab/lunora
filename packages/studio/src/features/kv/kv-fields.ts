/**
 * Pure, React-free helpers shared by the KV value editor and create form:
 * value/TTL/metadata parsing + the single `putKvValue` payload contract. Kept
 * here (not inlined in a component) so the KV-put invariant lives in one place
 * and is unit-testable without rendering.
 */

/** Options for `client.putKvValue`, assembled by {@link buildKvPutOptions}. */
interface KvPutOptions {
    expiration?: number;
    expirationTtl?: number;
    key: string;
    metadata?: unknown;
    namespace: string;
    value: string;
}

/** The raw editor/create-form field inputs a KV write is built from. */
interface KvPutFields {
    /** Metadata as a JSON string (`""` ⇒ no metadata). */
    metadata: string;
    /** TTL as a raw seconds string (`""` ⇒ no fresh TTL). */
    ttl: string;
    /** The value to store. */
    value: string;
}

/** Parse a TTL input into a positive integer of seconds, or `undefined` when blank/invalid. Internal to {@link buildKvPutOptions}. */
const parseTtl = (value: string): number | undefined => {
    const trimmed = value.trim();

    if (trimmed === "") {
        return undefined;
    }

    const seconds = Number(trimmed);

    return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : undefined;
};

/** Format a KV expiration (Unix seconds) as an ISO string, or an em dash when unset. */
export const formatExpiration = (expiration: number | undefined): string => (expiration === undefined ? "—" : new Date(expiration * 1000).toISOString());

/** UTF-8 byte length of a string — KV values are sized in bytes, not code points. */
export const byteLength = (value: string): number => new TextEncoder().encode(value).length;

/** Pretty-print `value` when it parses as JSON, else `undefined`. */
export const tryFormatJson = (value: string): string | undefined => {
    if (value.trim() === "") {
        return undefined;
    }

    try {
        return JSON.stringify(JSON.parse(value) as unknown, undefined, 2);
    } catch {
        return undefined;
    }
};

/** True when `value` is empty or parses as JSON — the guard for saving metadata. */
export const isJsonOrEmpty = (value: string): boolean => {
    if (value.trim() === "") {
        return true;
    }

    try {
        JSON.parse(value);

        return true;
    } catch {
        return false;
    }
};

/** TTL units the picker offers, with their seconds multiplier — the order they render in. */
export const TTL_UNITS = [
    { key: "seconds", seconds: 1 },
    { key: "minutes", seconds: 60 },
    { key: "hours", seconds: 3600 },
    { key: "days", seconds: 86_400 },
] as const;

/** One of the TTL picker's unit keys. */
export type TtlUnit = (typeof TTL_UNITS)[number]["key"];

/**
 * Convert a picker amount in `unit` to an integer-**seconds** string — the value
 * the seconds-based TTL contract expects. Blank → `""` (no expiry); a
 * non-numeric / non-positive amount is returned as-is so {@link isTtlValid} flags
 * it rather than this silently emitting a bogus value.
 */
export const ttlToSeconds = (amount: string, unit: TtlUnit): string => {
    const trimmed = amount.trim();

    if (trimmed === "") {
        return "";
    }

    const value = Number(trimmed);
    const perUnit = TTL_UNITS.find((option) => option.key === unit)?.seconds ?? 1;

    return Number.isFinite(value) && value > 0 ? String(Math.round(value * perUnit)) : trimmed;
};

/**
 * True when the TTL input is empty (no expiry) or a whole number ≥ 60 seconds —
 * Cloudflare KV rejects any `expirationTtl` under 60, so this gates the write
 * client-side rather than round-tripping to a server error.
 */
export const isTtlValid = (value: string): boolean => {
    const trimmed = value.trim();

    if (trimmed === "") {
        return true;
    }

    const seconds = Number(trimmed);

    return Number.isInteger(seconds) && seconds >= 60;
};

/**
 * Assemble the `putKvValue` payload from raw field inputs — the single source of
 * the KV-write contract shared by the editor and create form. A fresh TTL wins;
 * otherwise `existingExpiration` (the key's stored absolute expiry) is re-sent so
 * an edit doesn't silently drop the TTL. Empty metadata → `undefined`. Assumes
 * metadata is valid JSON — guard with {@link isJsonOrEmpty} at the call site.
 */
export const buildKvPutOptions = (fields: KvPutFields, key: string, namespace: string, existingExpiration?: number): KvPutOptions => {
    const ttl = parseTtl(fields.ttl);

    return {
        expiration: ttl === undefined ? existingExpiration : undefined,
        expirationTtl: ttl,
        key,
        metadata: fields.metadata.trim() === "" ? undefined : (JSON.parse(fields.metadata) as unknown),
        namespace,
        value: fields.value,
    };
};

export type { KvPutFields, KvPutOptions };
