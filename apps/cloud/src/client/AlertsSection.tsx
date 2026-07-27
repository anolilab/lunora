import type { Preloaded, ReturnOf } from "@lunora/client";
import { useMutation, usePreloadedQuery, useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { api } from "../../lunora/_generated/api.js";
import { AsyncList } from "./AsyncList";
import type { OrgId } from "./types";

interface AlertsSectionProps {
    organizationId: OrgId;
    /** The section's primary query, resolved by its route loader on the edge. */
    preloaded: Preloaded<ReturnOf<typeof api.billing.entitlements>>;
}

/** Every alert-rule target — count-crossing + app-semantic / budget metric windows. */
type RuleTarget = "error_rate" | "incident" | "issue" | "latency_p95" | "llm_cost" | "uptime";

/** Metric-window targets, which take a rolling window (+ comparator + optional scope). */
const METRIC_TARGETS = new Set<RuleTarget>(["error_rate", "latency_p95", "llm_cost"]);

/** Delivery channels — `email` via the mailer, the rest typed webhook POSTs. */
type Channel = "email" | "pagerduty" | "slack" | "webhook";

/** Placeholder hint for a channel's destination field. */
const DESTINATION_HINT: Record<Channel, string> = {
    email: "alerts@example.com",
    pagerduty: "PagerDuty integration (routing) key",
    slack: "https://hooks.slack.com/services/…",
    webhook: "https://hooks.example.com/…",
};

/** Human labels for each target in the create form. */
const TARGET_LABELS: Record<RuleTarget, string> = {
    error_rate: "Error rate (%)",
    incident: "Incident count",
    issue: "Issue count",
    latency_p95: "Latency p95 (ms)",
    llm_cost: "LLM cost budget",
    uptime: "Uptime failures",
};

/**
 * Cloud Observability "Alerts" — the watches-while-you-sleep tier. Owners/admins
 * configure rules (fire when an issue/incident's event count crosses a
 * threshold, deliver over email, webhook, Slack, or PagerDuty); the telemetry
 * ingest + periodic sweep evaluate them and the edge delivers. This section
 * manages rules and lists recent fired
 * alerts. Gated behind the `logStreams` plan entitlement.
 */
export const AlertsSection = ({ organizationId, preloaded }: AlertsSectionProps): ReactElement => {
    const entitlements = usePreloadedQuery(preloaded);
    const gated = entitlements ? !entitlements.features.includes("logStreams") : false;
    const rules = useQuery(api.alerts.rules, gated ? "skip" : { organizationId });
    const alerts = useQuery(api.alerts.list, gated ? "skip" : { organizationId });
    const createRule = useMutation(api.alerts.createRule);
    const setRuleEnabled = useMutation(api.alerts.setRuleEnabled);
    const deleteRule = useMutation(api.alerts.deleteRule);

    const [name, setName] = useState("");
    const [target, setTarget] = useState<RuleTarget>("issue");
    const [threshold, setThreshold] = useState("5");
    const [comparator, setComparator] = useState<"gt" | "lt">("gt");
    const [windowMinutes, setWindowMinutes] = useState("15");
    const [functionPath, setFunctionPath] = useState("");
    const [channel, setChannel] = useState<Channel>("email");
    const [destination, setDestination] = useState("");
    const [error, setError] = useState<string | null>(null);

    const isMetric = METRIC_TARGETS.has(target);

    if (gated) {
        return (
            <section className="card">
                <h3>Alerts</h3>
                <p className="muted">Alerting is a Pro feature — upgrade your plan to enable Observability.</p>
            </section>
        );
    }

    return (
        <div className="stack">
            <section className="card">
                <h3>Alert rules</h3>
                <AsyncList
                    empty="No alert rules — add one below to get notified when errors spike."
                    render={(rows) => (
                        <ul className="list">
                            {rows.map((rule) => (
                                <li className="row" key={rule._id}>
                                    <span className="row-title">{rule.name}</span>
                                    <span className="muted">
                                        {rule.target} {rule.comparator === "lt" ? "<" : METRIC_TARGETS.has(rule.target) ? ">" : "≥"} {rule.threshold}
                                        {rule.windowMinutes ? ` / ${rule.windowMinutes}m` : ""}
                                        {rule.functionPath ? ` @ ${rule.functionPath}` : ""} → {rule.channel} {rule.destination}
                                    </span>
                                    <span className="badge">{rule.enabled ? "on" : "off"}</span>
                                    <button
                                        className="link"
                                        onClick={() => {
                                            void setRuleEnabled.mutate({ enabled: !rule.enabled, id: rule._id, organizationId });
                                        }}
                                        type="button"
                                    >
                                        {rule.enabled ? "Disable" : "Enable"}
                                    </button>
                                    <button
                                        className="link danger"
                                        onClick={() => {
                                            void deleteRule.mutate({ id: rule._id, organizationId });
                                        }}
                                        type="button"
                                    >
                                        Remove
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                    rows={rules}
                />
                <form
                    className="inline-form"
                    onSubmit={(event) => {
                        event.preventDefault();
                        setError(null);

                        const run = async (): Promise<void> => {
                            await createRule.mutate({
                                channel,
                                destination,
                                name,
                                organizationId,
                                target,
                                threshold: Number(threshold),
                                // Metric rules carry a comparator + window (+ optional scope);
                                // count rules send none of these.
                                ...(isMetric
                                    ? {
                                          comparator,
                                          windowMinutes: Number(windowMinutes),
                                          ...(functionPath ? { functionPath } : {}),
                                      }
                                    : {}),
                            });
                            setName("");
                            setDestination("");
                            setFunctionPath("");
                        };

                        void run().catch((error_: unknown) => {
                            setError(error_ instanceof Error ? error_.message : "could not create rule");
                        });
                    }}
                >
                    <input
                        aria-label="Rule name"
                        onChange={(event) => {
                            setName(event.target.value);
                        }}
                        placeholder="High error rate"
                        required
                        value={name}
                    />
                    <select
                        aria-label="Target"
                        onChange={(event) => {
                            setTarget(event.target.value as RuleTarget);
                        }}
                        value={target}
                    >
                        {(Object.keys(TARGET_LABELS) as RuleTarget[]).map((value) => (
                            <option key={value} value={value}>
                                {TARGET_LABELS[value]}
                            </option>
                        ))}
                    </select>
                    {isMetric ? (
                        <select
                            aria-label="Comparator"
                            onChange={(event) => {
                                setComparator(event.target.value as "gt" | "lt");
                            }}
                            value={comparator}
                        >
                            <option value="gt">above</option>
                            <option value="lt">below</option>
                        </select>
                    ) : null}
                    <input
                        aria-label="Threshold"
                        min={isMetric ? 0 : 1}
                        onChange={(event) => {
                            setThreshold(event.target.value);
                        }}
                        type="number"
                        value={threshold}
                    />
                    {isMetric ? (
                        <input
                            aria-label="Window (minutes)"
                            min={1}
                            onChange={(event) => {
                                setWindowMinutes(event.target.value);
                            }}
                            placeholder="window (min)"
                            type="number"
                            value={windowMinutes}
                        />
                    ) : null}
                    {isMetric ? (
                        <input
                            aria-label="Function path (optional)"
                            onChange={(event) => {
                                setFunctionPath(event.target.value);
                            }}
                            placeholder="function path (optional)"
                            value={functionPath}
                        />
                    ) : null}
                    <select
                        aria-label="Channel"
                        onChange={(event) => {
                            setChannel(event.target.value as Channel);
                        }}
                        value={channel}
                    >
                        <option value="email">Email</option>
                        <option value="webhook">Webhook</option>
                        <option value="slack">Slack</option>
                        <option value="pagerduty">PagerDuty</option>
                    </select>
                    <input
                        aria-label="Destination"
                        onChange={(event) => {
                            setDestination(event.target.value);
                        }}
                        placeholder={DESTINATION_HINT[channel]}
                        required
                        value={destination}
                    />
                    <button className="primary" type="submit">
                        Add rule
                    </button>
                    {error ? (
                        <p className="error" role="alert">
                            {error}
                        </p>
                    ) : null}
                </form>
            </section>

            <section className="card">
                <h3>Recent alerts</h3>
                <AsyncList
                    empty="No alerts fired yet."
                    render={(rows) => (
                        <table className="table">
                            <thead>
                                <tr>
                                    <th>When</th>
                                    <th>Alert</th>
                                    <th>Channel</th>
                                    <th>Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((alert) => (
                                    <tr key={alert._id}>
                                        <td className="muted">{new Date(alert.createdAt).toLocaleString()}</td>
                                        <td>{alert.subject}</td>
                                        <td className="muted">
                                            {alert.channel} {alert.destination}
                                        </td>
                                        <td>{alert.status}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                    rows={alerts}
                />
            </section>
        </div>
    );
};
