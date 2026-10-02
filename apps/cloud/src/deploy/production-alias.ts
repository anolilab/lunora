/**
 * A project's production alias, chosen when the project is created
 * (`projects.create`) so its first production release cannot collide.
 *
 * An alias is global: it names the tenant's Worker (the dispatch-namespace
 * script) and its public hostname `{alias}.{LUNORA_APP_DOMAIN}`, and the
 * `aliasOwnership` ledger gives each to exactly one project. A project's slug
 * is only unique inside its organization, so the first production release —
 * which used to take the wrangler `name`, then the slug — failed whenever
 * another organization already owned that label. The project now claims its
 * alias up front, from {@link productionAliasCandidates}: the slug, then the
 * slug with a short form of the organization id, then that with a random
 * suffix.
 */

/** Longest alias: one DNS label. */
const MAX_ALIAS_LENGTH = 63;

/** Characters of the organization id in the second candidate. */
const ORG_SUFFIX_LENGTH = 8;

/** Random characters in the last-resort candidates. */
const RANDOM_SUFFIX_LENGTH = 4;

/** Last-resort candidates tried after the deterministic two. */
export const RANDOM_ATTEMPTS = 3;

/** Lowercase `[a-z0-9]` runs joined by single dashes — the alias grammar (`isAlias`). */
const toLabel = (value: string): string => {
    let label = "";

    for (const char of value.toLowerCase()) {
        if ((char >= "a" && char <= "z") || (char >= "0" && char <= "9")) {
            label += char;
        } else if (label !== "" && !label.endsWith("-")) {
            label += "-";
        }
    }

    return label.endsWith("-") ? label.slice(0, -1) : label;
};

/** `base`, cut so `-{suffix}` still fits one label, with the suffix appended. */
const withSuffix = (base: string, suffix: string): string => {
    const room = MAX_ALIAS_LENGTH - suffix.length - 1;
    const cut = base.length > room ? toLabel(base.slice(0, room)) : base;

    return `${cut}-${suffix}`;
};

/** `count` random `[a-z0-9]` characters. */
const randomSuffix = (count: number): string => {
    const bytes = new Uint8Array(count);

    crypto.getRandomValues(bytes);

    return [...bytes].map((byte) => (byte % 36).toString(36)).join("");
};

/**
 * The aliases a new project tries, in order: its slug as a label; the slug
 * with the first characters of its organization id (`acme-web-3f9a1c2e`),
 * which no other organization's project can produce from its own id; and, should
 * even that be taken (claimed by hand through a wrangler `name`), the latter
 * with {@link RANDOM_ATTEMPTS} random suffixes. A slug with no usable
 * character becomes `app`.
 */
export const productionAliasCandidates = (slug: string, organizationId: string, random: (count: number) => string = randomSuffix): string[] => {
    const base = toLabel(toLabel(slug).slice(0, MAX_ALIAS_LENGTH)) || "app";
    const organization = toLabel(organizationId).replaceAll("-", "").slice(0, ORG_SUFFIX_LENGTH) || "org";
    const scoped = withSuffix(base, organization);

    return [base, scoped, ...Array.from({ length: RANDOM_ATTEMPTS }, () => withSuffix(scoped, random(RANDOM_SUFFIX_LENGTH)))];
};
