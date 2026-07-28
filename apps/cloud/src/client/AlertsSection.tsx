import type { ReturnOf } from "@lunora/client";
import { useMutation, usePreloadedQuery, useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

import { api } from "../../lunora/_generated/api.js";
import { AsyncList } from "./AsyncList";
import { formatDateTime } from "./format";
import { COLUMN_LABEL, Field, FieldForm, FormError, Row, RowActions, RowList, StatusBadge, Upsell } from "./section-ui";
import type { SectionProps } from "./tabs";

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
 * The comparator glyph a rule's condition reads with. Metric rules compare a
 * rolling window strictly (above / below); count rules fire on *reaching* the
 * threshold, which is why the default glyph differs by target.
 */
const comparatorGlyph = (target: RuleTarget, comparator: "gt" | "lt" | undefined): string => {
    if (comparator === "lt") {
        return "<";
    }

    return METRIC_TARGETS.has(target) ? ">" : "≥";
};

/** A fired alert's delivery state → the tone its chip carries. */
const ALERT_TONE = {
    delivered: "success",
    failed: "danger",
    firing: "warning",
} as const;

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
 */
export const AlertsSection = ({ organizationId, preloaded }: SectionProps<ReturnOf<typeof api.billing.entitlements>>): ReactElement => {
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
    const [error, setError] = useState<null | string>(null);

    const isMetric = METRIC_TARGETS.has(target);

    if (gated) {
        return <Upsell title="Alerts">Alerting is a Pro feature — upgrade your plan to enable Observability.</Upsell>;
    }

    return (
        <div className="flex flex-col gap-6">
            <Card>
                <CardHeader>
                    <CardTitle>Alert rules</CardTitle>
                    <CardDescription>
                        Evaluated by the telemetry ingest and the periodic sweep; a match is delivered over the rule&apos;s channel.
                    </CardDescription>
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
                                            {rule.target} {comparatorGlyph(rule.target, rule.comparator)} {rule.threshold}
                                            {rule.windowMinutes ? ` / ${String(rule.windowMinutes)}m` : ""}
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
                        {isMetric ? (
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
                        <Field htmlFor="alert-threshold" label="Threshold">
                            <Input
                                className="font-mono tabular-nums"
                                id="alert-threshold"
                                min={isMetric ? 0 : 1}
                                onChange={(event) => {
                                    setThreshold(event.target.value);
                                }}
                                type="number"
                                value={threshold}
                            />
                        </Field>
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

            <Card>
                <CardHeader>
                    <CardTitle>Recent alerts</CardTitle>
                </CardHeader>
                <CardContent>
                    <AsyncList
                        empty="No alerts fired yet."
                        render={(rows) => (
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead className={COLUMN_LABEL}>When</TableHead>
                                        <TableHead className={COLUMN_LABEL}>Alert</TableHead>
                                        <TableHead className={COLUMN_LABEL}>Channel</TableHead>
                                        <TableHead className={COLUMN_LABEL}>Status</TableHead>
                                    </TableRow>
                                </TableHeader>
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
        </div>
    );
};
