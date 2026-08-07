/**
 * `shared/ssrf-resolve.ts` — the DNS-rebinding half of the SSRF boundary.
 *
 * `shared/ssrf-host.ts` classifies a host AS-WRITTEN, which cannot see a PUBLIC
 * name that resolves (via attacker-controlled DNS) to a private address —
 * `https://169-254-169-254.sslip.io/…` sails through it. This module closes that
 * by resolving the name over Cloudflare DoH (JSON `application/dns-json`, a plain
 * `fetch` — no `node:dns`, so it runs on workerd) and re-classifying every
 * returned A/AAAA record against the same range tables.
 *
 * Best-effort by construction, and deliberately so:
 * - An IP-literal host can't rebind and was already classified by the string
 *   guard, so it is skipped.
 * - If BOTH lookups fail (network error / non-200 / unparseable), it returns
 *   "nothing private" and the caller leans on the string guard it already
 *   passed — a broken resolver must not take the feature down. It never
 *   fails open on an address that actually DID resolve to a private range.
 * - It is TOCTOU-imperfect: whoever connects afterwards re-resolves
 *   independently. An exact-host allowlist is the only hard guarantee.
 *
 * Returns a verdict rather than throwing — no imports, no `LunoraError`, so it
 * stays inline-safe per the repo `shared/` convention. The caller wraps a
 * `"private"` result in its own user-facing error.
 */

import { isPrivateIpv4, isPrivateIpv6, normalizeHost, parseIpv4 } from "./ssrf-host";

/** Cloudflare's DoH JSON endpoint. */
// eslint-disable-next-line no-secrets/no-secrets -- a public DNS endpoint URL, not a credential
const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

/** DNS record type numbers (RFC 1035 / 3596). */
const DNS_TYPE_A = 1;
const DNS_TYPE_AAAA = 28;

/** Default per-lookup ceiling so a stalled resolver can't hang the caller. */
const DOH_TIMEOUT_MS = 2000;

/**
 * Classify a single DoH-resolved IP (its record `type` + `data`) as private.
 * Reuses the same IPv4/IPv6 range tables as the string guard; an A `data` is a
 * dotted quad, an AAAA `data` is an IPv6 literal. An unparseable A record is
 * treated as private (fail-closed), matching `parseIpv4` elsewhere.
 */
const isPrivateResolvedIp = (data: string, type: number): boolean => {
    if (type === DNS_TYPE_A) {
        const v4 = parseIpv4(data);

        return v4 === undefined || isPrivateIpv4(v4);
    }

    return isPrivateIpv6(data.toLowerCase());
};

/**
 * Query Cloudflare DoH for one record `type` of `hostname`. Returns the `Answer`
 * array (possibly empty) on success, or `undefined` if the lookup itself failed
 * (network error / non-200 / unparseable body) so the caller can fall back to
 * the string guard rather than fail open.
 */
const dohLookup = async (hostname: string, type: number, timeoutMs: number): Promise<{ data: string; type: number }[] | undefined> => {
    try {
        const response = await fetch(`${DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${String(type)}`, {
            headers: { accept: "application/dns-json" },
            // Bound the lookup so a stalled resolver can't hang the caller; an
            // abort surfaces as a rejection caught below → `undefined` → the
            // caller falls back to the (already-passed) string guard.
            signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
            return undefined;
        }

        const body: { Answer?: { data: string; type: number }[] } = await response.json();

        return body.Answer ?? [];
    } catch {
        return undefined;
    }
};

/**
 * The outcome of a rebinding re-check. Three states, not two, because "no private
 * address" and "we could not find out" are NOT the same fact: the first is a
 * verified result, the second is a fallback to the string guard. A caller that
 * merely refuses on `private` can treat them alike — but one that CACHES the
 * verdict must not, or a single DoH outage disables its guard for that host for
 * as long as the cache lives.
 */
type SsrfResolution =
    /** Resolved, and at least one address is private/internal. `address` is the first such. */
    | { address: string; kind: "private" }
    /** Resolved, and every returned address is public. */
    | { kind: "public" }
    /** Nothing was learned: an IP-literal host (skipped — it cannot rebind) or a failed lookup. */
    | { kind: "unknown" };

/**
 * Resolve `hostname` (a `new URL(x).hostname` value, NOT a full URL) over DoH and
 * classify what came back. See {@link SsrfResolution} for why the
 * lookup-failed case is distinguishable from the all-public one.
 *
 * @param hostname a `new URL(x).hostname` value.
 * @param timeoutMs per-lookup ceiling; defaults to 2s.
 */
const resolveHostSsrf = async (hostname: string, timeoutMs: number = DOH_TIMEOUT_MS): Promise<SsrfResolution> => {
    const host = normalizeHost(hostname);

    // IP literals can't rebind through DNS and were already classified by the
    // string guard; only a named host needs the resolved-address re-check.
    if (host.includes(":") || parseIpv4(host) !== undefined) {
        return { kind: "unknown" };
    }

    const [aRecords, aaaaRecords] = await Promise.all([dohLookup(host, DNS_TYPE_A, timeoutMs), dohLookup(host, DNS_TYPE_AAAA, timeoutMs)]);

    // Both lookups failed — fall back to the string guard (which already passed)
    // rather than fail open. If either resolved, inspect what came back.
    if (aRecords === undefined && aaaaRecords === undefined) {
        return { kind: "unknown" };
    }

    for (const answer of [...(aRecords ?? []), ...(aaaaRecords ?? [])]) {
        if ((answer.type === DNS_TYPE_A || answer.type === DNS_TYPE_AAAA) && isPrivateResolvedIp(answer.data, answer.type)) {
            return { address: answer.data, kind: "private" };
        }
    }

    return { kind: "public" };
};

export type { SsrfResolution };
export { resolveHostSsrf };
