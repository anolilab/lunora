import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { COLUMN_LABEL } from "@/lib/typography";
import { cn } from "@/lib/utils";

import { AuthUIProvider } from "../../lunora/auth-ui/react/provider";
import { DeleteAccountCard } from "../../lunora/auth-ui/react/settings-cards";
import { accountExportErrorMessage, accountExportFilename } from "./account-export";
import { authClient } from "./auth-client";
import { FormError } from "./section-ui";

/** Upper bound on the export request, so a wedged route can't leave the button pending. */
const REQUEST_TIMEOUT_MS = 30_000;

/** After a deletion, land on sign-in rather than bouncing through the session gate at `/`. */
const DELETE_REDIRECTS = { afterSignOut: "/login" };

/**
 * Fetch the signed-in caller's export and hand it to the browser as a file download.
 * Resolves to the message to show when that fails, or `null` when the download started.
 */
const downloadAccountExport = async (): Promise<null | string> => {
    try {
        const response = await fetch("/v1/account/export", { credentials: "include", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        const body = await response.text();

        if (!response.ok) {
            return accountExportErrorMessage(response.status, body);
        }

        const url = URL.createObjectURL(new Blob([body], { type: "application/json" }));
        const link = document.createElement("a");

        link.href = url;
        link.download = accountExportFilename(new Date());
        link.click();
        URL.revokeObjectURL(url);

        return null;
    } catch (error: unknown) {
        return error instanceof Error ? error.message : "could not export your data";
    }
};

/** Offers the profile, memberships and audit entries the platform holds about you as a JSON download. */
const ExportDataCard = (): ReactElement => {
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<null | string>(null);

    const exportData = (): void => {
        setError(null);
        setPending(true);

        void (async () => {
            setError(await downloadAccountExport());
            setPending(false);
        })();
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle>Export your data</CardTitle>
                <CardDescription>Download your profile, organization memberships and audit entries as JSON.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
                <Button className="justify-self-start" disabled={pending} onClick={exportData} type="button" variant="outline">
                    {pending ? "Exporting…" : "Export my data"}
                </Button>
                <FormError message={error} />
            </CardContent>
        </Card>
    );
};

/**
 * The auth UI's delete-account card, confirmed with the current password.
 *
 * A refusal — the server will not delete the only owner of an organization —
 * comes back as the auth error's message, which the card shows in its banner.
 * After a deletion the full-page redirect to `/login` drops every cached query
 * that belonged to the account.
 */
const DeleteAccountPanel = (): ReactElement => (
    <AuthUIProvider authClient={authClient} redirects={DELETE_REDIRECTS}>
        <DeleteAccountCard />
    </AuthUIProvider>
);

/** Account-level actions on the signed-in landing page: export your data, delete your account. */
export const AccountSection = (): ReactElement => (
    <section aria-labelledby="account-heading" className="grid gap-4">
        <h2 className={cn(COLUMN_LABEL, "text-muted-foreground")} id="account-heading">
            Account
        </h2>
        <ExportDataCard />
        <DeleteAccountPanel />
    </section>
);
