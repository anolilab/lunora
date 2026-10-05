import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

import type { CloudflareAccountView } from "./cloudflare-accounts";
import { describeConnectError, TOKEN_PERMISSIONS } from "./cloudflare-accounts";
import { Field, FieldForm, FormError } from "./section-ui";
import type { OrgId } from "./types";

/** Deadline for the connect route, which checks the token against Cloudflare before storing it. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Connect (or, with `id`, rotate) through `POST /v1/cloudflare-accounts`: the
 * edge checks the token against the account and seals it before anything is
 * stored, so the browser never holds the key that opens it.
 */
const requestConnect = async (body: { accountId: string; id?: string; label: string; organizationId: OrgId; token: string }): Promise<void> => {
    // react-doctor-disable-next-line react-doctor/no-fetch-response-used-without-status-check -- `response.ok` IS checked, just after the body is read: reading first is what lets the server's own error message surface instead of a bare status code.
    const response = await fetch("/v1/cloudflare-accounts", {
        body: JSON.stringify(body),
        credentials: "include",
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;

    if (!response.ok) {
        throw new Error(describeConnectError(payload?.error ?? `connect failed (${String(response.status)})`));
    }
};

interface ConnectCloudflareAccountDialogProps {
    onClose: () => void;
    organizationId: OrgId;
    /** The connection whose token is being rotated; absent to connect a new account. */
    rotating?: CloudflareAccountView;
}

/**
 * Paste a Cloudflare account id and a scoped API token. Lists the exact token
 * permissions first, so the token is created least-privilege rather than with
 * a broad template. Rotating keeps the account fixed: a token for another
 * account cannot replace a connection whose projects live in this one.
 * Mounted while open, so the fields start empty every time.
 */
export const ConnectCloudflareAccountDialog = ({ onClose, organizationId, rotating }: ConnectCloudflareAccountDialogProps): ReactElement => {
    const [accountId, setAccountId] = useState(rotating?.accountId ?? "");
    const [label, setLabel] = useState(rotating?.label ?? "");
    const [token, setToken] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<null | string>(null);
    const submitLabel = rotating ? "Rotate token" : "Connect";

    return (
        <Dialog
            onOpenChange={(next) => {
                if (!next) {
                    onClose();
                }
            }}
            open
        >
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>{rotating ? `Rotate the token for ${rotating.label}` : "Connect a Cloudflare account"}</DialogTitle>
                    <DialogDescription>
                        Create an account API token in your Cloudflare dashboard (My Profile → API Tokens, or the account&apos;s own API Tokens), scoped to this
                        account only, with:
                    </DialogDescription>
                </DialogHeader>
                <ul className="m-0 grid list-disc gap-1 pl-5 text-sm">
                    {TOKEN_PERMISSIONS.map((permission) => (
                        <li key={permission.id}>
                            <span className="font-mono text-xs">{permission.label}</span>{" "}
                            <span className="text-muted-foreground">
                                — {permission.required ? "required" : "when your app needs it"}: {permission.use}
                            </span>
                        </li>
                    ))}
                </ul>
                <p className="m-0 text-xs text-muted-foreground">
                    Lunora Cloud checks the token against the account before saving it, encrypts it at the edge, and never shows it again.
                </p>
                <FieldForm
                    action={() => {
                        setError(null);
                        setPending(true);

                        void requestConnect({
                            accountId: accountId.trim(),
                            ...(rotating ? { id: rotating._id } : {}),
                            label,
                            organizationId,
                            token: token.trim(),
                        })
                            .then(() => {
                                setPending(false);
                                onClose();

                                return undefined;
                            })
                            .catch((error_: unknown) => {
                                setPending(false);
                                setError(error_ instanceof Error ? error_.message : "connect failed");
                            });
                    }}
                    className="max-w-none"
                >
                    <Field htmlFor="cf-connect-account" label="Cloudflare account ID">
                        <Input
                            autoComplete="off"
                            disabled={rotating !== undefined}
                            id="cf-connect-account"
                            onChange={(event) => {
                                setAccountId(event.target.value);
                            }}
                            placeholder="32-character account ID"
                            required
                            value={accountId}
                        />
                    </Field>
                    <Field htmlFor="cf-connect-label" label="Name (optional)">
                        <Input
                            id="cf-connect-label"
                            maxLength={128}
                            onChange={(event) => {
                                setLabel(event.target.value);
                            }}
                            placeholder="production"
                            value={label}
                        />
                    </Field>
                    <Field htmlFor="cf-connect-token" label="API token">
                        <Input
                            autoComplete="off"
                            id="cf-connect-token"
                            onChange={(event) => {
                                setToken(event.target.value);
                            }}
                            required
                            type="password"
                            value={token}
                        />
                    </Field>
                    <Button className="justify-self-start" disabled={pending} type="submit">
                        {pending ? "Checking the token…" : submitLabel}
                    </Button>
                    <FormError message={error} />
                </FieldForm>
            </DialogContent>
        </Dialog>
    );
};
