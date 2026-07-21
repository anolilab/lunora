/**
 * Pure alert-evaluation helpers for the Observability "watches while you sleep"
 * tier. Kept out of the `lunora/telemetry.ts` mutation (which does the DB writes)
 * so the firing decision + notification rendering are unit-testable, mirroring
 * how `usage.ingest` delegates to the pure `evaluateSpendCap`.
 */

/** What a rule watches. `uptime` is a deployment's consecutive failed synthetic checks. */
export type AlertTarget = "incident" | "issue" | "uptime";

/** The source (issue/incident/uptime) a rule is evaluated against, for rendering. */
export interface AlertSource {
    count: number;
    culprit: string;
    sampleMessage: string;
    title: string;
}

/** The human label for a rule's target, used in the notification. */
const TARGET_LABEL: Record<AlertTarget, string> = { incident: "Incident", issue: "Issue", uptime: "Uptime" };

/**
 * A rule fires the first time a source's count reaches the threshold — i.e. the
 * count crossed it on this ingest (`before < threshold &lt;= after`). Because a
 * source's count only grows, this fires exactly once per rule, never repeatedly.
 */
export const crossesThreshold = (before: number, after: number, threshold: number): boolean => before < threshold && after >= threshold;

/** Render a fired alert's subject + body from the rule and the tripping source. */
export const renderAlert = (rule: { name: string; target: AlertTarget }, source: AlertSource): { body: string; subject: string } => {
    if (rule.target === "uptime") {
        return {
            body:
                `Deployment "${source.title}" (${source.culprit}) failed ${String(source.count)} ` +
                `consecutive uptime checks on Lunora Cloud.\n\nLast probe: ${source.sampleMessage}`,
            subject: `[Lunora] ${rule.name}: ${source.title} is down`,
        };
    }

    return {
        body:
            `${TARGET_LABEL[rule.target]} "${source.title}" (${source.culprit}) reached ` +
            `${String(source.count)} events on Lunora Cloud.\n\nSample: ${source.sampleMessage}`,
        subject: `[Lunora] ${rule.name}: ${source.title}`,
    };
};

/**
 * A fired alert to deliver (email/webhook) then mark delivered. `TId` is the
 * alert-row id — a branded `Id<"alerts">` when fired from the lunora `ctx.db`
 * (telemetry ingest), a plain `string` from the structural control-plane store
 * (the uptime sweep) — so both firing paths share one type without either
 * widening its id.
 */
export interface AlertDelivery<TId extends string = string> {
    body: string;
    channel: "email" | "webhook";
    destination: string;
    id: TId;
    subject: string;
}

/** An enabled rule the firing loop evaluates. `ruleId` is the alertRules row id (any string id form). */
export interface FiringRule {
    channel: "email" | "webhook";
    destination: string;
    name: string;
    ruleId: string;
    target: AlertTarget;
    threshold: number;
}

/** The tripping source (issue/incident/uptime) a batch of rules is evaluated against. */
export interface FiringSource {
    after: number;
    before: number;
    culprit: string;
    hash: string;
    organizationId: string;
    sampleMessage: string;
    target: AlertTarget;
    title: string;
}

/**
 * Fire every enabled rule whose target matches this source and whose threshold the
 * source's count just crossed: render the notification, insert a `firing` alert
 * row via the caller's `insertAlert`, and return the deliveries the edge should
 * send. The single source of truth for the firing decision + the `alerts` row
 * shape, shared by `lunora/telemetry.ts`'s ingest (issue/incident) and
 * `src/uptime/sweep.ts` (uptime) so the two paths can't drift.
 *
 * `insertAlert` is injected because the two callers write through different
 * stores — the typed lunora `ctx.db` (branded ids) vs the structural
 * `ControlPlaneDb` (string ids) — so the id type flows through as `TId`.
 */
export const fireCrossedRules = async <TId extends string>(
    rules: readonly FiringRule[],
    source: FiringSource,
    insertAlert: (row: Record<string, unknown>) => Promise<TId>,
    now: number,
): Promise<AlertDelivery<TId>[]> => {
    const deliveries: AlertDelivery<TId>[] = [];

    for (const rule of rules) {
        if (rule.target !== source.target || !crossesThreshold(source.before, source.after, rule.threshold)) {
            continue;
        }

        const rendered = renderAlert(rule, { count: source.after, culprit: source.culprit, sampleMessage: source.sampleMessage, title: source.title });
        // eslint-disable-next-line no-await-in-loop -- one insert per fired rule; small, serialized
        const id = await insertAlert({
            body: rendered.body,
            channel: rule.channel,
            createdAt: now,
            destination: rule.destination,
            hash: source.hash,
            organizationId: source.organizationId,
            ruleId: rule.ruleId,
            status: "firing",
            subject: rendered.subject,
            target: rule.target,
            updatedAt: now,
        });

        deliveries.push({ body: rendered.body, channel: rule.channel, destination: rule.destination, id, subject: rendered.subject });
    }

    return deliveries;
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
