import { useMutation, useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { api } from "../../lunora/_generated/api.js";
import { AsyncList } from "./AsyncList";
import type { OrgId } from "./types";

interface AlertsSectionProps {
    organizationId: OrgId;
}

/**
 * Cloud Observability "Alerts" — the watches-while-you-sleep tier. Owners/admins
 * configure rules (fire when an issue/incident's event count crosses a
 * threshold, deliver over email or webhook); the telemetry ingest evaluates them
 * and the edge delivers. This section manages rules and lists recent fired
 * alerts. Gated behind the `logStreams` plan entitlement.
 */
export const AlertsSection = ({ organizationId }: AlertsSectionProps): ReactElement => {
    const entitlements = useQuery(api.billing.entitlements, { organizationId });
    const gated = entitlements ? !entitlements.features.includes("logStreams") : false;
    const rules = useQuery(api.alerts.rules, gated ? "skip" : { organizationId });
    const alerts = useQuery(api.alerts.list, gated ? "skip" : { organizationId });
    const createRule = useMutation(api.alerts.createRule);
    const setRuleEnabled = useMutation(api.alerts.setRuleEnabled);
    const deleteRule = useMutation(api.alerts.deleteRule);

    const [name, setName] = useState("");
    const [target, setTarget] = useState<"incident" | "issue">("issue");
    const [threshold, setThreshold] = useState("5");
    const [channel, setChannel] = useState<"email" | "webhook">("email");
    const [destination, setDestination] = useState("");
    const [error, setError] = useState<string | null>(null);

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
                                        {rule.target} ≥ {rule.threshold} → {rule.channel} {rule.destination}
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
                            await createRule.mutate({ channel, destination, name, organizationId, target, threshold: Number(threshold) });
                            setName("");
                            setDestination("");
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
                            setTarget(event.target.value as "incident" | "issue");
                        }}
                        value={target}
                    >
                        <option value="issue">Issue</option>
                        <option value="incident">Incident</option>
                    </select>
                    <input
                        aria-label="Threshold"
                        min={1}
                        onChange={(event) => {
                            setThreshold(event.target.value);
                        }}
                        type="number"
                        value={threshold}
                    />
                    <select
                        aria-label="Channel"
                        onChange={(event) => {
                            setChannel(event.target.value as "email" | "webhook");
                        }}
                        value={channel}
                    >
                        <option value="email">Email</option>
                        <option value="webhook">Webhook</option>
                    </select>
                    <input
                        aria-label="Destination"
                        onChange={(event) => {
                            setDestination(event.target.value);
                        }}
                        placeholder={channel === "email" ? "alerts@example.com" : "https://hooks.example.com/…"}
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
