import { useMutation } from "@lunora/react";
import { Link } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

import { api } from "../../lunora/_generated/api.js";
import { describeEnrolError } from "./boxes";
import { formatTime } from "./format";
import { CopyButton, Field, FieldForm, FormError } from "./section-ui";
import type { OrgId } from "./types";

interface EnrolBoxDialogProps {
    onOpenChange: (open: boolean) => void;
    open: boolean;
    organizationId: OrgId;
}

/** The one-time command, once minted. */
interface Enrolment {
    expiresAt: number;
    installCommand: string;
}

/**
 * Enrol a box: name it, mint a one-time token (`boxes.createEnrolment`), and show
 * the command that uses it. The command carries the token in plaintext and the
 * server keeps only its hash, so this is the only time it can be shown — the copy
 * says so, and closing the dialog drops it. Remount with a fresh `key` per open so
 * a previous token never reappears.
 */
export const EnrolBoxDialog = ({ onOpenChange, open, organizationId }: EnrolBoxDialogProps): ReactElement => {
    const createEnrolment = useMutation(api.boxes.createEnrolment);
    const [name, setName] = useState("");
    const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
    const [error, setError] = useState<{ message: string; quota: boolean } | null>(null);

    return (
        <Dialog onOpenChange={onOpenChange} open={open}>
            <DialogContent className="sm:max-w-xl">
                <DialogHeader>
                    <DialogTitle>Enrol a box</DialogTitle>
                    <DialogDescription>
                        A box is a Linux server you run. Lunora Cloud deploys your apps onto it with celld, through an agent (lunora-hostd) that dials out to us
                        — no inbound port for the control plane, and your data stays in your own bucket.
                    </DialogDescription>
                </DialogHeader>

                {enrolment ? (
                    <div className="grid gap-3">
                        <p className="m-0 text-sm">Run this on the server as root:</p>
                        <pre className="m-0 overflow-x-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
                            <code>{enrolment.installCommand}</code>
                        </pre>
                        <div className="flex flex-wrap items-center gap-3">
                            <CopyButton label="Copy command" value={enrolment.installCommand} />
                            <p className="m-0 text-xs text-muted-foreground">
                                Shown once — the token is not stored and cannot be shown again. It works once and expires in 15 minutes (at{" "}
                                {formatTime(enrolment.expiresAt)} UTC).
                            </p>
                        </div>
                    </div>
                ) : (
                    <FieldForm
                        action={() => {
                            setError(null);

                            void (async () => {
                                try {
                                    const result = await createEnrolment.mutate({ name, organizationId });

                                    setEnrolment({ expiresAt: result.expiresAt, installCommand: result.installCommand });
                                } catch (error_: unknown) {
                                    setError(describeEnrolError(error_ instanceof Error ? error_.message : "could not create the enrolment"));
                                }
                            })();
                        }}
                        className="max-w-none"
                    >
                        <Field htmlFor="box-name" label="Name">
                            <Input
                                autoComplete="off"
                                id="box-name"
                                onChange={(event) => {
                                    setName(event.target.value);
                                }}
                                placeholder="hetzner-fsn1"
                                required
                                value={name}
                            />
                        </Field>
                        <p className="m-0 text-xs text-muted-foreground">
                            For you only. The box&apos;s public hostname uses a random label, so this name never appears in DNS.
                        </p>
                        <Button className="justify-self-start" disabled={createEnrolment.pending || name.trim() === ""} type="submit">
                            {createEnrolment.pending ? "Creating…" : "Create install command"}
                        </Button>
                        <FormError message={error?.message ?? null} />
                        {error?.quota ? (
                            <Link className="text-sm underline-offset-2 hover:underline" params={{ organizationId }} to="/orgs/$organizationId/billing">
                                Open Billing
                            </Link>
                        ) : null}
                    </FieldForm>
                )}

                <DialogFooter>
                    <Button
                        onClick={() => {
                            onOpenChange(false);
                        }}
                        type="button"
                        variant="ghost"
                    >
                        {enrolment ? "Done" : "Cancel"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};
