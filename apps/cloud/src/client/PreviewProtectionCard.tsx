import { useMutation } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

import { api } from "../../lunora/_generated/api.js";
import { Field, FormError, StatusBadge } from "./section-ui";
import type { OrgId, ProjectId } from "./types";

/**
 * Deployment protection for a project's preview deployments.
 *
 * A preview URL is publicly addressable the moment it exists — that is what
 * makes it shareable, and also what serves unreleased work to anyone forwarded
 * the link. Setting a password puts a gate in front of every preview for this
 * project; production is never gated, because it is public by definition and a
 * switch that could take it down would be a foot-gun with no undo.
 *
 * The password is shown once, here, and then only its salted hash is stored — so
 * a forgotten password is replaced rather than recovered, the same posture as a
 * deploy key.
 */
export const PreviewProtectionCard = ({
    organizationId,
    projectId,
    protectedNow,
}: {
    organizationId: OrgId;
    projectId: ProjectId;
    /** Whether a password is currently set, from `projects.listByOrg`. */
    protectedNow: boolean;
}): ReactElement => {
    const setProtection = useMutation(api.projects.setPreviewProtection);
    const [password, setPassword] = useState("");
    const [error, setError] = useState<null | string>(null);

    const apply = (next: null | string): void => {
        setError(null);

        void (async () => {
            try {
                await setProtection.mutate({ id: projectId, organizationId, password: next });
                setPassword("");
            } catch (error_: unknown) {
                setError(error_ instanceof Error ? error_.message : "could not update protection");
            }
        })();
    };

    const idleLabel = protectedNow ? "Replace" : "Enable";
    const submitLabel = setProtection.pending ? "Saving…" : idleLabel;

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    Preview protection
                    <StatusBadge tone={protectedNow ? "success" : "neutral"}>{protectedNow ? "on" : "off"}</StatusBadge>
                </CardTitle>
                <CardDescription>
                    Preview deployments are reachable by anyone with the link. A password puts a prompt in front of them. Production is never gated.
                </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
                <form
                    className="flex flex-col gap-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        apply(password);
                    }}
                >
                    <Field htmlFor="preview-password" label={protectedNow ? "Replace password" : "Set password"}>
                        <Input
                            autoComplete="new-password"
                            id="preview-password"
                            minLength={8}
                            onChange={(event) => {
                                setPassword(event.target.value);
                            }}
                            placeholder="at least 8 characters"
                            required
                            type="password"
                            value={password}
                        />
                    </Field>
                    <FormError message={error} />
                    <div className="flex flex-wrap gap-2">
                        <Button className="justify-self-start" disabled={setProtection.pending} type="submit">
                            {submitLabel}
                        </Button>
                        {protectedNow ? (
                            <Button
                                className="text-destructive hover:text-destructive"
                                disabled={setProtection.pending}
                                onClick={() => {
                                    apply(null);
                                }}
                                type="button"
                                variant="ghost"
                            >
                                Remove protection
                            </Button>
                        ) : null}
                    </div>
                </form>
                <p className="text-muted-foreground text-xs">
                    Only the hash is stored, so a forgotten password is replaced rather than recovered. Changes take up to a minute to reach every edge.
                </p>
            </CardContent>
        </Card>
    );
};
