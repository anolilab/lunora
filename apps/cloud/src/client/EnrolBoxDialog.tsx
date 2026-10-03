import { useAction } from "@lunora/react";
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

/** The install command and its one-time token, once minted. */
interface Enrolment {
    expiresAt: number;
    installCommand: string;
    token: string;
}

/**
 * Enrol a box: name it, mint a one-time token (`boxes.createEnrolment`), and show
 * the install command and, separately, the token install.sh asks for. The token
 * stays off the command so it never lands in shell history or `sudo`'s logged
 * argv; it is pasted at install.sh's hidden prompt. The server keeps only its
 * hash, so this is the only time it can be shown — the copy says so, and closing
 * the dialog drops it. Remount with a fresh `key` per open so a previous token
 * never reappears.
 */
export const EnrolBoxDialog = ({ onOpenChange, open, organizationId }: EnrolBoxDialogProps): ReactElement => {
    const { call: createEnrolment, pending } = useAction(api.boxes.createEnrolment);
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
                        <CopyButton label="Copy command" value={enrolment.installCommand} />
                        <p className="m-0 text-sm">It asks for this enrolment token, and then your bucket&apos;s access key — paste each when prompted:</p>
                        <pre className="m-0 overflow-x-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
                            <code>{enrolment.token}</code>
                        </pre>
                        <div className="flex flex-wrap items-center gap-3">
                            <CopyButton label="Copy token" value={enrolment.token} />
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
                                    const result = await createEnrolment({ name, organizationId });

                                    setEnrolment({ expiresAt: result.expiresAt, installCommand: result.installCommand, token: result.token });
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
                        <Button className="justify-self-start" disabled={pending || name.trim() === ""} type="submit">
                            {pending ? "Creating…" : "Create install command"}
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
