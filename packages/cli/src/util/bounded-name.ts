import { createHash } from "node:crypto";

const NON_NAME_CHARACTER = /[^a-z0-9-]/gu;
const TRAILING_DASH = /-$/u;

/** Characters of the hash that closes a shortened name, with its dash. */
const HASH_SUFFIX = 7;

/**
 * `raw` in Cloudflare's resource-name alphabet (lowercase letters, digits, dashes), at most `limit` characters.
 * A name that needed no change keeps its readable form. One that was cleaned (`billing_api` and `billing-api`
 * would both read `billing-api`) or is too long is cut and closed with a short hash of the original, so two
 * names that share a prefix or differ only in punctuation still get names of their own.
 */
const boundedName = (raw: string, limit: number): string => {
    const lower = raw.toLowerCase();
    const identity = lower.replaceAll(NON_NAME_CHARACTER, "-");

    if (identity === lower && identity.length <= limit) {
        return identity;
    }

    const hash = createHash("sha256")
        .update(lower)
        .digest("hex")
        .slice(0, HASH_SUFFIX - 1);

    return `${identity.slice(0, limit - HASH_SUFFIX).replace(TRAILING_DASH, "")}-${hash}`;
};

export default boundedName;
