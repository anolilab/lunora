import { GithubIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReturnOf } from "@lunora/client";
import { useMutation, usePreloadedQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { api } from "../../lunora/_generated/api.js";
import { formatDateTime } from "./format";
import { FormError, Row, RowActions, RowList, StatusBadge } from "./section-ui";
import type { SectionProps } from "./tabs";

/**
 * The organization's connected integrations — today, its GitHub App
 * installations.
 *
 * This exists because `claim` had no inverse anywhere a user could reach. An
 * installation linked to the wrong organization — a plausible mistake, since
 * claiming is one click on an id the operator does not choose — could only be
 * undone by uninstalling the App from GitHub entirely, which detaches every
 * OTHER organization legitimately using it.
 *
 * Releasing marks the installation unclaimed rather than deleting it, so the
 * right organization can still claim it without a reinstall.
 */
export const IntegrationsSection = ({ organizationId, preloaded }: SectionProps<ReturnOf<typeof api.github_installations.list>>): ReactElement => {
    const installations = usePreloadedQuery(preloaded);
    const unclaim = useMutation(api.github_installations.unclaim);
    const [error, setError] = useState<null | string>(null);

    const release = (installationId: number): void => {
        setError(null);

        void (async () => {
            try {
                await unclaim.mutate({ installationId, organizationId });
            } catch (error_: unknown) {
                setError(error_ instanceof Error ? error_.message : "could not release this installation");
            }
        })();
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle>Integrations</CardTitle>
                <CardDescription>GitHub App installations connected to this organization. Push-to-deploy only trusts a claimed installation.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
                <FormError message={error} />
                {installations.length === 0 ? (
                    <p className="py-8 text-center text-sm text-muted-foreground">
                        No installations connected. Install the Lunora GitHub App on your account, then claim it here.
                    </p>
                ) : (
                    <RowList>
                        {installations.map((installation) => (
                            <li key={installation._id}>
                                <Row>
                                    <HugeiconsIcon className="size-4 shrink-0 text-muted-foreground" icon={GithubIcon} strokeWidth={2} />
                                    <span className="font-medium">{installation.accountLogin}</span>
                                    <span className="font-mono text-xs text-muted-foreground">#{installation.installationId}</span>
                                    <StatusBadge tone={installation.claimedAt === undefined ? "neutral" : "success"}>
                                        {installation.claimedAt === undefined ? "unclaimed" : "connected"}
                                    </StatusBadge>
                                    {installation.claimedAt === undefined ? null : (
                                        <span className="text-xs text-muted-foreground">since {formatDateTime(installation.claimedAt)}</span>
                                    )}
                                    <RowActions>
                                        <Button
                                            disabled={unclaim.pending}
                                            onClick={() => {
                                                release(installation.installationId);
                                            }}
                                            size="sm"
                                            type="button"
                                            variant="ghost"
                                        >
                                            Release
                                        </Button>
                                    </RowActions>
                                </Row>
                            </li>
                        ))}
                    </RowList>
                )}
            </CardContent>
        </Card>
    );
};
