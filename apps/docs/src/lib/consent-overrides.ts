import type { Overrides } from "@c15t/react";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";

// Geo headers across the CDNs the site may sit behind (Netlify sends
// "x-country"; the Cloudflare/Vercel/CloudFront names cost nothing to keep).
// Advisory only — a visitor spoofing one suppresses their own banner, nothing
// more, and absent headers fail safe (c15t defaults to GDPR → banner shown).
// Never use these values for anything enforcement-related.
const COUNTRY_HEADERS = ["x-country", "cf-ipcountry", "x-vercel-ip-country", "x-amz-cf-ipcountry", "x-country-code"] as const;

const REGION_HEADERS = ["x-vercel-ip-country-region", "x-region-code"] as const;

const ISO_COUNTRY = /^[A-Z]{2}$/;

// CDN placeholders for "unknown" (XX) and Tor exit nodes (T1) — c15t would
// treat them as a real non-GDPR country and suppress the banner.
const PLACEHOLDER_COUNTRIES = new Set(["T1", "XX"]);

const firstHeader = (headers: Headers, names: ReadonlyArray<string>): string | undefined => {
    for (const name of names) {
        const value = headers.get(name);

        if (value) {
            return value;
        }
    }

    return undefined;
};

/**
 * Resolve c15t location overrides from the CDN geo headers.
 *
 * Runs server-side and is called from the root route's loader, so the result is
 * dehydrated to the client and both sides initialize the consent store with the
 * same jurisdiction — c15t decides from the country whether the banner must show.
 */
export const getConsentOverrides = createServerFn({ method: "GET" }).handler((): Overrides => {
    const headers: Headers = getRequestHeaders();
    const overrides: Overrides = {};

    const rawCountry = firstHeader(headers, COUNTRY_HEADERS)?.trim().toUpperCase();
    const country = rawCountry && ISO_COUNTRY.test(rawCountry) && !PLACEHOLDER_COUNTRIES.has(rawCountry) ? rawCountry : undefined;
    const region = firstHeader(headers, REGION_HEADERS);

    if (country) {
        overrides.country = country;
    }

    if (region) {
        overrides.region = region;
    }

    return overrides;
});
