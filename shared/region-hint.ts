/**
 * Edge geography → placement region, shared by `@lunora/runtime` (which reads
 * `request.cf` to pick where a shard, replica, or region-local socket should
 * live) and `@lunora/do` (which parses a region out of its own DO name). Kept
 * here — inlined into each consumer's bundle — so the two sides can never drift
 * on the region vocabulary without creating a runtime dependency edge between
 * the packages.
 *
 * The values are Cloudflare's Durable Object location hints, which is also the
 * only vocabulary a Lunora deployment needs today: a region is *only* ever used
 * as a placement hint and as a name segment, never as data. Wrong-but-close is
 * fine by construction — a misrouted read is one longer hop, never a wrong
 * answer — so this maps coarsely and returns `undefined` rather than guessing
 * when the request carries no usable geography.
 *
 * Zero-dependency by design (see the repo's `shared/` rules): only relative /
 * builtin imports, named exports, no `.js` extensions.
 */

/**
 * The placement regions a name may carry and a hint may request — Cloudflare's
 * `DurableObjectLocationHint` values, listed so the set can be validated at a
 * trust boundary (a region parsed out of a DO name is attacker-influenced input
 * on any route that mints names from a client-supplied shard key).
 */
const REGION_HINTS = ["wnam", "enam", "sam", "weur", "eeur", "apac", "apac-ne", "apac-se", "oc", "afr", "me"] as const;

/** One placement region. Structurally identical to Cloudflare's `DurableObjectLocationHint`. */
type RegionHint = (typeof REGION_HINTS)[number];

const REGION_HINT_SET: ReadonlySet<string> = new Set<string>(REGION_HINTS);

/** Whether `value` is one of the known placement regions. */
const isRegionHint = (value: unknown): value is RegionHint => typeof value === "string" && REGION_HINT_SET.has(value);

/**
 * The geography fields Cloudflare puts on `request.cf`. All optional: `cf` is
 * absent entirely for a synthesized subrequest, and individual fields are absent
 * for traffic Cloudflare could not geolocate.
 */
interface EdgeGeo {
    /** `request.cf.continent` — `AF` `AN` `AS` `EU` `NA` `OC` `SA`. */
    continent?: string;
    /** `request.cf.country` — ISO 3166-1 alpha-2. */
    country?: string;
    /** `request.cf.longitude` — Cloudflare sends a stringified float. */
    longitude?: number | string;
}

/**
 * Countries the `me` region serves better than `apac`. Cloudflare has no
 * "Middle East" continent code, so the country is the only signal that
 * separates the two.
 */
const MIDDLE_EAST: ReadonlySet<string> = new Set(["AE", "BH", "IL", "IQ", "IR", "JO", "KW", "LB", "OM", "PS", "QA", "SA", "SY", "TR", "YE"]);

/** Longitude splitting `wnam` from `enam`: the 100th meridian, which divides the continent's population usefully. */
const NORTH_AMERICA_MERIDIAN = -100;

/** Longitude splitting `weur` from `eeur`: ~15°E, roughly Berlin/Vienna. */
const EUROPE_MERIDIAN = 15;

/**
 * Map edge geography to a placement region, or `undefined` when the request
 * carries no continent (or one with no region — `AN`). `undefined` means "no
 * hint": the caller then leaves placement to the platform's own default, which
 * on Cloudflare is the data centre nearest the first request. Defaulting to a
 * fixed region instead would be strictly worse — it would drag every
 * ungeolocatable request's shard to one continent.
 */
const regionHintFromGeo = (geo: EdgeGeo): RegionHint | undefined => {
    const longitude = Number(geo.longitude ?? Number.NaN);

    switch (geo.continent) {
        case "AF": {
            return "afr";
        }
        case "AS": {
            return geo.country !== undefined && MIDDLE_EAST.has(geo.country) ? "me" : "apac";
        }
        case "EU": {
            return Number.isFinite(longitude) && longitude > EUROPE_MERIDIAN ? "eeur" : "weur";
        }
        case "NA": {
            return Number.isFinite(longitude) && longitude < NORTH_AMERICA_MERIDIAN ? "wnam" : "enam";
        }
        case "OC": {
            return "oc";
        }
        case "SA": {
            return "sam";
        }
        default: {
            return undefined;
        }
    }
};

/**
 * The placement region for the caller behind `request`, read off Cloudflare's
 * `request.cf`. Returns `undefined` for a request with no `cf` — every
 * synthesized subrequest (the shard RPC envelope, an internal admin fan-out) is
 * in that class, which is why callers that need the *client's* region must
 * derive it from the inbound request and pass it down rather than re-reading it
 * from whatever request they happen to be forwarding.
 */
const regionHintFromRequest = (request: Request): RegionHint | undefined => {
    const geo = (request as { cf?: EdgeGeo }).cf;

    return geo === undefined ? undefined : regionHintFromGeo(geo);
};

export type { EdgeGeo, RegionHint };
export { isRegionHint, REGION_HINTS, regionHintFromGeo, regionHintFromRequest };
