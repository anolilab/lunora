/**
 * A tiny kebab-slug helper shared by the registry-item placeholder prompts
 * (R2 bucket name, D1 database name). Cloudflare resource names are restricted
 * to lowercase letters, digits and hyphens with length bounds, so we coerce
 * arbitrary user/project text into that shape rather than letting an invalid
 * value reach wrangler.
 */

/** Runs of characters not allowed in a resource slug (anything but lowercase a–z / 0–9). */
const INVALID_SLUG_CHARS = /[^a-z0-9]+/u;

/**
 * Coerce arbitrary text into a lowercase kebab slug within `[min, max]` length,
 * or `undefined` when nothing valid can be salvaged. Lowercases, splits on every
 * run of invalid chars (dropping empty leading/trailing segments), rejoins with
 * single hyphens, clamps to `max`, and strips any hyphen the clamp left dangling.
 */
const toKebabSlug = (input: string, min: number, max: number): string | undefined => {
    let slug = input.toLowerCase().split(INVALID_SLUG_CHARS).filter(Boolean).join("-").slice(0, max);

    if (slug.endsWith("-")) {
        slug = slug.slice(0, -1);
    }

    return slug.length >= min ? slug : undefined;
};

export default toKebabSlug;
