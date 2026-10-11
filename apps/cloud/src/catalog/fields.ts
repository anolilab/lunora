/**
 * Field rules shared by the catalog's manifest, index and publisher. Each rule lives
 * here once, so the publisher can refuse what the control plane would refuse.
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
