import type { ReturnOf } from "@lunora/client";
import { useMutation, usePreloadedQuery } from "@lunora/react";
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
import { COLUMN_LABEL, Field, FieldForm, FormError, StatusBadge } from "./section-ui";
import type { SectionProps } from "./tabs";

const KEY_TYPES = ["production", "preview", "dev"] as const;

type KeyType = (typeof KEY_TYPES)[number];

/**
 * Deploy-keys tab. Keys are stored hashed server-side, so the plaintext secret
 * is shown exactly once — right after `deploy_keys.issue` returns it — and never
 * again. Revoked keys stay listed (with their `revokedAt`) for the audit trail.
 *
 * Hierarchy: the screen has no headline number, so its one moment is the reveal —
 * a freshly minted key gets the only tinted, bordered block on the page, with the
 * secret itself at mono body size and a `SHOWN ONCE` label in the mono label
 * voice above it. The key list is the secondary layer (name in sans, the two
 * chips carrying type and lifecycle), and the timestamps are tertiary: mono,
 * muted, fixed-width. Revocation state colours the chip, never the row.
 */
export const DeployKeysSection = ({ organizationId, preloaded }: SectionProps<ReturnOf<typeof api.deploy_keys.list>>): ReactElement => {
    const keys = usePreloadedQuery(preloaded);
    const issueKey = useMutation(api.deploy_keys.issue);
    const revokeKey = useMutation(api.deploy_keys.revoke);

    const [name, setName] = useState("");
    const [type, setType] = useState<KeyType>("production");
    const [issued, setIssued] = useState<null | string>(null);
    const [error, setError] = useState<null | string>(null);

    return (
        <div className="flex flex-col gap-6">
            <Card>
                <CardHeader>
                    <CardTitle>Deploy keys</CardTitle>
                    <CardDescription>Revoked keys stay listed for the audit trail — a revoked key fails verification immediately.</CardDescription>
                </CardHeader>
                <CardContent>
                    <AsyncList
                        empty="No deploy keys yet."
                        render={(rows) => (
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead className={COLUMN_LABEL}>Name</TableHead>
                                        <TableHead className={COLUMN_LABEL}>Type</TableHead>
                                        <TableHead className={COLUMN_LABEL}>Status</TableHead>
                                        <TableHead className={COLUMN_LABEL}>Created</TableHead>
                                        <TableHead className={cn(COLUMN_LABEL, "sr-only")}>Actions</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {rows.map((key) => (
                                        <TableRow key={key._id}>
                                            <TableCell className="text-sm font-medium">{key.name}</TableCell>
                                            <TableCell>
                                                <StatusBadge>{key.type}</StatusBadge>
                                            </TableCell>
                                            <TableCell>
                                                <StatusBadge tone={key.revokedAt == null ? "success" : "danger"}>
                                                    {key.revokedAt == null ? "active" : "revoked"}
                                                </StatusBadge>
                                            </TableCell>
                                            <TableCell className="text-muted-foreground font-mono text-xs tabular-nums">
                                                {formatDateTime(key.createdAt)}
                                            </TableCell>
                                            <TableCell className="text-end">
                                                {key.revokedAt == null ? (
                                                    <Button
                                                        className="text-destructive hover:text-destructive"
                                                        onClick={() => {
                                                            void revokeKey.mutate({ id: key._id, organizationId });
                                                        }}
                                                        size="sm"
                                                        variant="ghost"
                                                    >
                                                        Revoke
                                                    </Button>
                                                ) : null}
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        )}
                        rows={keys}
                    />
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Issue key</CardTitle>
                    <CardDescription>Only the hash is stored, so the plaintext key is shown once and is never recoverable afterwards.</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-6">
                    {issued ? (
                        <div className="border-warning/40 flex flex-col items-start gap-3 border p-4">
                            <span className={cn(COLUMN_LABEL, "text-warning")}>Shown once — copy this key now</span>
                            <code className="font-mono text-sm leading-relaxed break-all">{issued}</code>
                            <Button
                                onClick={() => {
                                    setIssued(null);
                                }}
                                size="sm"
                                variant="ghost"
                            >
                                Dismiss
                            </Button>
                        </div>
                    ) : null}

                    <FieldForm
                        action={() => {
                            setError(null);

                            void (async () => {
                                try {
                                    const result = await issueKey.mutate({ name, organizationId, type });

                                    setIssued(result.key);
                                    setName("");
                                } catch (error_: unknown) {
                                    setError(error_ instanceof Error ? error_.message : "issue failed");
                                }
                            })();
                        }}
                    >
                        <Field htmlFor="deploy-key-name" label="Name">
                            <Input
                                id="deploy-key-name"
                                onChange={(event) => {
                                    setName(event.target.value);
                                }}
                                placeholder="CI production"
                                required
                                value={name}
                            />
                        </Field>
                        <Field htmlFor="deploy-key-type" label="Type">
                            <Select
                                onValueChange={(value) => {
                                    setType(value ?? "production");
                                }}
                                value={type}
                            >
                                <SelectTrigger className="w-full" id="deploy-key-type">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectGroup>
                                        {KEY_TYPES.map((value) => (
                                            <SelectItem key={value} value={value}>
                                                {value}
                                            </SelectItem>
                                        ))}
                                    </SelectGroup>
                                </SelectContent>
                            </Select>
                        </Field>
                        <Button className="justify-self-start" disabled={issueKey.pending} type="submit">
                            {issueKey.pending ? "Issuing…" : "Issue"}
                        </Button>
                        <FormError message={error} />
                    </FieldForm>
                </CardContent>
            </Card>
        </div>
    );
};
