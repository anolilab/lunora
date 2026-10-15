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

/** Bytes as standard base64. Encoded in slices, so a large file never becomes one call's arguments. */
export const toBase64 = (bytes: Uint8Array): string => {
    let binary = "";

    for (let index = 0; index < bytes.length; index += 0x80_00) {
        binary += String.fromCodePoint(...bytes.subarray(index, index + 0x80_00));
    }

    return btoa(binary);
};
