import type { Preloaded, ReturnOf } from "@lunora/client";
import { useMutation, usePreloadedQuery, useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { api } from "../../lunora/_generated/api.js";
import { AsyncList } from "./AsyncList";
import { Field, FieldForm, FormError, Row, RowActions, RowList } from "./section-ui";
import type { OrgId, ProjectId } from "./types";

interface SecretsSectionProps {
    organizationId: OrgId;
    /** SSR-preloaded project picker. The secret list depends on the pick, so it stays live. */
    preloaded: Preloaded<ReturnOf<typeof api.projects.listByOrg>>;
}

/**
 * Secrets tab (§7). Per-project tenant env vars. Setting a secret POSTs to the
 * `/v1/secrets` edge route, which encrypts the value (the master key never
 * reaches the browser) before storing ciphertext; `list` returns names only, and
 * the values are decrypted only at deploy time. Pick a project, then manage its
 * secrets.
 */
export const SecretsSection = ({ organizationId, preloaded }: SecretsSectionProps): ReactElement => {
    const projects = usePreloadedQuery(preloaded);
    const [projectId, setProjectId] = useState<null | ProjectId>(null);
    const secrets = useQuery(api.secrets.list, projectId ? { organizationId, projectId } : "skip");
    const removeSecret = useMutation(api.secrets.remove);

    const [name, setName] = useState("");
    const [value, setValue] = useState("");
    const [environment, setEnvironment] = useState("all");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<null | string>(null);

    return (
        <div className="flex flex-col gap-6">
            <Card>
                <CardHeader>
                    <CardTitle>Secrets</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                    <Field htmlFor="secret-project" label="Project">
                        <Select
                            onValueChange={(newValue) => {
                                setProjectId(newValue as null | ProjectId);
                            }}
                            value={projectId}
                        >
                            <SelectTrigger className="max-w-xs" id="secret-project">
                                <SelectValue placeholder="Select a project…" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectGroup>
                                    {(projects ?? []).map((project) => (
                                        <SelectItem key={project._id} value={project._id}>
                                            {project.name}
                                        </SelectItem>
                                    ))}
                                </SelectGroup>
                            </SelectContent>
                        </Select>
                    </Field>

                    {projectId ? (
                        <AsyncList
                            empty="No secrets for this project."
                            render={(rows) => (
                                <RowList>
                                    {rows.map((secret) => (
                                        <Row key={secret.name}>
                                            <span className="shrink-0 font-medium">{secret.name}</span>
                                            <span className="text-muted-foreground">set {new Date(secret.updatedAt).toLocaleDateString()}</span>
                                            <RowActions>
                                                <Button
                                                    className="text-destructive hover:text-destructive"
                                                    onClick={() => {
                                                        void removeSecret.mutate({ id: secret.id, organizationId });
                                                    }}
                                                    size="sm"
                                                    variant="ghost"
                                                >
                                                    Delete
                                                </Button>
                                            </RowActions>
                                        </Row>
                                    ))}
                                </RowList>
                            )}
                            rows={secrets}
                        />
                    ) : null}
                </CardContent>
            </Card>

            {projectId ? (
                <Card>
                    <CardHeader>
                        <CardTitle>Set secret</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <FieldForm
                            action={() => {
                                setError(null);
                                setPending(true);

                                // Promise combinators instead of try/finally so React
                                // Compiler can memoize the component (it can't lower
                                // try-with-finally or throw-in-try yet).
                                const save = async (): Promise<void> => {
                                    const response = await fetch("/v1/secrets", {
                                        body: JSON.stringify({ environment, name, organizationId, projectId, value }),
                                        credentials: "include",
                                        headers: { "content-type": "application/json" },
                                        method: "POST",
                                    });

                                    if (!response.ok) {
                                        const payload = (await response.json().catch(() => null)) as { error?: string } | null;

                                        setError(payload?.error ?? `set failed (${String(response.status)})`);

                                        return;
                                    }

                                    setName("");
                                    setValue("");
                                };

                                void save()
                                    .catch((error_: unknown) => {
                                        setError(error_ instanceof Error ? error_.message : "set failed");
                                    })
                                    .finally(() => {
                                        setPending(false);
                                    });
                            }}
                        >
                            <Field htmlFor="secret-name" label="Name">
                                <Input
                                    id="secret-name"
                                    onChange={(event) => {
                                        setName(event.target.value);
                                    }}
                                    placeholder="STRIPE_SECRET_KEY"
                                    required
                                    value={name}
                                />
                            </Field>
                            <Field htmlFor="secret-environment" label="Environment">
                                <Select
                                    onValueChange={(newValue) => {
                                        setEnvironment(newValue ?? "all");
                                    }}
                                    value={environment}
                                >
                                    <SelectTrigger id="secret-environment">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectGroup>
                                            <SelectItem value="all">All environments</SelectItem>
                                            <SelectItem value="production">Production</SelectItem>
                                            <SelectItem value="preview">Preview</SelectItem>
                                            <SelectItem value="dev">Dev</SelectItem>
                                        </SelectGroup>
                                    </SelectContent>
                                </Select>
                            </Field>
                            <Field htmlFor="secret-value" label="Value">
                                <Input
                                    id="secret-value"
                                    onChange={(event) => {
                                        setValue(event.target.value);
                                    }}
                                    placeholder="value"
                                    required
                                    type="password"
                                    value={value}
                                />
                            </Field>
                            <Button className="justify-self-start" disabled={pending} type="submit">
                                {pending ? "Saving…" : "Set secret"}
                            </Button>
                            <FormError message={error} />
                        </FieldForm>
                    </CardContent>
                </Card>
            ) : null}
        </div>
    );
};
