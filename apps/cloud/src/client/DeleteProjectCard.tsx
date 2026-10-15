import { useMutation } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

import { api } from "../../lunora/_generated/api.js";
import { Field, FormError } from "./section-ui";
import type { OrgId, ProjectId } from "./types";

/**
 * Delete a project and everything scoped to it.
 *
 * Projects could be created and renamed but never removed — the only way out was
 * deleting the whole organization, which is a far larger action than "I made this
 * by mistake" warrants.
 *
 * Type-the-name to confirm, rather than a confirm dialog. This is irreversible
 * and it tears down live deployments, so the cost of an accidental click has to
 * be higher than one keystroke; typing the name also makes it impossible to
 * delete the wrong project from muscle memory on the wrong tab.
 *
 * Lives behind the project drill-in rather than in the project LIST for the same
 * reason: a destructive control in a row is one mis-aimed click from a row you
 * did not mean.
 */
export const DeleteProjectCard = ({
    onDeleted,
    organizationId,
    projectId,
    projectName,
}: {
    /** Navigate away — the project this view is about no longer exists. */
    onDeleted: () => void;
    organizationId: OrgId;
    projectId: ProjectId;
    projectName: string;
}): ReactElement => {
    const remove = useMutation(api.projects.remove);
    const [confirmation, setConfirmation] = useState("");
    const [error, setError] = useState<null | string>(null);

    const confirmed = confirmation.trim() === projectName;

    const submit = (): void => {
        setError(null);

        void (async () => {
            try {
                await remove.mutate({ id: projectId, organizationId });
                onDeleted();
            } catch (error_: unknown) {
                setError(error_ instanceof Error ? error_.message : "could not delete this project");
            }
        })();
    };

    return (
        <Card className="border-destructive/40">
            <CardHeader>
                <CardTitle>Delete project</CardTitle>
                <CardDescription>
                    Removes {projectName} and its deployments, domains, secrets and build history. Live deployments are torn down. This cannot be undone.
                </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
                <Field htmlFor="delete-project-confirm" label={`Type ${projectName} to confirm`}>
                    <Input
                        autoComplete="off"
                        id="delete-project-confirm"
                        onChange={(event) => {
                            setConfirmation(event.target.value);
                        }}
                        placeholder={projectName}
                        value={confirmation}
                    />
                </Field>
                <FormError message={error} />
                <Button className="justify-self-start" disabled={!confirmed || remove.pending} onClick={submit} type="button" variant="destructive">
                    {remove.pending ? "Deleting…" : "Delete this project"}
                </Button>
            </CardContent>
        </Card>
    );
};
