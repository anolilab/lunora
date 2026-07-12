/**
 * Pure alert-evaluation helpers for the Observability "watches while you sleep"
 * tier. Kept out of the `lunora/telemetry.ts` mutation (which does the DB writes)
 * so the firing decision + notification rendering are unit-testable, mirroring
 * how `usage.ingest` delegates to the pure `evaluateSpendCap`.
 */

/** What a rule watches. */
export type AlertTarget = "incident" | "issue";

/** The source (issue/incident) a rule is evaluated against, for rendering. */
export interface AlertSource {
    count: number;
    culprit: string;
    sampleMessage: string;
    title: string;
}

/**
 * A rule fires the first time a source's count reaches the threshold — i.e. the
 * count crossed it on this ingest (`before < threshold &lt;= after`). Because a
 * source's count only grows, this fires exactly once per rule, never repeatedly.
 */
export const crossesThreshold = (before: number, after: number, threshold: number): boolean => before < threshold && after >= threshold;

/** Render a fired alert's subject + body from the rule and the tripping source. */
export const renderAlert = (rule: { name: string; target: AlertTarget }, source: AlertSource): { body: string; subject: string } => {
    return {
        body:
            `${rule.target === "incident" ? "Incident" : "Issue"} "${source.title}" (${source.culprit}) reached ` +
            `${String(source.count)} events on Lunora Cloud.\n\nSample: ${source.sampleMessage}`,
        subject: `[Lunora] ${rule.name}: ${source.title}`,
    };
};

/** An IPv4 octet's digit shape (numeric range is checked separately). */
const IPV4_OCTET = /^\d{1,3}$/;

/** IPv6 link-local prefix `fe80::/10` (fe8–feb). */
const IPV6_LINK_LOCAL = /^fe[89ab]/;

/** Leading/trailing brackets around an IPv6 host literal (`[::1]`). */
const HOST_BRACKETS = /^\[|\]$/g;

/** A loopback / private / link-local / CGNAT IPv4 literal — never a webhook target. */
const isPrivateIpv4 = (host: string): boolean => {
    const octets = host.split(".");

    if (octets.length !== 4 || !octets.every((octet) => IPV4_OCTET.test(octet))) {
        return false;
    }

    const a = Number(octets[0]);
    const b = Number(octets[1]);

    return (
        a === 0 || // "this" network
        a === 10 || // private
        a === 127 || // loopback
        (a === 169 && b === 254) || // link-local, incl. 169.254.169.254 cloud metadata
        (a === 172 && b >= 16 && b <= 31) || // private
        (a === 192 && b === 168) || // private
        (a === 100 && b >= 64 && b <= 127) // CGNAT
    );
};

/**
 * Guard a user-configured webhook `destination` against SSRF: the control plane
 * `fetch`es this URL when an alert fires, so a rule author must not be able to
 * aim it at internal infrastructure. Requires `https://` to a public host —
 * rejects other schemes, embedded credentials, `localhost`/`*.local`/`*.internal`,
 * loopback/private/link-local IPv4 (incl. the `169.254.169.254` metadata IP), and
 * IPv6 loopback/unspecified/ULA/link-local/IPv4-mapped. This is string-level
 * validation — it cannot defeat
 * DNS rebinding (a proxy would be needed), but it blocks the direct-address cases.
 */
export const isSafeWebhookUrl = (destination: string): boolean => {
    let url: URL;

    try {
        url = new URL(destination);
    } catch {
        return false;
    }

    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
        return false;
    }

    const host = url.hostname.toLowerCase().replaceAll(HOST_BRACKETS, "");

    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
        return false;
    }

    // Reject non-global IPv6. `::`-prefixed covers the unspecified address (`::`),
    // loopback (`::1`), and IPv4-mapped/-compatible forms — the URL parser compresses
    // the embedded IPv4 to hex (`::ffff:169.254.169.254` → `::ffff:7f00:1`), so there is
    // no dotted quad left to re-check, and no legitimate public host sits in `::/…`.
    // Plus ULA (fc00::/7 → fc/fd) and link-local (fe80::/10 → fe8–feb).
    if (host.startsWith("::") || host.startsWith("fc") || host.startsWith("fd") || IPV6_LINK_LOCAL.test(host)) {
        return false;
    }

    return !isPrivateIpv4(host);
};
