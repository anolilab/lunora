/**
 * Field rules shared by the catalog's manifest, index and publisher, and the small
 * helpers those modules share. Each rule and helper lives here once, so the publisher
 * can refuse what the control plane would refuse.
 */

/** A catalog app's slug: lowercase letters, digits and hyphens. */
export const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/u;

/** A lowercase hex SHA-256 digest. */
export const SHA256 = /^[0-9a-f]{64}$/u;

/** A version string the catalog accepts: non-empty and bounded. */
export const MAX_VERSION_LENGTH = 64;

/** An app's display name, in characters. */
export const MAX_NAME_LENGTH = 80;

/** An app's one-line summary, in characters. */
export const MAX_SUMMARY_LENGTH = 200;

/** Whether a string is an https URL. */
export const isHttpsUrl = (value: string): boolean => {
    try {
        return new URL(value).protocol === "https:";
    } catch {
        return false;
    }
};

/** Whether a value is a version the catalog accepts: non-empty and bounded. */
export const isVersion = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_VERSION_LENGTH;

/** Whether a value is a plain object: not `null`, and not an array. */
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A caught value's message: an Error's own text, otherwise the value as a string. */
export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Bytes as lowercase hex. */
export const toHex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * Bytes per slice {@link toBase64} encodes: a multiple of 3, so every slice but the last
 * encodes without padding and the slices concatenate into one base64 string.
 */
const BASE64_SLICE_BYTES = 3 * 0x20_00;

/**
 * Bytes as standard base64. Each slice is encoded on its own, so a large file never
 * becomes one call's arguments, and no binary string the size of the whole file is
 * built next to the bytes and their base64 (a 48 MiB main module would otherwise hold
 * about four copies of itself against the isolate's 128 MB).
 */
export const toBase64 = (bytes: Uint8Array): string => {
    let encoded = "";

    for (let index = 0; index < bytes.length; index += BASE64_SLICE_BYTES) {
        encoded += btoa(String.fromCodePoint(...bytes.subarray(index, index + BASE64_SLICE_BYTES)));
    }

    return encoded;
};
