import type { ReturnOf } from "@lunora/client";
import { useMutation, usePreloadedQuery, useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

import { api } from "../../lunora/_generated/api.js";
import type { AlertTarget } from "../telemetry/alerts";
import { ANOMALY_TARGETS, EVENT_TARGETS, METRIC_TARGETS } from "../telemetry/alerts";
import { AsyncList } from "./AsyncList";
import { ColumnHeader } from "./ColumnHeader";
import { formatDateTime } from "./format";
import { COLUMN_LABEL } from "./section-styles";
import { Field, FieldForm, FormError, Row, RowActions, RowList, StatusBadge, Upsell } from "./section-ui";
import type { SectionProps } from "./tabs";
import type { OrgId } from "./types";

/** Every alert-rule target, from the one place the taxonomy is declared (`src/telemetry/alerts.ts`). */
type RuleTarget = AlertTarget;

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
    deploy: "Failed deploy",
    error_anomaly: "Error anomaly (σ)",
    error_rate: "Error rate (%)",
    incident: "Incident count",
    issue: "Issue count",
    latency_p95: "Latency p95 (ms)",
    llm_cost: "LLM cost budget",
    spend: "Spend warning / cap (org thresholds)",
    storage_anomaly: "Storage anomaly (σ)",
    uptime: "Uptime failures",
    usage_anomaly: "Usage anomaly (σ)",
};

/**
 * The comparator glyph a rule's condition reads with. Metric rules compare a
 * rolling window strictly (above / below); count rules fire on *reaching* the
 * threshold, which is why the default glyph differs by target.
 */
const comparatorGlyph = (target: RuleTarget, comparator: "gt" | "lt" | undefined): string => {
    if (comparator === "lt") {
        return "<";
    }

    return METRIC_TARGETS.has(target) || ANOMALY_TARGETS.has(target) ? ">" : "≥";
};

/**
 * The threshold input's floor. Count rules start at 1 and metric values at 0; an
 * anomaly `lt` rule takes a negative score ("-4" = four sigma below normal), so
 * it has none — the server checks the sign against the comparator.
 */
const thresholdMin = (target: RuleTarget): number | undefined => {
    if (ANOMALY_TARGETS.has(target)) {
        return undefined;
    }

    return METRIC_TARGETS.has(target) ? 0 : 1;
};

/** A fired alert's delivery state → the tone its chip carries. */
const ALERT_TONE = {
    delivered: "success",
    failed: "danger",
    firing: "warning",
} as const;

/** A live alert rule, as the rules query returns it. */
type AlertRule = ReturnOf<typeof api.alerts.rules>[number];

/** A fired alert, as the alerts query returns it. */
type FiredAlert = ReturnOf<typeof api.alerts.list>[number];

/** The configured rules, with the per-row enable/disable and remove actions. */
const AlertRulesCard = ({ organizationId, rules }: { organizationId: OrgId; rules: AlertRule[] | undefined }): ReactElement => {
    const setRuleEnabled = useMutation(api.alerts.setRuleEnabled);
    const deleteRule = useMutation(api.alerts.deleteRule);

    return (
        <Card>
            <CardHeader>
                <CardTitle>Alert rules</CardTitle>
                <CardDescription>Evaluated by the telemetry ingest and the periodic sweep; a match is delivered over the rule&apos;s channel.</CardDescription>
            </CardHeader>
            <CardContent>
                <AsyncList
                    empty="No alert rules — add one below to get notified when errors spike."
                    render={(rows) => (
                        <RowList>
                            {rows.map((rule) => (
                                <Row key={rule._id}>
                                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                        <span className="truncate font-medium">{rule.name}</span>
                                        <span className={cn(COLUMN_LABEL, "text-muted-foreground truncate")}>
                                            {rule.channel} {rule.destination}
                                            {rule.functionPath ? ` @ ${rule.functionPath}` : ""}
                                        </span>
                                    </span>
                                    {/* The one value shown at size: a rule is its condition. */}
                                    <span className="font-mono text-base whitespace-nowrap tabular-nums">
                                        {EVENT_TARGETS.has(rule.target) ? (
                                            // No comparator, no threshold: an event rule has no
                                            // quantity, and rendering "deploy ≥ 0" would invite
                                            // somebody to go looking for the number it means.
                                            <>on {rule.target}</>
                                        ) : (
                                            <>
                                                {rule.target} {comparatorGlyph(rule.target, rule.comparator)} {rule.threshold}
                                                {rule.windowMinutes ? ` / ${String(rule.windowMinutes)}m` : ""}
                                            </>
                                        )}
                                    </span>
                                    <StatusBadge tone={rule.enabled ? "success" : "neutral"}>{rule.enabled ? "on" : "off"}</StatusBadge>
                                    <RowActions>
                                        <Button
                                            onClick={() => {
                                                void setRuleEnabled.mutate({ enabled: !rule.enabled, id: rule._id, organizationId });
                                            }}
                                            size="sm"
                                            type="button"
                                            variant="ghost"
                                        >
                                            {rule.enabled ? "Disable" : "Enable"}
                                        </Button>
                                        <Button
                                            className="text-destructive hover:text-destructive"
                                            onClick={() => {
                                                void deleteRule.mutate({ id: rule._id, organizationId });
                                            }}
                                            size="sm"
                                            type="button"
                                            variant="ghost"
                                        >
                                            Remove
                                        </Button>
                                    </RowActions>
                                </Row>
                            ))}
                        </RowList>
                    )}
                    rows={rules}
                />
            </CardContent>
        </Card>
    );
};

/** The create-rule form. Owns the draft; which fields it shows depends on the target. */
const NewRuleForm = ({ organizationId }: { organizationId: OrgId }): ReactElement => {
    const createRule = useMutation(api.alerts.createRule);

    const [name, setName] = useState("");
    const [target, setTarget] = useState<RuleTarget>("issue");
    const [threshold, setThreshold] = useState("5");
    const [comparator, setComparator] = useState<"gt" | "lt">("gt");
    const [windowMinutes, setWindowMinutes] = useState("15");
    const [functionPath, setFunctionPath] = useState("");
    const [channel, setChannel] = useState<Channel>("email");
    const [destination, setDestination] = useState("");
    const [error, setError] = useState<null | string>(null);

    const isMetric = METRIC_TARGETS.has(target);
    const isAnomaly = ANOMALY_TARGETS.has(target);
    const isEvent = EVENT_TARGETS.has(target);

    return (
        <Card>
            <CardHeader>
                <CardTitle>New rule</CardTitle>
            </CardHeader>
            <CardContent>
                <FieldForm
                    action={() => {
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
                                // An anomaly rule thresholds a score: a comparator, no window.
                                ...(isAnomaly ? { comparator } : {}),
                            });
                            setName("");
                            setDestination("");
                            setFunctionPath("");
                        };

                        void run().catch((error_: unknown) => {
                            setError(error_ instanceof Error ? error_.message : "could not create rule");
                        });
                    }}
                    className="max-w-2xl sm:grid-cols-2"
                >
                    <Field htmlFor="alert-name" label="Rule name">
                        <Input
                            id="alert-name"
                            onChange={(event) => {
                                setName(event.target.value);
                            }}
                            placeholder="High error rate"
                            required
                            value={name}
                        />
                    </Field>
                    <Field htmlFor="alert-target" label="Target">
                        <Select
                            onValueChange={(value: unknown) => {
                                setTarget(value as RuleTarget);
                            }}
                            value={target}
                        >
                            <SelectTrigger id="alert-target">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectGroup>
                                    {(Object.keys(TARGET_LABELS) as RuleTarget[]).map((value) => (
                                        <SelectItem key={value} value={value}>
                                            {TARGET_LABELS[value]}
                                        </SelectItem>
                                    ))}
                                </SelectGroup>
                            </SelectContent>
                        </Select>
                    </Field>
                    {isMetric || isAnomaly ? (
                        <Field htmlFor="alert-comparator" label="Comparator">
                            <Select
                                onValueChange={(value: unknown) => {
                                    setComparator(value as "gt" | "lt");
                                }}
                                value={comparator}
                            >
                                <SelectTrigger id="alert-comparator">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectGroup>
                                        <SelectItem value="gt">above</SelectItem>
                                        <SelectItem value="lt">below</SelectItem>
                                    </SelectGroup>
                                </SelectContent>
                            </Select>
                        </Field>
                    ) : null}
                    {isEvent ? null : (
                        <Field htmlFor="alert-threshold" label={isAnomaly ? "Threshold (standard deviations)" : "Threshold"}>
                            <Input
                                className="font-mono tabular-nums"
                                id="alert-threshold"
                                min={thresholdMin(target)}
                                onChange={(event) => {
                                    setThreshold(event.target.value);
                                }}
                                type="number"
                                value={threshold}
                            />
                        </Field>
                    )}
                    {isMetric ? (
                        <Field htmlFor="alert-window" label="Window (minutes)">
                            <Input
                                className="font-mono tabular-nums"
                                id="alert-window"
                                min={1}
                                onChange={(event) => {
                                    setWindowMinutes(event.target.value);
                                }}
                                placeholder="window (min)"
                                type="number"
                                value={windowMinutes}
                            />
                        </Field>
                    ) : null}
                    {isMetric ? (
                        <Field htmlFor="alert-function-path" label="Function path (optional)">
                            <Input
                                className="font-mono"
                                id="alert-function-path"
                                onChange={(event) => {
                                    setFunctionPath(event.target.value);
                                }}
                                placeholder="function path (optional)"
                                value={functionPath}
                            />
                        </Field>
                    ) : null}
                    <Field htmlFor="alert-channel" label="Channel">
                        <Select
                            onValueChange={(value: unknown) => {
                                setChannel(value as Channel);
                            }}
                            value={channel}
                        >
                            <SelectTrigger id="alert-channel">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectGroup>
                                    <SelectItem value="email">Email</SelectItem>
                                    <SelectItem value="webhook">Webhook</SelectItem>
                                    <SelectItem value="slack">Slack</SelectItem>
                                    <SelectItem value="pagerduty">PagerDuty</SelectItem>
                                </SelectGroup>
                            </SelectContent>
                        </Select>
                    </Field>
                    {/* Full width: a webhook/PagerDuty destination is long enough to need the row. */}
                    <div className="sm:col-span-2">
                        <Field htmlFor="alert-destination" label="Destination">
                            <Input
                                className="font-mono"
                                id="alert-destination"
                                onChange={(event) => {
                                    setDestination(event.target.value);
                                }}
                                placeholder={DESTINATION_HINT[channel]}
                                required
                                value={destination}
                            />
                        </Field>
                    </div>
                    <div className="grid gap-2 sm:col-span-2">
                        <Button className="justify-self-start" type="submit">
                            Add rule
                        </Button>
                        <FormError message={error} />
                    </div>
                </FieldForm>
            </CardContent>
        </Card>
    );
};

/** An anomaly baseline, as the baselines query returns it. */
type AnomalyBaseline = ReturnOf<typeof api.alerts.anomalyBaselines>[number];

/** A pending or active silence. */
type AnomalySilence = ReturnOf<typeof api.alerts.silences>[number];

/** Which anomaly target scores each signal, for the baseline rows. */
const SIGNAL_LABEL: Record<AnomalyBaseline["signal"], string> = {
    errors: "Error spans / hour",
    requests: "Requests / hour",
    storage: "D1 + Durable Object row cost / hour",
};

/** A baseline value in its signal's unit: a count, or (`storage`, nano-cents) dollars. */
const baselineValue = (signal: AnomalyBaseline["signal"], value: number): string =>
    signal === "storage" ? `$${(value / 100_000_000_000).toFixed(4)}` : Math.round(value).toLocaleString();

/** A baseline's state in one line: still warming up, or the last hour's score against what was normal. */
const baselineSummary = (row: AnomalyBaseline): string => {
    if (row.warmingUp) {
        return `warming up · ${String(row.samples)}h`;
    }

    const sign = row.lastScore >= 0 ? "+" : "";

    return `${sign}${row.lastScore.toFixed(1)}σ · ${baselineValue(row.signal, row.lastValue)} vs ${baselineValue(row.signal, row.lastMean)}`;
};

/**
 * The anomaly detector's state: each signal's baseline (warming up, or the last
 * hour's score), and the silences that make it skip hours. A silence skips the
 * hour entirely — no score, no baseline update — so it is the tool for a planned
 * load test, not a mute button.
 */
const AnomalyCard = ({
    baselines,
    organizationId,
    silences,
}: {
    baselines: AnomalyBaseline[] | undefined;
    organizationId: OrgId;
    silences: AnomalySilence[] | undefined;
}): ReactElement => {
    const createSilence = useMutation(api.alerts.createSilence);
    const deleteSilence = useMutation(api.alerts.deleteSilence);
    const [target, setTarget] = useState<AnomalySilence["target"]>("usage_anomaly");
    const [hours, setHours] = useState("4");
    const [reason, setReason] = useState("");
    const [error, setError] = useState<null | string>(null);

    return (
        <Card>
            <CardHeader>
                <CardTitle>Anomaly detection</CardTitle>
                <CardDescription>
                    Each completed hour is scored against this organization&apos;s rolling baseline. A baseline scores after a day of history, and an hour below
                    the platform&apos;s minimum activity never scores.
                </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
                <AsyncList
                    empty="No baseline yet — add a usage, error or storage anomaly rule and the next hourly sweep starts one."
                    render={(rows) => (
                        <RowList>
                            {rows.map((row) => (
                                <Row key={row.signal}>
                                    <span className="min-w-0 flex-1 truncate font-medium">{SIGNAL_LABEL[row.signal]}</span>
                                    <span className="font-mono text-base whitespace-nowrap tabular-nums">{baselineSummary(row)}</span>
                                </Row>
                            ))}
                        </RowList>
                    )}
                    rows={baselines}
                />
                <AsyncList
                    empty="No silences."
                    render={(rows) => (
                        <RowList>
                            {rows.map((silence) => (
                                <Row key={silence._id}>
                                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                        <span className="truncate font-medium">{silence.reason}</span>
                                        <span className={cn(COLUMN_LABEL, "text-muted-foreground truncate")}>
                                            {TARGET_LABELS[silence.target]} · {formatDateTime(silence.startsAt)} → {formatDateTime(silence.endsAt)}
                                        </span>
                                    </span>
                                    <RowActions>
                                        <Button
                                            className="text-destructive hover:text-destructive"
                                            onClick={() => {
                                                void deleteSilence.mutate({ id: silence._id, organizationId });
                                            }}
                                            size="sm"
                                            type="button"
                                            variant="ghost"
                                        >
                                            Remove
                                        </Button>
                                    </RowActions>
                                </Row>
                            ))}
                        </RowList>
                    )}
                    rows={silences}
                />
                <FieldForm
                    action={() => {
                        setError(null);

                        const run = async (): Promise<void> => {
                            await createSilence.mutate({ endsAt: Date.now() + Number(hours) * 3_600_000, organizationId, reason, target });
                            setReason("");
                        };

                        void run().catch((error_: unknown) => {
                            setError(error_ instanceof Error ? error_.message : "could not create silence");
                        });
                    }}
                    className="max-w-2xl sm:grid-cols-3"
                >
                    <Field htmlFor="silence-target" label="Silence">
                        <Select
                            onValueChange={(value: unknown) => {
                                setTarget(value as AnomalySilence["target"]);
                            }}
                            value={target}
                        >
                            <SelectTrigger id="silence-target">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectGroup>
                                    <SelectItem value="usage_anomaly">{TARGET_LABELS.usage_anomaly}</SelectItem>
                                    <SelectItem value="error_anomaly">{TARGET_LABELS.error_anomaly}</SelectItem>
                                    <SelectItem value="storage_anomaly">{TARGET_LABELS.storage_anomaly}</SelectItem>
                                </SelectGroup>
                            </SelectContent>
                        </Select>
                    </Field>
                    <Field htmlFor="silence-hours" label="For (hours)">
                        <Input
                            className="font-mono tabular-nums"
                            id="silence-hours"
                            max={720}
                            min={1}
                            onChange={(event) => {
                                setHours(event.target.value);
                            }}
                            type="number"
                            value={hours}
                        />
                    </Field>
                    <Field htmlFor="silence-reason" label="Reason">
                        <Input
                            id="silence-reason"
                            onChange={(event) => {
                                setReason(event.target.value);
                            }}
                            placeholder="Load test"
                            required
                            value={reason}
                        />
                    </Field>
                    <div className="grid gap-2 sm:col-span-3">
                        <Button className="justify-self-start" type="submit" variant="outline">
                            Add silence
                        </Button>
                        <FormError message={error} />
                    </div>
                </FieldForm>
            </CardContent>
        </Card>
    );
};

/** The delivery log — what fired, where it went, and whether it landed. */
const RecentAlertsCard = ({ alerts }: { alerts: FiredAlert[] | undefined }): ReactElement => (
    <Card>
        <CardHeader>
            <CardTitle>Recent alerts</CardTitle>
        </CardHeader>
        <CardContent>
            <AsyncList
                empty="No alerts fired yet."
                render={(rows) => (
                    <Table>
                        <ColumnHeader labels={["When", "Alert", "Channel", "Status"]} />
                        <TableBody>
                            {rows.map((alert) => (
                                <TableRow key={alert._id}>
                                    <TableCell className="text-muted-foreground w-[13rem] font-mono text-xs whitespace-nowrap">
                                        {formatDateTime(alert.createdAt)}
                                    </TableCell>
                                    <TableCell className="font-medium">{alert.subject}</TableCell>
                                    <TableCell className="text-muted-foreground max-w-[18rem] truncate font-mono text-xs">
                                        {alert.channel} {alert.destination}
                                    </TableCell>
                                    <TableCell>
                                        <StatusBadge tone={ALERT_TONE[alert.status]}>{alert.status}</StatusBadge>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                )}
                rows={alerts}
            />
        </CardContent>
    </Card>
);

/**
 * Cloud Observability "Alerts" — the watches-while-you-sleep tier. Owners/admins
 * configure rules (fire when an issue/incident's event count crosses a
 * threshold, deliver over email, webhook, Slack, or PagerDuty); the telemetry
 * ingest + periodic sweep evaluate them and the edge delivers. This section
 * manages rules and lists recent fired
 * alerts. Gated behind the `logStreams` plan entitlement.
 *
 * Hierarchy: a rule IS its condition, so the threshold expression is the one value
 * rendered at size, in mono — everything else on the row supports it. The rule name
 * is secondary (sans, medium); the channel, destination and function scope are
 * tertiary (mono caps, muted). Enabled/disabled and delivery state are the only
 * tinted things, and they tint the VALUE via a chip, never the row.
 *
 * This component is composition only — the plan gate plus the two live queries.
 * The rule list, the create form and the delivery log are separate components
 * above, so each re-renders on its own data and the file stays readable.
 */
export const AlertsSection = ({ organizationId, preloaded }: SectionProps<ReturnOf<typeof api.billing.entitlements>>): ReactElement => {
    const entitlements = usePreloadedQuery(preloaded);
    const gated = entitlements ? !entitlements.features.includes("logStreams") : false;
    const rules = useQuery(api.alerts.rules, gated ? "skip" : { organizationId });
    const alerts = useQuery(api.alerts.list, gated ? "skip" : { organizationId });
    const baselines = useQuery(api.alerts.anomalyBaselines, gated ? "skip" : { organizationId });
    const silences = useQuery(api.alerts.silences, gated ? "skip" : { organizationId });

    if (gated) {
        return <Upsell title="Alerts">Alerting is a Pro feature — upgrade your plan to enable Observability.</Upsell>;
    }

    return (
        <div className="flex flex-col gap-6">
            <AlertRulesCard organizationId={organizationId} rules={rules} />
            <NewRuleForm organizationId={organizationId} />
            <AnomalyCard baselines={baselines} organizationId={organizationId} silences={silences} />
            <RecentAlertsCard alerts={alerts} />
        </div>
    );
};
