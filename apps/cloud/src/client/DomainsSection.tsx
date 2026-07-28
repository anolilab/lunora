import type { ReturnOf } from "@lunora/client";
import { useMutation, usePreloadedQuery, useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { api } from "../../lunora/_generated/api.js";
import { AsyncList } from "./AsyncList";
import { COLUMN_LABEL, Field, FieldForm, FormError, Row, RowActions, RowList, StatusBadge } from "./section-ui";
import type { SectionProps } from "./tabs";
import type { ProjectId } from "./types";

interface TxtRecord {
    txtName: string;
    txtToken: string;
}

/**
 * Domains tab (GAPS.md B1). Add a hostname to a project (the response carries
 * the `_lunora.&lt;host>` TXT record to create), then verify — the edge route
 * runs the DNS checks and records the outcome; the list is live, so the
 * verified badge flips on its own. Removing is a direct mutation.
 *
 * Hierarchy: the HOSTNAME is what this screen exists to show, so it is the one
 * value rendered at size and in mono — an address is data, and data is the
 * visual. The verified/pending chip is the only tinted thing on a row and it
 * tints the value, never the row; redirect target and actions stay tertiary.
 * The TXT record panel is deliberately the loudest thing on the page while it
 * is up, because it is a one-shot instruction the operator must copy.
 */
/** Deadline for the two edge-route calls below; a hung route must not wedge the UI. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The one-shot DNS instruction shown after a hostname is added. A bordered panel
 * on a surface step rather than a card — it is transient chrome inside the add
 * form, not a section of its own. Name and token are mono because they are
 * literals to be copied verbatim.
 */
const TxtRecordPanel = ({ onDismiss, record }: { onDismiss: () => void; record: TxtRecord }): ReactElement => (
    <div className="flex flex-col gap-3 border border-border bg-muted/30 p-4">
        <div className="flex items-start justify-between gap-3">
            <span className={`${COLUMN_LABEL} text-muted-foreground`}>DNS TXT record</span>
            <Button className="-my-1" onClick={onDismiss} size="xs" variant="ghost">
                Dismiss
            </Button>
        </div>
        <p className="m-0 text-sm text-muted-foreground">Create this TXT record at your DNS provider, then hit Verify.</p>
        <div className="grid gap-2">
            <div className="grid gap-0.5">
                <span className={`${COLUMN_LABEL} text-muted-foreground`}>Name</span>
                <code className="font-mono text-sm break-all">{record.txtName}</code>
            </div>
            <div className="grid gap-0.5">
                <span className={`${COLUMN_LABEL} text-muted-foreground`}>Value</span>
                <code className="font-mono text-sm break-all">{record.txtToken}</code>
            </div>
        </div>
    </div>
);

export const DomainsSection = ({ organizationId, preloaded }: SectionProps<ReturnOf<typeof api.projects.listByOrg>>): ReactElement => {
    const projects = usePreloadedQuery(preloaded);
    // Plain `string`, not `ProjectId | ""`: Base UI's Select is generic over its value
    // and a branded union makes that inference collapse to the empty-string literal.
    // The brand is reapplied at the query boundary, which is where it means something.
    const [projectId, setProjectId] = useState("");
    const domains = useQuery(api.domains.list, projectId ? { organizationId, projectId: projectId as ProjectId } : "skip");
    const removeDomain = useMutation(api.domains.remove);

    const [hostname, setHostname] = useState("");
    const [txtRecord, setTxtRecord] = useState<TxtRecord | null>(null);
    const [pending, setPending] = useState(false);
    const [verifying, setVerifying] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const verify = (id: string): void => {
        setError(null);
        setVerifying(id);

        const run = async (): Promise<void> => {
            const response = await fetch("/v1/domains/verify", {
                body: JSON.stringify({ id, organizationId }),
                credentials: "include",
                headers: { "content-type": "application/json" },
                method: "POST",
                // Without a deadline a wedged edge route leaves the row spinning forever
                // with no way back except a reload.
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            const payload = (await response.json().catch(() => null)) as { txtOk?: boolean; verified?: boolean } | null;

            if (!response.ok) {
                setError((payload as { error?: string } | null)?.error ?? `verify failed (${String(response.status)})`);
            } else if (!payload?.verified) {
                setError(
                    payload?.txtOk ? "TXT ok — but the hostname does not point at the platform yet" : "TXT record not found yet — DNS may still be propagating",
                );
            }
        };

        void run()
            .catch((error_: unknown) => {
                setError(error_ instanceof Error ? error_.message : "verify failed");
            })
            .finally(() => {
                setVerifying(null);
            });
    };

    return (
        <div className="flex flex-col gap-6">
            <Card>
                <CardHeader>
                    <CardTitle>Custom domains</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-6">
                    <Field htmlFor="domain-project" label="Project">
                        <Select
                            onValueChange={(value) => {
                                setProjectId(value ?? "");
                            }}
                            value={projectId}
                        >
                            <SelectTrigger className="w-full sm:w-80" id="domain-project">
                                <SelectValue placeholder="Select a project…" />
                            </SelectTrigger>
                            <SelectContent>
                                {(projects ?? []).map((project) => (
                                    <SelectItem key={project._id} value={project._id}>
                                        {project.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </Field>

                    {projectId ? (
                        <AsyncList
                            empty="No custom domains for this project."
                            render={(rows) => (
                                <RowList>
                                    {rows.map((domain) => (
                                        <Row key={domain._id}>
                                            {/* The one value shown at size: the hostname is what this screen answers. */}
                                            <span className="shrink-0 font-mono text-base">{domain.hostname}</span>
                                            {domain.redirectTo ? (
                                                <span className="text-muted-foreground truncate font-mono text-xs">→ {domain.redirectTo}</span>
                                            ) : null}
                                            <StatusBadge tone={domain.verifiedAt ? "success" : "warning"}>
                                                {domain.verifiedAt ? "verified" : "pending"}
                                            </StatusBadge>
                                            <RowActions>
                                                {domain.verifiedAt ? null : (
                                                    <Button
                                                        disabled={verifying === domain._id}
                                                        onClick={() => {
                                                            verify(domain._id);
                                                        }}
                                                        size="sm"
                                                        variant="ghost"
                                                    >
                                                        {verifying === domain._id ? "Verifying…" : "Verify"}
                                                    </Button>
                                                )}
                                                <Button
                                                    className="text-destructive hover:text-destructive"
                                                    onClick={() => {
                                                        void removeDomain.mutate({ id: domain._id, organizationId });
                                                    }}
                                                    size="sm"
                                                    variant="ghost"
                                                >
                                                    Remove
                                                </Button>
                                            </RowActions>
                                        </Row>
                                    ))}
                                </RowList>
                            )}
                            rows={domains}
                        />
                    ) : null}
                </CardContent>
            </Card>

            {projectId ? (
                <Card>
                    <CardHeader>
                        <CardTitle>Add domain</CardTitle>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-4">
                        {txtRecord ? (
                            <TxtRecordPanel
                                onDismiss={() => {
                                    setTxtRecord(null);
                                }}
                                record={txtRecord}
                            />
                        ) : null}
                        <FieldForm
                            action={() => {
                                setError(null);
                                setPending(true);

                                const add = async (): Promise<void> => {
                                    const response = await fetch("/v1/domains", {
                                        body: JSON.stringify({ hostname, organizationId, projectId }),
                                        credentials: "include",
                                        headers: { "content-type": "application/json" },
                                        method: "POST",
                                        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                                    });

                                    if (!response.ok) {
                                        const payload = (await response.json().catch(() => null)) as { error?: string } | null;

                                        setError(payload?.error ?? `add failed (${String(response.status)})`);

                                        return;
                                    }

                                    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- Response.json() is `unknown` under workers-types; tsc requires the assertion
                                    const record = (await response.json()) as TxtRecord;

                                    setTxtRecord(record);
                                    setHostname("");
                                };

                                void add()
                                    .catch((error_: unknown) => {
                                        setError(error_ instanceof Error ? error_.message : "add failed");
                                    })
                                    .finally(() => {
                                        setPending(false);
                                    });
                            }}
                        >
                            <Field htmlFor="domain-hostname" label="Hostname">
                                <Input
                                    id="domain-hostname"
                                    onChange={(event) => {
                                        setHostname(event.target.value);
                                    }}
                                    placeholder="app.example.com"
                                    required
                                    value={hostname}
                                />
                            </Field>
                            <Button className="justify-self-start" disabled={pending} type="submit">
                                {pending ? "Adding…" : "Add"}
                            </Button>
                            <FormError message={error} />
                        </FieldForm>
                    </CardContent>
                </Card>
            ) : null}
        </div>
    );
};
