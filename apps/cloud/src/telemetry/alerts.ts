/**
 * Pure alert-evaluation helpers for the Observability "watches while you sleep"
 * tier. Kept out of the `lunora/telemetry.ts` mutation (which does the DB writes)
 * so the firing decision + notification rendering are unit-testable, mirroring
 * how `usage.ingest` delegates to the pure `evaluateSpendCap`.
 */

/**
 * Count-crossing targets — a monotonically-growing counter that fires once when
 * it first reaches a threshold. `uptime` is a deployment's consecutive failed
 * synthetic checks; `issue`/`incident` are a fingerprint group's event count.
 */
export type CountTarget = "incident" | "issue" | "uptime";

/**
 * Metric-window targets — an app-semantic / budget metric computed over a rolling
 * window of span {@link MetricObservation}s, not a monotonic counter:
 * - `error_rate` — percentage of error-level observations in the window.
 * - `latency_p95` — the p95 of `durationMs` over the window.
 * - `llm_cost` — summed generation-span cost (a spend budget) over the window.
 */
export type MetricTarget = "error_rate" | "latency_p95" | "llm_cost";

/** What a rule watches — a count-crossing counter or a metric window. */
export type AlertTarget = CountTarget | MetricTarget;

/** How a metric value is compared to the rule threshold. Absent on a rule ⇒ `gt`. */
export type Comparator = "gt" | "lt";

/** The source (issue/incident/uptime) a rule is evaluated against, for rendering. */
export interface AlertSource {
    count: number;
    culprit: string;
    sampleMessage: string;
    title: string;
}

/** The human label for a count-crossing rule's target, used in the notification. */
const TARGET_LABEL: Record<CountTarget, string> = { incident: "Incident", issue: "Issue", uptime: "Uptime" };

/**
 * A rule fires the first time a source's count reaches the threshold — i.e. the
 * count crossed it on this ingest (`before < threshold &lt;= after`). Because a
 * source's count only grows, this fires exactly once per rule, never repeatedly.
 */
export const crossesThreshold = (before: number, after: number, threshold: number): boolean => before < threshold && after >= threshold;

/** Render a fired alert's subject + body from the rule and the tripping source. */
export const renderAlert = (rule: { name: string; target: CountTarget }, source: AlertSource): { body: string; subject: string } => {
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

/** An enabled count-crossing rule the firing loop evaluates. `ruleId` is the alertRules row id (any string id form). */
export interface FiringRule {
    channel: "email" | "webhook";
    destination: string;
    name: string;
    ruleId: string;
    target: CountTarget;
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
    target: CountTarget;
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

// ── Metric-window rules (error_rate / latency_p95 / llm_cost) ────────────────
//
// Unlike count crossings (a monotone counter that fires once), a metric rule
// computes an app-semantic / budget value over a rolling window of span
// observations and fires when that value breaches the threshold. To avoid
// re-firing on every ingest while the metric stays breached, the decision is
// *edge-triggered*: it fires only when the CURRENT window breaches and the
// PRIOR window (the equal-length window immediately before it) did not — the
// same "fire once per crossing" spirit as `crossesThreshold`, adapted to a
// value that can also fall back below the threshold. All pure + injected data,
// like the count path, so the firing decision is fully unit-testable.

/**
 * A span observation as the metric evaluators read it — the subset of the
 * `observations` row the metrics need. `costMinor` is the generation-span cost
 * (`gen_ai.usage.cost`) once populated; it is not yet emitted onto observations,
 * so `computeLlmCost` falls back to a token proxy (see there).
 */
export interface MetricObservation {
    completionTokens?: number;
    costMinor?: number;
    durationMs: number;
    functionPath?: string;
    kind: "container" | "generation" | "worker";
    level: "error" | "info";
    promptTokens?: number;
    startedAt: number;
}

/** Percentage (0–100) of error-level observations in the window; 0 for an empty window. */
export const computeErrorRate = (observations: readonly MetricObservation[]): number => {
    if (observations.length === 0) {
        return 0;
    }

    const errors = observations.filter((observation) => observation.level === "error").length;

    return (errors / observations.length) * 100;
};

/**
 * The `p`th percentile (0–100) of `values` by nearest-rank on the sorted values.
 * Empty input is 0. Kept dependency-free and deterministic for the tests.
 */
export const percentile = (values: readonly number[], p: number): number => {
    if (values.length === 0) {
        return 0;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.ceil((p / 100) * sorted.length);
    const index = Math.min(Math.max(rank, 1), sorted.length) - 1;

    return sorted[index] as number;
};

/** The p95 of `durationMs` over the window's observations. */
export const computeLatencyP95 = (observations: readonly MetricObservation[]): number =>
    percentile(
        observations.map((observation) => observation.durationMs),
        95,
    );

/**
 * Summed generation-span cost over the window — the LLM spend budget. Sums
 * `costMinor` when present. FOLLOW-UP: observations don't yet carry
 * `gen_ai.usage.cost` (no `costMinor` column), so today that sum is 0 and we
 * fall back to total tokens (prompt + completion) across the generation spans as
 * a proxy budget. Once the sink populates `costMinor`, the proxy naturally stops
 * being used (a non-zero cost sum wins) and can be removed.
 */
export const computeLlmCost = (observations: readonly MetricObservation[]): number => {
    const generations = observations.filter((observation) => observation.kind === "generation");
    const cost = generations.reduce((sum, observation) => sum + (observation.costMinor ?? 0), 0);

    if (cost > 0) {
        return cost;
    }

    return generations.reduce((sum, observation) => sum + (observation.promptTokens ?? 0) + (observation.completionTokens ?? 0), 0);
};

/** Compute a metric target's value over a window of observations. */
export const computeMetric = (target: MetricTarget, observations: readonly MetricObservation[]): number => {
    switch (target) {
        case "error_rate": {
            return computeErrorRate(observations);
        }
        case "latency_p95": {
            return computeLatencyP95(observations);
        }
        case "llm_cost": {
            return computeLlmCost(observations);
        }
        default: {
            return 0;
        }
    }
};

/** Whether `value` breaches `threshold` under the comparator (`gt` ⇒ above, `lt` ⇒ below). */
export const compareMetric = (value: number, comparator: Comparator, threshold: number): boolean =>
    comparator === "lt" ? value < threshold : value > threshold;

/**
 * The percent change from a `prior` window value to the `current` one. A zero
 * baseline can't yield a finite ratio: any rise from 0 is treated as an
 * unbounded spike (`Infinity`), a flat 0→0 as no change. This is the
 * rate-of-change primitive behind the simple anomaly helper — no ML, just a
 * window-over-window delta.
 */
export const rateOfChangePercent = (current: number, prior: number): number => {
    if (prior === 0) {
        return current === 0 ? 0 : Number.POSITIVE_INFINITY;
    }

    return ((current - prior) / prior) * 100;
};

/**
 * Simple anomaly test: does `current` deviate (up OR down) from `prior` by at
 * least `thresholdPercent`? A rise from a zero baseline always counts. This is
 * the "rate of change" alerting primitive; a metric rule can layer it on top of
 * (or instead of) the absolute threshold to catch spikes relative to the app's
 * own recent baseline.
 */
export const deviatesByPercent = (current: number, prior: number, thresholdPercent: number): boolean =>
    Math.abs(rateOfChangePercent(current, prior)) >= thresholdPercent;

/** An enabled metric-window rule the metric firing loop evaluates. */
export interface MetricRule {
    channel: "email" | "webhook";
    comparator: Comparator;
    destination: string;
    /** Optional scope: evaluate only observations from this function path. */
    functionPath?: string;
    name: string;
    ruleId: string;
    target: MetricTarget;
    threshold: number;
    windowMinutes: number;
}

/** The outcome of evaluating a metric rule against its current + prior window. */
export interface MetricEvaluation {
    currentValue: number;
    /** Edge-triggered: current window breaches the threshold, prior did not. */
    fired: boolean;
    priorValue: number;
}

/**
 * Evaluate a metric rule against the observations in its current window and the
 * equal-length window immediately before it. Fires (edge-triggered) only when
 * the current value breaches the threshold and the prior value did not, so a
 * sustained breach alerts once, not every ingest.
 */
export const evaluateMetricRule = (
    rule: Pick<MetricRule, "comparator" | "target" | "threshold">,
    currentWindow: readonly MetricObservation[],
    priorWindow: readonly MetricObservation[],
): MetricEvaluation => {
    const currentValue = computeMetric(rule.target, currentWindow);
    const priorValue = computeMetric(rule.target, priorWindow);
    const nowBreaches = compareMetric(currentValue, rule.comparator, rule.threshold);
    const priorBreaches = compareMetric(priorValue, rule.comparator, rule.threshold);

    return { currentValue, fired: nowBreaches && !priorBreaches, priorValue };
};

/** Units for a metric value in the rendered notification. */
const METRIC_UNIT: Record<MetricTarget, string> = { error_rate: "%", latency_p95: "ms", llm_cost: "" };

/** Human label for a metric target in the notification. */
const METRIC_LABEL: Record<MetricTarget, string> = { error_rate: "Error rate", latency_p95: "Latency p95", llm_cost: "LLM cost" };

/** Format a metric value with its unit (integers stay integral, ratios keep two decimals). */
const formatMetric = (target: MetricTarget, value: number): string => {
    const rounded = Number.isInteger(value) ? String(value) : value.toFixed(2);
    const unit = METRIC_UNIT[target];

    return target === "llm_cost" ? `${rounded} (cost units)` : `${rounded}${unit}`;
};

/** Render a fired metric alert's subject + body, including the window-over-window change. */
export const renderMetricAlert = (
    rule: { comparator: Comparator; functionPath?: string; name: string; target: MetricTarget; threshold: number; windowMinutes: number },
    evaluation: Pick<MetricEvaluation, "currentValue" | "priorValue">,
): { body: string; subject: string } => {
    const scope = rule.functionPath ? ` for ${rule.functionPath}` : "";
    const direction = rule.comparator === "lt" ? "below" : "above";
    const change = rateOfChangePercent(evaluation.currentValue, evaluation.priorValue);
    const changeText = Number.isFinite(change) ? `${change >= 0 ? "+" : ""}${change.toFixed(0)}% vs the prior window` : "up from zero in the prior window";

    return {
        body:
            `${METRIC_LABEL[rule.target]}${scope} is ${formatMetric(rule.target, evaluation.currentValue)} over the last ` +
            `${String(rule.windowMinutes)} min on Lunora Cloud — ${direction} the ${formatMetric(rule.target, rule.threshold)} threshold ` +
            `(${changeText}).`,
        subject: `[Lunora] ${rule.name}: ${METRIC_LABEL[rule.target]} ${direction} threshold`,
    };
};

/**
 * Slice a metric rule's current + prior window out of a recent-observation set.
 * `functionPath` scoping is applied first; both windows are `windowMinutes`
 * long, back-to-back, ending at `now`.
 */
const windowsFor = (
    rule: MetricRule,
    observations: readonly MetricObservation[],
    now: number,
): { current: MetricObservation[]; prior: MetricObservation[] } => {
    const windowMs = rule.windowMinutes * 60_000;
    const scoped = rule.functionPath ? observations.filter((observation) => observation.functionPath === rule.functionPath) : observations;
    const currentStart = now - windowMs;
    const priorStart = now - 2 * windowMs;

    return {
        current: scoped.filter((observation) => observation.startedAt > currentStart && observation.startedAt <= now),
        prior: scoped.filter((observation) => observation.startedAt > priorStart && observation.startedAt <= currentStart),
    };
};

/**
 * Fire every enabled metric rule whose window value edge-crosses its threshold,
 * over the org's recent `observations`. Mirrors {@link fireCrossedRules} — same
 * `alerts` row shape + injected `insertAlert` — so the metric path can't drift
 * from the count path. The alert `hash` groups a rule's alerts by target +
 * scope (mirroring the issue/incident hash), so the recent-alerts list dedupes
 * cleanly. `insertAlert` uses the same structural row the count path writes.
 */
export const fireMetricRules = async <TId extends string>(
    rules: readonly MetricRule[],
    observations: readonly MetricObservation[],
    organizationId: string,
    insertAlert: (row: Record<string, unknown>) => Promise<TId>,
    now: number,
): Promise<AlertDelivery<TId>[]> => {
    const deliveries: AlertDelivery<TId>[] = [];

    for (const rule of rules) {
        const { current, prior } = windowsFor(rule, observations, now);
        const evaluation = evaluateMetricRule(rule, current, prior);

        if (!evaluation.fired) {
            continue;
        }

        const rendered = renderMetricAlert(rule, evaluation);
        const hash = `${rule.target}:${rule.functionPath ?? "*"}`;
        // eslint-disable-next-line no-await-in-loop -- one insert per fired rule; small, serialized
        const id = await insertAlert({
            body: rendered.body,
            channel: rule.channel,
            createdAt: now,
            destination: rule.destination,
            hash,
            organizationId,
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
