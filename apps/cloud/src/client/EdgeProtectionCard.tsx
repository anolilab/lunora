import type { ReturnOf } from "@lunora/client";
import { useLunora, useMutation, useQuery } from "@lunora/react";
import { ClientOnly } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";

import { api } from "../../lunora/_generated/api.js";
import { ColumnHeader } from "./ColumnHeader";
import { Field, FieldForm, FormError, StatusBadge } from "./section-ui";
import type { OrgId } from "./types";

type FirewallView = ReturnOf<typeof api.edge.firewall>;
type EdgeRule = ReturnOf<typeof api.edge.rules>[number];
type Sensitivity = "default" | "low" | "medium";

const STATUS_TONE = { applied: "success", failed: "danger", pending: "warning", removed: "neutral", unavailable: "neutral" } as const;

/** `edge.firewall` for the last day; an action, so fetched once per org. */
const useFirewall = (organizationId: OrgId): { error?: string; view?: FirewallView } => {
    const client = useLunora();
    const [state, setState] = useState<{ error?: string; view?: FirewallView }>({});

    useEffect(() => {
        let cancelled = false;

        void (async () => {
            try {
                const view = await client.action(api.edge.firewall, { organizationId });

                if (!cancelled) {
                    setState({ view });
                }
            } catch (error: unknown) {
                if (!cancelled) {
                    setState({ error: error instanceof Error ? error.message : "failed to load firewall events" });
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [client, organizationId]);

    return state;
};

/** A rule's state in words: what the reconciler last did with it. */
const RuleStatus = ({ rule }: { rule: EdgeRule | undefined }): ReactElement | null =>
    rule ? (
        <span className="text-muted-foreground flex items-center gap-2 text-xs">
            <StatusBadge tone={STATUS_TONE[rule.status]}>{rule.status}</StatusBadge>
            {rule.lastError ?? (rule.applied ? `${String(rule.hostnames.length)} hostnames` : "")}
        </span>
    ) : null;

/**
 * Edge protection (plan 365 W7): what Cloudflare's edge blocked or challenged on
 * the org's hostnames, and the two settings it controls there — the HTTP DDoS
 * sensitivity, and the anomaly → rate-limit action. Projects not served from the
 * platform zone (customer boxes, the customer's own Cloudflare account) are
 * named, because nothing here covers them.
 */
export const EdgeProtectionCard = ({ organizationId }: { organizationId: OrgId }): ReactElement => {
    const { error, view } = useFirewall(organizationId);
    const rules = useQuery(api.edge.rules, { organizationId });
    const setSensitivity = useMutation(api.edge.setDdosSensitivity);
    const setRateLimit = useMutation(api.edge.setAnomalyRateLimit);
    const ddos = rules?.find((rule) => rule.kind === "ddos_l7");
    const limit = rules?.find((rule) => rule.kind === "rate_limit");
    const [requests, setRequests] = useState("600");
    const [formError, setFormError] = useState<null | string>(null);

    return (
        <Card>
            <CardHeader>
                <CardTitle>Edge protection</CardTitle>
                <CardDescription>
                    Every request is behind Cloudflare&apos;s always-on L3/L4/L7 DDoS protection. Below: what the edge blocked or challenged in the last 24
                    hours, and how it responds to this organization&apos;s traffic.
                </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
                <ClientOnly fallback={<p className="text-muted-foreground text-sm">Loading firewall events…</p>}>
                    {error ? <p className="text-muted-foreground text-sm">{error}</p> : null}
                    {view?.status === "ok" ? null : <p className="text-muted-foreground text-sm">{view?.reason}</p>}
                    {view && view.unsupported.length > 0 ? (
                        <p className="text-muted-foreground text-sm">
                            Not covered here: {view.unsupported.map((project) => `${project.name} (${project.reason})`).join("; ")}.
                        </p>
                    ) : null}
                    {view?.status === "ok" && view.events.length === 0 ? (
                        <p className="text-muted-foreground text-sm">No firewall events on {String(view.hostnames)} hostnames in the last 24 hours.</p>
                    ) : null}
                    {view?.status === "ok" && view.events.length > 0 ? (
                        <Table>
                            <ColumnHeader labels={["When", "Action", "Host", "Path", "Source"]} />
                            <TableBody>
                                {view.events.map((event, index) => (
                                    <TableRow key={`${event.datetime}-${String(index)}`}>
                                        <TableCell className="font-mono text-xs">{event.datetime}</TableCell>
                                        <TableCell>{event.action}</TableCell>
                                        <TableCell className="font-mono text-xs">{event.host}</TableCell>
                                        <TableCell className="max-w-[16rem] truncate font-mono text-xs">{event.path}</TableCell>
                                        <TableCell className="text-muted-foreground text-xs">{event.source}</TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    ) : null}
                </ClientOnly>

                <Field htmlFor="ddos-sensitivity" label="HTTP DDoS sensitivity">
                    <Select
                        disabled={view?.capabilities.ddosOverride !== true}
                        onValueChange={(value: unknown) => {
                            void setSensitivity.mutate({ organizationId, sensitivity: value as Sensitivity });
                        }}
                        value={ddos?.sensitivity ?? "default"}
                    >
                        <SelectTrigger className="w-[200px]" id="ddos-sensitivity">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectGroup>
                                <SelectItem value="default">Default (high)</SelectItem>
                                <SelectItem value="medium">Medium</SelectItem>
                                <SelectItem value="low">Low</SelectItem>
                            </SelectGroup>
                        </SelectContent>
                    </Select>
                </Field>
                {view?.capabilities.ddosOverride === false ? <p className="text-muted-foreground text-xs">Not enabled on this cell.</p> : null}
                <RuleStatus rule={ddos} />

                <FieldForm
                    action={() => {
                        setFormError(null);

                        const run = async (): Promise<void> => {
                            await setRateLimit.mutate(
                                limit?.armed === true
                                    ? { enabled: false, organizationId }
                                    : { enabled: true, organizationId, requestsPerPeriod: Number(requests) },
                            );
                        };

                        void run().catch((error_: unknown) => {
                            setFormError(error_ instanceof Error ? error_.message : "could not save");
                        });
                    }}
                    className="max-w-2xl sm:grid-cols-2"
                >
                    <Field htmlFor="anomaly-rate-limit" label="Rate limit per IP during a usage anomaly (requests / minute)">
                        <Input
                            className="font-mono tabular-nums"
                            disabled={limit?.armed === true || view?.capabilities.rateLimit !== true}
                            id="anomaly-rate-limit"
                            min={10}
                            onChange={(event) => {
                                setRequests(event.target.value);
                            }}
                            type="number"
                            value={limit?.armed === true ? String(limit.requestsPerPeriod ?? requests) : requests}
                        />
                    </Field>
                    <div className="grid gap-2 sm:col-span-2">
                        <Button className="justify-self-start" disabled={view?.capabilities.rateLimit !== true} type="submit" variant="outline">
                            {limit?.armed === true ? "Disarm" : "Arm"}
                        </Button>
                        {view?.capabilities.rateLimit === false ? <p className="text-muted-foreground text-xs">Not enabled on this cell.</p> : null}
                        <RuleStatus rule={limit} />
                        <FormError message={formError} />
                    </div>
                </FieldForm>
            </CardContent>
        </Card>
    );
};
