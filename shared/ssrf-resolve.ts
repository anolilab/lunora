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
 * What it reports, and why each case is its own verdict:
 * - An IP-literal host can't rebind and was already classified by the string
 *   guard, so it is `"skipped"`.
 * - A lookup that could not complete (network error, timeout, non-200,
 *   unparseable body) is `"failed"`. It is not a fallback to the string guard:
 *   whoever controls the name's nameserver can stall the check on purpose and
 *   answer the connecting resolver normally, so callers refuse it. One failed
 *   family is enough — a stalled A lookup next to a public AAAA answer says
 *   nothing about the address the connection will use.
 * - A lookup that DID answer but carried no address — an empty answer, or a
 *   non-NOERROR rcode such as SERVFAIL or NXDOMAIN — is `"unresolved"`, for
 *   the same reason.
 * - It is TOCTOU-imperfect: whoever connects afterwards re-resolves
 *   independently. An exact-host allowlist is the only hard guarantee.
 *
 * Returns a verdict rather than throwing — no imports, no `LunoraError`, so it
 * stays inline-safe per the repo `shared/` convention. The caller wraps each
 * refusal in its own user-facing error.
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

        const body: { Answer?: { data: string; type: number }[]; Status?: number } = await response.json();

        // A non-NOERROR rcode (SERVFAIL, NXDOMAIN, REFUSED) answered, with nothing usable.
        return body.Status === undefined || body.Status === 0 ? (body.Answer ?? []) : [];
    } catch {
        return undefined;
    }
};

/**
 * The outcome of a rebinding re-check. Only `public` and `skipped` mean "go
 * ahead"; `private`, `unresolved` and `failed` are refusals. A caller that
 * caches verdicts should keep `failed` (and arguably `unresolved`) out of the
 * cache: a DoH outage is transient, and a cached refusal outlives it.
 */
type SsrfResolution =
    /** Resolved, and at least one address is private/internal. `address` is the first such. */
    | { address: string; kind: "private" }
    /** Resolved, and every returned address is public. */
    | { kind: "public" }
    /** DoH answered, but with no A/AAAA address (empty answer, SERVFAIL, NXDOMAIN). Callers refuse this. */
    | { kind: "unresolved" }
    /** The lookup could not complete (network error, timeout, non-200, unparseable body). Callers refuse this. */
    | { kind: "failed" }
    /** An IP-literal host: nothing to resolve, and it cannot rebind. */
    | { kind: "skipped" };

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
        return { kind: "skipped" };
    }

    const [aRecords, aaaaRecords] = await Promise.all([dohLookup(host, DNS_TYPE_A, timeoutMs), dohLookup(host, DNS_TYPE_AAAA, timeoutMs)]);

    if (aRecords === undefined || aaaaRecords === undefined) {
        return { kind: "failed" };
    }

    // CNAME and other records ride along in `Answer`; only addresses decide.
    const addresses = [...aRecords, ...aaaaRecords].filter((answer) => answer.type === DNS_TYPE_A || answer.type === DNS_TYPE_AAAA);

    for (const answer of addresses) {
        if (isPrivateResolvedIp(answer.data, answer.type)) {
            return { address: answer.data, kind: "private" };
        }
    }

    return addresses.length === 0 ? { kind: "unresolved" } : { kind: "public" };
};

export type { SsrfResolution };
export { resolveHostSsrf };
